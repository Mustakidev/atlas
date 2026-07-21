const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../../src/app');
const { cloneFixture, validMarketSnapshot } = require('../fixtures/market');

const API_KEY = 'integration-test-key';
const ALLOWED_ORIGIN = 'http://allowed.test';

function config() {
  const values = {
    API_KEY,
    CORS_ORIGIN: ALLOWED_ORIGIN,
    MAX_BODY_SIZE: '1mb',
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX_REQUESTS: 1000,
    RATE_LIMIT_EXPENSIVE_MAX: 1000,
  };

  return {
    get(key) { return values[key]; },
    getAll() { return values; },
  };
}

function logger() {
  return { info() {}, warn() {}, error() {}, system() {} };
}

function createTestApp(state) {
  const snapshot = cloneFixture(validMarketSnapshot());
  const deps = {
    apiManager: {
      isConnected: () => true,
      getHealth: () => ({ connected: true, consecutiveFailures: 0 }),
    },
    history: {
      latest: () => cloneFixture(snapshot),
      last: () => [cloneFixture(snapshot)],
      size: () => 1,
    },
    analyzer: { getAnalysis: () => null },
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => [],
      getActive: () => null,
    },
    logger: logger(),
    config: config(),
    eventBus: {},
    cache: { getAge: () => 100 },
    indicatorRegistry: {
      has: () => false,
      getNames: () => [],
      calculateAll: () => ({}),
    },
    structureEngine: null,
    confluenceEngine: null,
    validationEngine: null,
    mtfEngine: null,
    macdEngine: null,
    atrEngine: null,
    bollingerEngine: null,
    signalHistoryEngine: null,
    backtestEngine: null,
    analyticsEngine: null,
    paperTradeEngine: {
      open: () => [],
      history: () => [],
      stats: () => ({ totalTrades: 0, openTrades: 0, closedTrades: 0 }),
      performance: () => ({ profitFactor: 0 }),
      getBalance: () => 10000,
      close: (tradeId, reason) => {
        state.closeRequest = { tradeId, reason };
        return { tradeId, reason, status: 'CLOSED' };
      },
    },
    riskEngine: null,
    strategyReplayEngine: null,
    regimeEngine: null,
    regimeDecisionEngine: null,
    advanceRiskEngine: null,
    mtfConfirmationEngine: null,
    symbol: 'BTCUSDT',
  };

  return createApp({
    config: deps.config,
    logger: deps.logger,
    routes: deps,
    getLastDecision: () => null,
    getPipelineHealth: () => ({ pipelineCycleCount: 0, pipelineErrors: 0 }),
  });
}

function request(server, { method = 'GET', path, headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined
      ? rawBody
      : body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path,
      headers: {
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
        ...headers,
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: data,
        json: () => JSON.parse(data),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startApp(state) {
  const server = http.createServer(createTestApp(state));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function stopApp(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('real Express app serves an allowed health endpoint without authentication', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, { path: '/api/status' });

    assert.equal(result.statusCode, 200);
    assert.equal(typeof result.json().uptime, 'number');
  } finally {
    await stopApp(server);
  }
});

test('real Express app rejects protected endpoints without an API key', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, { path: '/api/market' });

    assert.equal(result.statusCode, 401);
    assert.equal(result.json().error, 'Authentication required');
  } finally {
    await stopApp(server);
  }
});

test('real Express app accepts a valid API key and returns the market contract', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.json().symbol, 'BTCUSDT');
    assert.equal(result.json().connected, true);
  } finally {
    await stopApp(server);
  }
});

test('CORS runs before authentication for allowed origins', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { origin: ALLOWED_ORIGIN },
    });

    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  } finally {
    await stopApp(server);
  }
});

test('CORS with a disallowed origin does not grant an allow-origin header', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/status',
      headers: { origin: 'http://blocked.test' },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  } finally {
    await stopApp(server);
  }
});

test('JSON parsing occurs before protected route authentication', async () => {
  const server = await startApp({});
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      rawBody: '{invalid}',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(result.statusCode, 400);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = originalError;
    await stopApp(server);
  }
});

test('JSON parsing reaches a protected endpoint after authentication', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'T-1', reason: 'Integration test' },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(state.closeRequest, { tradeId: 'T-1', reason: 'Integration test' });
    assert.deepEqual(result.json(), { tradeId: 'T-1', reason: 'Integration test', status: 'CLOSED' });
  } finally {
    await stopApp(server);
  }
});

test('real Express app preserves representative route errors', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { 'x-api-key': 'wrong-key' },
    });

    assert.equal(result.statusCode, 401);
    assert.equal(result.json().message, 'Invalid API key');
  } finally {
    await stopApp(server);
  }
});
