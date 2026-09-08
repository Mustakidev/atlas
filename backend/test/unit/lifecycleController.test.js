const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createLifecycleController,
  STATES,
} = require('../../src/core/lifecycleController');

function makeProcess() {
  const handlers = new Map();
  return {
    exitCode: null,
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    emit(event, ...args) {
      return handlers.get(event)?.(...args);
    },
    handlerCount() {
      return handlers.size;
    },
  };
}

function makeTimers() {
  let nextId = 0;
  const intervals = new Map();
  const timeouts = new Map();

  return {
    intervals,
    timeouts,
    setInterval(fn) {
      const id = `interval-${++nextId}`;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout(fn, delay) {
      const id = `timeout-${++nextId}`;
      timeouts.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    fireTimeouts() {
      for (const [id, timer] of [...timeouts]) {
        timeouts.delete(id);
        timer.fn();
      }
    },
  };
}

function makeServer({ closeImmediately = true } = {}) {
  return {
    closeCalls: 0,
    closeCallback: null,
    close(callback) {
      this.closeCalls++;
      this.closeCallback = callback;
      if (closeImmediately) callback();
    },
  };
}

function makeController(options = {}) {
  const processRef = options.processRef || makeProcess();
  const timers = options.timers || makeTimers();
  const exits = [];
  const controller = createLifecycleController({
    processRef,
    timers,
    now: () => 1,
    logger: { info() {}, warn() {}, error() {}, system() {} },
    forceExit: code => exits.push(code),
    ...options,
  });
  return { controller, processRef, timers, exits };
}

test('task factories are registered before invocation and release once', async () => {
  const { controller } = makeController();
  let resolveBootstrap;
  let invocationStatus;

  const bootstrap = controller.startBootstrap(({ signal, id }) => {
    invocationStatus = controller.getStatus();
    assert.equal(typeof id, 'string');
    assert.equal(typeof signal, 'object');
    return new Promise(resolve => { resolveBootstrap = resolve; });
  });

  assert.equal(controller.getState(), STATES.STARTING);
  assert.equal(invocationStatus.bootstrapActive, true);
  assert.equal(controller.startBootstrap(() => Promise.resolve()), null);

  resolveBootstrap();
  await bootstrap;
  await Promise.resolve();
  assert.equal(controller.getStatus().bootstrapActive, false);
});

test('live scheduler owns interval and prevents overlapping live cycles', async () => {
  const { controller, timers } = makeController();
  controller.markRunning();

  let resolveLive;
  let calls = 0;
  const factory = () => {
    calls++;
    return new Promise(resolve => { resolveLive = resolve; });
  };

  assert.equal(controller.startLiveScheduler(1000, factory), true);
  const interval = [...timers.intervals.values()][0];
  interval();
  interval();
  assert.equal(calls, 1);
  assert.equal(controller.getStatus().liveCycleActive, true);

  resolveLive();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getStatus().liveCycleActive, false);

  controller.shutdown('test').catch(() => {});
  assert.equal(timers.intervals.size, 0);
});

test('startup opt-in permits activation work before RUNNING without weakening normal guards', async () => {
  const { controller, timers } = makeController();
  let resolveInitial;
  let calls = 0;
  const initial = controller.startLiveCycle(({ signal }) => {
    calls++;
    return new Promise(resolve => {
      resolveInitial = resolve;
      signal.addEventListener('abort', resolve, { once: true });
    });
  }, { allowStarting: true });

  assert.equal(controller.getState(), STATES.STARTING);
  assert.equal(controller.startLiveCycle(() => Promise.resolve()), null);
  assert.equal(controller.startLiveScheduler(1000, () => {
    calls++;
    return Promise.resolve();
  }, { allowStarting: true }), true);
  [...timers.intervals.values()][0]();
  assert.equal(calls, 1);

  resolveInitial();
  await initial;
  controller.markRunning();
  [...timers.intervals.values()][0]();
  await Promise.resolve();
  assert.equal(calls, 2);
  await controller.shutdown('test');
});

test('request admission and release are synchronous and idempotent', () => {
  const { controller } = makeController();
  controller.markRunning();

  const response = new EventEmitter();
  const admission = controller.trackRequest({ path: '/api/paper-trades/close' }, response, 'unsafe');
  assert.equal(admission.allowed, true);
  assert.equal(controller.getStatus().activeRequests, 1);

  response.emit('finish');
  response.emit('close');
  admission.release();
  assert.equal(controller.getStatus().activeRequests, 0);

  controller.shutdown('test').catch(() => {});
  const rejected = controller.trackRequest({ path: '/api/paper-trades/close' }, new EventEmitter(), 'unsafe');
  const health = controller.trackRequest({ path: '/healthz' }, new EventEmitter(), 'health');
  assert.equal(rejected.allowed, false);
  assert.equal(health.allowed, true);
  rejected.release();
  health.release();
});

test('post-shutdown safe requests remain tracked but do not block the pre-shutdown drain', async () => {
  const { controller } = makeController();
  const server = makeServer();
  const blockingResponse = new EventEmitter();
  const safeResponses = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
  const order = [];
  controller.attachServer(server);
  controller.markRunning();
  controller.setGracefulFlushHook(async () => { order.push('flush'); });
  controller.setResourceCleanupHook(async () => { order.push('cleanup'); });

  const blocking = controller.trackRequest({}, blockingResponse, 'unsafe');
  const shutdown = controller.shutdown('SIGTERM');
  const safe = safeResponses.map(response => controller.trackRequest({ path: '/healthz' }, response, 'health'));

  assert.equal(safe.every(request => request.allowed), true);
  assert.equal(controller.getStatus().activeRequests, 4);
  assert.equal(controller.getStatus().state, STATES.SHUTTING_DOWN);

  blocking.release();
  await shutdown;

  assert.equal(controller.getState(), STATES.STOPPED);
  assert.deepEqual(order, ['flush', 'cleanup']);
  assert.equal(controller.getStatus().activeRequests, 3);

  for (const request of safe) {
    request.release();
    request.release();
  }
  assert.equal(controller.getStatus().activeRequests, 0);
});

test('unsafe requests after shutdown are rejected and never become drain blockers', async () => {
  const { controller } = makeController();
  controller.markRunning();
  const shutdown = controller.shutdown('SIGTERM');

  const rejected = controller.trackRequest({ path: '/api/paper-trades/close' }, new EventEmitter(), 'unsafe');
  assert.equal(rejected.allowed, false);
  assert.equal(controller.getStatus().activeRequests, 1);

  rejected.release();
  await shutdown;
  assert.equal(controller.getState(), STATES.STOPPED);
});

test('safe visibility traffic does not create or reset the graceful deadline', async () => {
  const { controller, timers } = makeController({ shutdownTimeoutMs: 10 });
  controller.markRunning();
  let resolveFlush;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  controller.setGracefulFlushHook(() => {
    resolveStarted();
    return new Promise(resolve => { resolveFlush = resolve; });
  });

  const shutdown = controller.shutdown('SIGTERM');
  await started;
  const initialTimeouts = [...timers.timeouts.values()];
  assert.equal(initialTimeouts.length, 1);
  assert.equal(initialTimeouts[0].delay, 10);

  const safeRequests = Array.from({ length: 20 }, () => (
    controller.trackRequest({ path: '/healthz' }, new EventEmitter(), 'health')
  ));
  assert.equal(timers.timeouts.size, 1);
  assert.equal(controller.getStatus().state, STATES.SHUTTING_DOWN);

  for (const request of safeRequests) request.release();
  resolveFlush();
  await shutdown;
  assert.equal(controller.getState(), STATES.STOPPED);
});

test('graceful shutdown drains work, invokes flush before cleanup, and stops', async () => {
  const { controller } = makeController();
  const server = makeServer();
  const order = [];
  let resolveLive;
  let liveSignal;
  let flushSignal;
  controller.attachServer(server);
  controller.markRunning();
  controller.setGracefulFlushHook(async ({ signal }) => {
    flushSignal = signal;
    order.push('flush');
  });
  controller.setResourceCleanupHook(async () => { order.push('cleanup'); });

  const response = new EventEmitter();
  const admission = controller.trackRequest({}, response, 'unsafe');
  const live = controller.startLiveCycle(({ signal }) => {
    liveSignal = signal;
    return new Promise(resolve => {
      resolveLive = resolve;
    });
  });
  const shutdown = controller.shutdown('SIGTERM');

  assert.equal(controller.getState(), STATES.SHUTTING_DOWN);
  assert.equal(controller.startLiveCycle(() => Promise.resolve()), null);
  assert.equal(controller.getStatus().schedulerEnabled, false);

  admission.release();
  resolveLive();
  await live;
  await shutdown;

  assert.equal(controller.getState(), STATES.STOPPED);
  assert.deepEqual(order, ['flush', 'cleanup']);
  assert.equal(server.closeCalls, 1);
  assert.equal(flushSignal.aborted, false);
  assert.notEqual(flushSignal, liveSignal);
});

test('non-terminal failure preserves diagnostics, stops live work, and allows later shutdown', async () => {
  const { controller, exits, timers } = makeController();
  const server = makeServer();
  const order = [];
  let liveSignal;
  controller.attachServer(server);
  controller.setGracefulFlushHook(async () => { order.push('flush'); });
  controller.setResourceCleanupHook(async () => { order.push('cleanup'); });
  controller.markRunning();
  assert.equal(controller.startLiveScheduler(1000, () => Promise.resolve()), true);
  const live = controller.startLiveCycle(({ signal }) => {
    liveSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  });

  assert.equal(controller.markFailed('activation-failed'), true);
  await live;
  assert.equal(controller.getState(), STATES.FAILED);
  assert.equal(controller.getStatus().reason, 'activation-failed');
  assert.equal(controller.getStatus().schedulerEnabled, false);
  assert.equal(liveSignal.aborted, true);
  assert.equal(timers.intervals.size, 0);
  assert.equal(server.closeCalls, 0);
  assert.deepEqual(exits, []);
  assert.equal(controller.markFailed('repeated-failure'), false);
  assert.equal(controller.startLiveCycle(() => Promise.resolve()), null);
  assert.equal(controller.startLiveScheduler(1000, () => Promise.resolve()), false);

  const diagnostic = controller.trackRequest({ path: '/api/status' }, new EventEmitter(), 'status');
  assert.equal(diagnostic.allowed, true);
  diagnostic.release();

  await controller.shutdown('after-failure');
  assert.equal(controller.getState(), STATES.STOPPED);
  assert.equal(server.closeCalls, 1);
  assert.deepEqual(order, ['flush', 'cleanup']);
});

test('fatal shutdown skips graceful flush and becomes terminal FAILED', async () => {
  const { controller, exits } = makeController();
  const server = makeServer();
  let flushCalls = 0;
  let cleanupCalls = 0;
  controller.attachServer(server);
  controller.markRunning();
  controller.setGracefulFlushHook(async () => { flushCalls++; });
  controller.setResourceCleanupHook(async () => { cleanupCalls++; });

  await controller.fatal('uncaughtException: boom');

  assert.equal(controller.getState(), STATES.FAILED);
  assert.equal(flushCalls, 0);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(exits, [1]);
  assert.equal(controller.markRunning(), false);
  assert.equal(controller.startReplay(() => Promise.resolve()), null);
});

test('fatal shutdown before graceful flush begins prevents the hook from starting', async () => {
  const { controller, exits } = makeController();
  let flushCalls = 0;
  controller.setGracefulFlushHook(async () => { flushCalls++; });
  controller.markRunning();

  const shutdown = controller.shutdown('SIGTERM');
  const fatal = controller.fatal('uncaughtException: boom');

  await fatal;
  await assert.rejects(shutdown, /superseded/);
  assert.equal(flushCalls, 0);
  assert.equal(controller.getState(), STATES.FAILED);
  assert.deepEqual(exits, [1]);
});

test('fatal shutdown aborts an in-progress graceful flush without awaiting it', async () => {
  const { controller, exits } = makeController();
  let flushSignal;
  let flushCalls = 0;
  let resolveStarted;
  let resolveFlush;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  controller.setGracefulFlushHook(({ signal }) => {
    flushCalls++;
    flushSignal = signal;
    resolveStarted();
    return new Promise(resolve => { resolveFlush = resolve; });
  });
  let cleanupCalls = 0;
  controller.setResourceCleanupHook(async () => { cleanupCalls++; });
  controller.markRunning();

  const shutdown = controller.shutdown('SIGTERM');
  await started;
  const fatal = controller.fatal('uncaughtException: boom');
  await fatal;

  assert.equal(flushSignal.aborted, true);
  assert.equal(flushCalls, 1);
  assert.equal(controller.getState(), STATES.FAILED);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(exits, [1]);

  resolveFlush();
  await assert.rejects(shutdown, /superseded/);
  assert.equal(controller.getState(), STATES.FAILED);
  assert.equal(cleanupCalls, 1);
});

test('graceful deadline fails and force-terminates without invoking flush', async () => {
  const { controller, timers, exits } = makeController({ shutdownTimeoutMs: 10 });
  controller.markRunning();
  let flushCalls = 0;
  controller.setGracefulFlushHook(async () => { flushCalls++; });
  controller.startLiveCycle(() => new Promise(() => {}));

  const shutdown = controller.shutdown('SIGINT');
  timers.fireTimeouts();

  await assert.rejects(shutdown, /deadline exceeded/);
  assert.equal(controller.getState(), STATES.FAILED);
  assert.equal(flushCalls, 0);
  assert.deepEqual(exits, [1]);
});

test('signal handlers install once and second termination signal forces exit', async () => {
  const { controller, processRef, exits } = makeController();
  const server = makeServer();
  controller.attachServer(server);
  controller.markRunning();
  controller.installSignalHandlers();
  controller.installSignalHandlers();
  assert.equal(processRef.handlerCount(), 4);

  processRef.emit('SIGTERM');
  processRef.emit('SIGINT');
  assert.deepEqual(exits, [1]);
  assert.equal(controller.getState(), STATES.SHUTTING_DOWN);

  await controller.shutdown('SIGTERM').catch(() => {});
});
