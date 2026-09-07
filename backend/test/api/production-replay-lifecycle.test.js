const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const { createLifecycleController } = require('../../src/core/lifecycleController');
const { createProductionReplayRouter } = require('../../src/routes/productionReplayRoutes');
const { createAbortError } = require('../../src/core/cancellation');

const HOUR_MS = 3_600_000;
const START_TIME = 86_400_000;
const END_TIME = START_TIME + (51 * HOUR_MS);

function request(server) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: server.address().port,
      path: `/strategy/replay/v2?symbol=BTCUSDT&startTime=${START_TIME}&endTime=${END_TIME}`,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
    });
    req.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test('Replay starts only after lifecycle registration and is rejected after shutdown', async () => {
  const exits = [];
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
    forceExit: code => exits.push(code),
  });
  lifecycle.markRunning();

  let calls = 0;
  let observedReplayCount = 0;
  const signals = [];
  const application = {
    run(requestValue, options) {
      calls++;
      observedReplayCount = lifecycle.getStatus().replayCount;
      signals.push(options.signal);
      return Promise.resolve({ replay: true });
    },
  };
  const app = express();
  app.use(createProductionReplayRouter({
    application,
    logger: { error() {} },
    lifecycle,
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const accepted = await request(server);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.body, { replay: true });
    assert.equal(calls, 1);
    assert.equal(observedReplayCount, 1);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);

    await lifecycle.shutdown('test');
    const rejected = await request(server);
    assert.equal(rejected.statusCode, 503);
    assert.deepEqual(rejected.body, { error: 'Server shutting down' });
    assert.equal(calls, 1);
    assert.deepEqual(exits, []);
  } finally {
    await close(server);
  }
});

test('an admitted Replay cancelled during execution returns the existing 503 response', async () => {
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
  });
  lifecycle.markRunning();

  const application = {
    run(request, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
      });
    },
  };
  const app = express();
  app.use(createProductionReplayRouter({
    application,
    logger: { error() {} },
    lifecycle,
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const responsePromise = request(server);
    await new Promise(resolve => setImmediate(resolve));
    const shutdown = lifecycle.shutdown('test');
    const response = await responsePromise;
    await shutdown;
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Server shutting down' });
  } finally {
    if (server.listening) await close(server);
  }
});

test('settled and deregistered Replay is denied publication after authoritative shutdown begins', async () => {
  const exits = [];
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
    forceExit: code => exits.push(code),
  });
  lifecycle.markRunning();
  assert.equal(lifecycle.getState(), 'RUNNING');

  let applicationCalls = 0;
  let producedResult;
  let capturedSignal;
  let applicationSettled = false;
  let jsonWrites = 0;
  let shutdownPromise;
  const unhandledRejections = [];
  const onUnhandledRejection = reason => unhandledRejections.push(reason);
  const completeResult = {
    replay: {
      cycles: [],
      runnerState: { status: 'EXHAUSTED', failure: null, cycleCount: 0 },
      trades: [],
      stats: {},
      performance: {},
      risk: {},
    },
    provenance: {},
  };
  const application = {
    async run(request, { signal }) {
      applicationCalls++;
      assert.equal(lifecycle.getState(), 'RUNNING');
      assert.equal(lifecycle.getStatus().replayCount, 1);
      capturedSignal = signal;
      producedResult = completeResult;
      applicationSettled = true;
      return completeResult;
    },
  };

  const originalIsShuttingDown = lifecycle.isShuttingDown;
  const instrumentedLifecycle = Object.create(lifecycle);
  Object.defineProperty(instrumentedLifecycle, 'isShuttingDown', {
    value: () => {
      assert.equal(applicationSettled, true);
      assert.equal(lifecycle.getStatus().replayCount, 0);
      assert.ok(capturedSignal);
      assert.equal(capturedSignal.aborted, false);

      shutdownPromise = lifecycle.shutdown('test-publication-boundary');
      assert.equal(lifecycle.getState(), 'SHUTTING_DOWN');
      return originalIsShuttingDown();
    },
  });

  const app = express();
  app.use((req, res, next) => {
    lifecycle.trackRequest(req, res);
    const originalJson = res.json.bind(res);
    res.json = (...args) => {
      jsonWrites++;
      return originalJson(...args);
    };
    next();
  });
  app.use(createProductionReplayRouter({
    application,
    logger: { error() {} },
    lifecycle: instrumentedLifecycle,
  }));
  const server = http.createServer(app);
  lifecycle.attachServer(server);
  process.on('unhandledRejection', onUnhandledRejection);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const response = await request(server);

    assert.equal(applicationCalls, 1);
    assert.equal(producedResult, completeResult);
    assert.equal(applicationSettled, true);
    assert.ok(capturedSignal);
    assert.equal(lifecycle.getStatus().replayCount, 0);
    assert.equal(capturedSignal.aborted, false);
    assert.ok(shutdownPromise);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Server shutting down' });
    assert.notDeepEqual(response.body, completeResult);
    assert.equal(jsonWrites, 1);

    await shutdownPromise;
    assert.equal(lifecycle.getStatus().activeRequests, 0);
    assert.equal(lifecycle.getState(), 'STOPPED');
    assert.equal(lifecycle.getStatus().fatal, false);
    assert.deepEqual(exits, []);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    if (shutdownPromise) await shutdownPromise.catch(() => {});
    if (server.listening) await close(server);
  }
});

test('Replay deadline aborts the operation and returns the timeout contract', async () => {
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
  });
  lifecycle.markRunning();
  let aborted = false;
  const application = {
    run(requestValue, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(createAbortError());
        }, { once: true });
      });
    },
  };
  const app = express();
  app.use(createProductionReplayRouter({
    application,
    logger: { error() {} },
    lifecycle,
    deadlineMs: 1,
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const response = await request(server);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.body, {
      error: 'Replay execution timed out',
      code: 'REPLAY_TIMEOUT',
    });
    assert.equal(aborted, true);
  } finally {
    await close(server);
  }
});

test('Replay aborts on premature client disconnect without attempting a response', async () => {
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
  });
  lifecycle.markRunning();
  let aborted = false;
  let resolveAborted;
  const abortedPromise = new Promise(resolve => { resolveAborted = resolve; });
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const application = {
    run(requestValue, { signal }) {
      resolveStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolveAborted();
          reject(createAbortError());
        }, { once: true });
      });
    },
  };
  const app = express();
  app.use(createProductionReplayRouter({
    application,
    logger: { error() {} },
    lifecycle,
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const client = http.get({
      host: '127.0.0.1',
      port: server.address().port,
      path: `/strategy/replay/v2?symbol=BTCUSDT&startTime=${START_TIME}&endTime=${END_TIME}`,
    });
    client.once('error', error => {
      if (error.code !== 'ECONNRESET') throw error;
    });
    await started;
    client.destroy();
    await abortedPromise;
    assert.equal(aborted, true);
  } finally {
    await close(server);
  }
});
