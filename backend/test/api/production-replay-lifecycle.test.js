const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const { createLifecycleController } = require('../../src/core/lifecycleController');
const { createProductionReplayRouter } = require('../../src/routes/productionReplayRoutes');

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
  const application = {
    run() {
      calls++;
      observedReplayCount = lifecycle.getStatus().replayCount;
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
