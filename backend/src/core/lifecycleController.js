const STATES = Object.freeze({
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
});

const WORK_KINDS = Object.freeze({
  BOOTSTRAP: 'bootstrap',
  LIVE_CYCLE: 'live-cycle',
  REPLAY: 'replay',
});

const SAFE_REQUEST_CLASSES = new Set([
  'health',
  'status',
  'inspector',
  'static',
]);

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_FATAL_TIMEOUT_MS = 1_000;

function noopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    system() {},
  };
}

function normalizeLogger(logger) {
  if (!logger || typeof logger !== 'object') return noopLogger();

  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : () => {},
    system: typeof logger.system === 'function' ? logger.system.bind(logger) : () => {},
  };
}

function defaultAbortControllerFactory() {
  if (typeof AbortController === 'function') return new AbortController();
  return { signal: undefined, abort() {} };
}

function createLifecycleController(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('lifecycle options must be a non-array object');
  }

  const logger = normalizeLogger(options.logger);
  const processRef = options.processRef || process;
  const timers = {
    setInterval: options.timers?.setInterval || setInterval,
    clearInterval: options.timers?.clearInterval || clearInterval,
    setTimeout: options.timers?.setTimeout || setTimeout,
    clearTimeout: options.timers?.clearTimeout || clearTimeout,
  };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const createAbortController = typeof options.abortControllerFactory === 'function'
    ? options.abortControllerFactory
    : defaultAbortControllerFactory;
  const forceExit = typeof options.forceExit === 'function'
    ? options.forceExit
    : code => {
      if (typeof processRef.exit === 'function') processRef.exit(code);
      else process.exit(code);
    };
  const gracefulTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
  const fatalTimeoutMs = options.fatalTimeoutMs ?? DEFAULT_FATAL_TIMEOUT_MS;

  if (!Number.isFinite(gracefulTimeoutMs) || gracefulTimeoutMs <= 0) {
    throw new TypeError('shutdownTimeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(fatalTimeoutMs) || fatalTimeoutMs <= 0) {
    throw new TypeError('fatalTimeoutMs must be a positive finite number');
  }

  let state = STATES.STARTING;
  let stateReason = null;
  let stateChangedAt = now();
  let server = null;
  let serverClosePromise = null;
  const sockets = new Set();
  let schedulerHandle = null;
  let schedulerEnabled = false;
  let bootstrapStarted = false;
  let bootstrapTask = null;
  let liveCycleTask = null;
  const replayTasks = new Map();
  const requests = new Map();
  let drainBlockingRequestCount = 0;
  const drainWaiters = new Set();
  let nextId = 0;
  let gracefulFlushHook = async () => {};
  let resourceCleanupHook = async () => {};
  let gracefulFlushHookSet = false;
  let resourceCleanupHookSet = false;
  let gracefulFlushStarted = false;
  let gracefulFlushController = null;
  let resourceCleanupPromise = null;
  let shutdownPromise = null;
  let fatalPromise = null;
  let fatalSeen = false;
  let forced = false;
  let signalsInstalled = false;

  function nextIdentity(kind) {
    nextId += 1;
    return `${kind}-${nextId}`;
  }

  function safeLog(level, message, data) {
    try {
      logger[level](message, data);
    } catch {
      // Lifecycle failure handling must not depend on logging success.
    }
  }

  function transition(nextState, reason) {
    state = nextState;
    stateReason = reason || null;
    stateChangedAt = now();
  }

  function hasTrackedWork() {
    return drainBlockingRequestCount > 0
      || bootstrapTask !== null
      || liveCycleTask !== null
      || replayTasks.size > 0;
  }

  function notifyDrainWaiters() {
    if (hasTrackedWork()) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }

  function waitForDrain() {
    if (!hasTrackedWork()) return Promise.resolve();
    return new Promise(resolve => drainWaiters.add(resolve));
  }

  function releaseTask(task) {
    if (task.released) return;
    task.released = true;

    if (task.kind === WORK_KINDS.BOOTSTRAP && bootstrapTask === task) {
      bootstrapTask = null;
    }
    if (task.kind === WORK_KINDS.LIVE_CYCLE && liveCycleTask === task) {
      liveCycleTask = null;
    }
    if (task.kind === WORK_KINDS.REPLAY && replayTasks.get(task.id) === task) {
      replayTasks.delete(task.id);
    }

    notifyDrainWaiters();
  }

  function createTask(kind, factory, register) {
    const id = nextIdentity(kind);
    const task = {
      id,
      kind,
      controller: null,
      promise: null,
      released: false,
    };

    register(task);

    try {
      task.controller = createAbortController();
      if (!task.controller || typeof task.controller.abort !== 'function') {
        throw new TypeError('abortControllerFactory must return an abort controller');
      }
    } catch (error) {
      releaseTask(task);
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      return rejected;
    }

    let result;
    try {
      result = factory({ signal: task.controller.signal, id });
    } catch (error) {
      releaseTask(task);
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      return rejected;
    }

    task.promise = Promise.resolve(result);
    task.promise.then(
      () => releaseTask(task),
      () => releaseTask(task),
    );
    return task.promise;
  }

  function canStartWork(kind) {
    if (kind === WORK_KINDS.BOOTSTRAP || kind === 'bootstrap') {
      return state === STATES.STARTING && !bootstrapStarted && bootstrapTask === null;
    }
    if (kind === WORK_KINDS.LIVE_CYCLE || kind === 'liveCycle' || kind === 'live-cycle') {
      return state === STATES.RUNNING && liveCycleTask === null;
    }
    if (kind === WORK_KINDS.REPLAY || kind === 'replay') {
      return state === STATES.RUNNING;
    }
    return state === STATES.RUNNING;
  }

  function startBootstrap(factory) {
    if (typeof factory !== 'function' || !canStartWork(WORK_KINDS.BOOTSTRAP)) return null;
    bootstrapStarted = true;
    return createTask(WORK_KINDS.BOOTSTRAP, factory, task => {
      bootstrapTask = task;
    });
  }

  function startLiveCycle(factory) {
    if (typeof factory !== 'function' || !canStartWork(WORK_KINDS.LIVE_CYCLE)) return null;
    return createTask(WORK_KINDS.LIVE_CYCLE, factory, task => {
      liveCycleTask = task;
    });
  }

  function startReplay(factory) {
    if (typeof factory !== 'function' || !canStartWork(WORK_KINDS.REPLAY)) return null;
    return createTask(WORK_KINDS.REPLAY, factory, task => {
      replayTasks.set(task.id, task);
    });
  }

  function startLiveScheduler(intervalMs, factory) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0
      || typeof factory !== 'function'
      || state !== STATES.RUNNING
      || schedulerHandle !== null) {
      return false;
    }

    schedulerEnabled = true;
    schedulerHandle = timers.setInterval(() => {
      if (!schedulerEnabled) return;
      const task = startLiveCycle(factory);
      if (task) task.catch(error => safeLog('error', 'Live cycle failed', { error: error?.message || String(error) }));
    }, intervalMs);
    return true;
  }

  function stopScheduler() {
    schedulerEnabled = false;
    if (schedulerHandle === null) return;
    timers.clearInterval(schedulerHandle);
    schedulerHandle = null;
  }

  function abortTask(task) {
    if (!task?.controller || typeof task.controller.abort !== 'function') return;
    try {
      task.controller.abort();
    } catch (error) {
      safeLog('warn', 'Lifecycle task abort failed', {
        id: task.id,
        error: error?.message || String(error),
      });
    }
  }

  function abortGracefulFlush() {
    if (!gracefulFlushController || typeof gracefulFlushController.abort !== 'function') return;
    try {
      gracefulFlushController.abort();
    } catch (error) {
      safeLog('warn', 'Graceful flush abort failed', { error: error?.message || String(error) });
    }
  }

  function abortTrackedWork() {
    abortTask(bootstrapTask);
    abortTask(liveCycleTask);
    for (const task of replayTasks.values()) abortTask(task);
  }

  function attachServer(nextServer) {
    if (!nextServer || typeof nextServer.close !== 'function') {
      throw new TypeError('server must expose close()');
    }
    if (server && server !== nextServer) throw new Error('HTTP server is already attached');
    server = nextServer;
    if (typeof server.on === 'function') {
      server.on('connection', socket => {
        sockets.add(socket);
        if (typeof socket.once === 'function') socket.once('close', () => sockets.delete(socket));
      });
    }
    return server;
  }

  function closeIdleSockets() {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch (error) {
        safeLog('warn', 'Idle HTTP socket close failed', { error: error?.message || String(error) });
      }
    }
  }

  function initiateServerClose() {
    if (serverClosePromise) return serverClosePromise;
    if (!server) {
      serverClosePromise = Promise.resolve();
      return serverClosePromise;
    }

    serverClosePromise = new Promise((resolve, reject) => {
      try {
        server.close(error => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
    serverClosePromise.catch(() => {});
    return serverClosePromise;
  }

  function trackRequest(req, res, classification = 'unsafe') {
    const id = nextIdentity('request');
    const allowed = state === STATES.RUNNING || SAFE_REQUEST_CLASSES.has(classification);
    const drainBlocking = allowed
      && state !== STATES.SHUTTING_DOWN
      && state !== STATES.FAILED
      && state !== STATES.STOPPED;
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      requests.delete(id);
      if (drainBlocking) drainBlockingRequestCount--;
      notifyDrainWaiters();
    };

    requests.set(id, { id, req, classification, drainBlocking, release });
    if (drainBlocking) drainBlockingRequestCount++;
    if (res && typeof res.once === 'function') {
      res.once('finish', release);
      res.once('close', release);
    }

    return Object.freeze({ id, allowed, release });
  }

  function setGracefulFlushHook(fn) {
    if (typeof fn !== 'function' || gracefulFlushHookSet || shutdownPromise || fatalSeen) {
      throw new TypeError('graceful flush hook must be registered before shutdown');
    }
    gracefulFlushHook = fn;
    gracefulFlushHookSet = true;
  }

  function setResourceCleanupHook(fn) {
    if (typeof fn !== 'function' || resourceCleanupHookSet || shutdownPromise || fatalSeen) {
      throw new TypeError('resource cleanup hook must be registered before shutdown');
    }
    resourceCleanupHook = fn;
    resourceCleanupHookSet = true;
  }

  function markRunning() {
    if (state !== STATES.STARTING) return false;
    transition(STATES.RUNNING, 'server-listening');
    return true;
  }

  function runResourceCleanup(reason) {
    if (resourceCleanupPromise) return resourceCleanupPromise;
    resourceCleanupPromise = Promise.resolve().then(() => resourceCleanupHook({ reason }));
    return resourceCleanupPromise;
  }

  function forceTerminate(reason) {
    if (forced) return;
    forced = true;
    safeLog('error', 'Forcing nonzero process termination', { reason });
    try {
      forceExit(1);
    } catch (error) {
      safeLog('error', 'Forced process termination failed', { error: error?.message || String(error) });
    }
  }

  async function performGracefulShutdown(reason) {
    stopScheduler();
    abortTrackedWork();
    const closePromise = initiateServerClose();

    await waitForDrain();
    if (fatalSeen || state !== STATES.SHUTTING_DOWN) throw new Error('Graceful shutdown superseded');
    closeIdleSockets();

    if (fatalSeen || state !== STATES.SHUTTING_DOWN) throw new Error('Graceful shutdown superseded');
    let flushController;
    try {
      flushController = createAbortController();
      if (!flushController || typeof flushController.abort !== 'function') {
        throw new TypeError('abortControllerFactory must return an abort controller');
      }
      gracefulFlushController = flushController;
      gracefulFlushStarted = true;
      await gracefulFlushHook({ reason, signal: flushController.signal });
    } finally {
      if (gracefulFlushController === flushController) gracefulFlushController = null;
    }
    if (fatalSeen || state !== STATES.SHUTTING_DOWN) throw new Error('Graceful shutdown superseded');

    await runResourceCleanup(reason);
    await closePromise;

    if (fatalSeen || state !== STATES.SHUTTING_DOWN) throw new Error('Graceful shutdown superseded');
    transition(STATES.STOPPED, reason);
    if ('exitCode' in processRef) processRef.exitCode = 0;
    return Object.freeze({ state: STATES.STOPPED, reason });
  }

  function shutdown(reason = 'explicit') {
    if (shutdownPromise) return shutdownPromise;
    if (state === STATES.STOPPED) return Promise.resolve(Object.freeze({ state, reason: stateReason }));
    if (state === STATES.FAILED) return Promise.reject(new Error('Lifecycle is already FAILED'));

    transition(STATES.SHUTTING_DOWN, reason);
    shutdownPromise = (async () => {
      let timer;
      try {
        return await Promise.race([
          performGracefulShutdown(reason),
          new Promise((resolve, reject) => {
            timer = timers.setTimeout(() => reject(new Error('Graceful shutdown deadline exceeded')), gracefulTimeoutMs);
          }),
        ]);
      } catch (error) {
        if (state !== STATES.FAILED) transition(STATES.FAILED, error.message);
        if ('exitCode' in processRef) processRef.exitCode = 1;
        forceTerminate(error.message);
        throw error;
      } finally {
        if (timer !== undefined) timers.clearTimeout(timer);
      }
    })();
    shutdownPromise.catch(() => {});
    return shutdownPromise;
  }

  function fatal(reason = 'fatal') {
    if (fatalPromise) return fatalPromise;
    if (state === STATES.STOPPED) {
      fatalPromise = Promise.reject(new Error('Lifecycle is already STOPPED'));
      fatalPromise.catch(() => {});
      return fatalPromise;
    }

    fatalSeen = true;
    transition(STATES.FAILED, reason);
    abortGracefulFlush();
    stopScheduler();
    abortTrackedWork();
    closeIdleSockets();
    const closePromise = initiateServerClose();

    fatalPromise = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.all([
            closePromise.catch(error => safeLog('error', 'Fatal HTTP close failed', { error: error?.message || String(error) })),
            runResourceCleanup(reason).catch(error => safeLog('error', 'Fatal resource cleanup failed', { error: error?.message || String(error) })),
          ]),
          new Promise(resolve => {
            timer = timers.setTimeout(resolve, fatalTimeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) timers.clearTimeout(timer);
        forceTerminate(reason);
      }
    })();
    fatalPromise.catch(() => {});
    return fatalPromise;
  }

  function normalizeFatalReason(value) {
    if (value instanceof Error) return value.message;
    return String(value);
  }

  function installSignalHandlers() {
    if (signalsInstalled) return;
    if (!processRef || typeof processRef.on !== 'function') {
      throw new TypeError('processRef must expose on()');
    }
    signalsInstalled = true;

    const terminationSignal = signal => {
      if (state === STATES.SHUTTING_DOWN) {
        forceTerminate(`second ${signal}`);
        return;
      }
      if (state === STATES.FAILED || state === STATES.STOPPED) {
        forceTerminate(`${signal} after ${state}`);
        return;
      }
      const pending = shutdown(signal);
      pending.catch(error => safeLog('error', 'Graceful shutdown failed', { error: error.message }));
    };

    processRef.on('SIGTERM', () => terminationSignal('SIGTERM'));
    processRef.on('SIGINT', () => terminationSignal('SIGINT'));
    processRef.on('uncaughtException', error => fatal(`uncaughtException: ${normalizeFatalReason(error)}`));
    processRef.on('unhandledRejection', reason => fatal(`unhandledRejection: ${normalizeFatalReason(reason)}`));
  }

  function getState() {
    return state;
  }

  function isShuttingDown() {
    return state === STATES.SHUTTING_DOWN
      || state === STATES.FAILED
      || state === STATES.STOPPED;
  }

  function getStatus() {
    return Object.freeze({
      state,
      reason: stateReason,
      stateChangedAt,
      serverAttached: server !== null,
      serverCloseInitiated: serverClosePromise !== null,
      trackedSockets: sockets.size,
      schedulerEnabled,
      activeRequests: requests.size,
      bootstrapActive: bootstrapTask !== null,
      liveCycleActive: liveCycleTask !== null,
      replayCount: replayTasks.size,
      gracefulFlushStarted,
      fatal: fatalSeen,
    });
  }

  return Object.freeze({
    getState,
    getStatus,
    isShuttingDown,
    canStartWork,
    attachServer,
    markRunning,
    startBootstrap,
    startLiveCycle,
    startLiveScheduler,
    startReplay,
    trackRequest,
    setGracefulFlushHook,
    setResourceCleanupHook,
    installSignalHandlers,
    shutdown,
    fatal,
    forceTerminate,
  });
}

module.exports = {
  createLifecycleController,
  DEFAULT_FATAL_TIMEOUT_MS,
  DEFAULT_GRACEFUL_TIMEOUT_MS,
  STATES,
  WORK_KINDS,
};
