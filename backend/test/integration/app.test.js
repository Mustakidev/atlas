const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createApp, createErrorHandler } = require('../../src/app');
const { cloneFixture, validMarketSnapshot } = require('../fixtures/market');

const API_KEY = 'integration-test-key';
const ALLOWED_ORIGIN = 'http://allowed.test';

function config(state = {}) {
  const values = {
    API_KEY,
    CORS_ORIGIN: ALLOWED_ORIGIN,
    MAX_BODY_SIZE: '1mb',
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX_REQUESTS: 1000,
    RATE_LIMIT_EXPENSIVE_MAX: 1000,
    PORT: 3000,
    REFRESH_INTERVAL: 2000,
    CACHE_TTL: 30000,
    MAX_HISTORY: 500,
    LOG_LEVEL: 'INFO',
    REQUEST_TIMEOUT: 10000,
    MAX_RETRIES: 5,
    INITIAL_BACKOFF: 1000,
    ...state.configValues,
  };

  return {
    get(key) { return values[key]; },
    getAll() { return values; },
  };
}

function logger(state) {
  return {
    info() {},
    warn() {},
    error(module, message, data) {
      state.errors = state.errors || [];
      state.errors.push({ module, message, data });
    },
    system() {},
  };
}

function createTestApp(state) {
  const snapshot = cloneFixture(validMarketSnapshot());
  const deps = {
    apiManager: {
      isConnected: () => true,
      getHealth: () => {
        if (state.throwHealth) throw new Error(state.errorMessage);
        return { connected: true, consecutiveFailures: 0 };
      },
    },
    history: {
      latest: () => {
        if (state.throwHistory) throw new Error(state.errorMessage);
        return cloneFixture(snapshot);
      },
      last: () => [cloneFixture(snapshot)],
      size: () => 1,
    },
    analyzer: { getAnalysis: () => null },
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => [],
      getActive: () => null,
    },
    logger: logger(state),
    config: config(state),
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
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      rawBody: '{invalid}',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(result.statusCode, 400);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Invalid JSON payload' });
  } finally {
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

test('synchronous route throws use the generic JSON 500 boundary', async () => {
  const errors = [];
  const app = express();
  app.get('/sync-throw', () => {
    throw new Error('secret direct route failure /repository/backend/src/app.js:321');
  });
  app.use(createErrorHandler({
    error(module, message, data) {
      errors.push({ module, message, data });
    },
  }));

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const result = await request(server, { path: '/sync-throw' });

    assert.equal(result.statusCode, 500);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(result.text.includes('secret direct route failure'), false);
    assert.ok(errors.some(entry => entry.data.category === 'unhandled'));
  } finally {
    await stopApp(server);
  }
});

test('synchronous dependency failures return a generic JSON 500 and preserve process health', async () => {
  const state = {
    throwHistory: true,
    errorMessage: 'secret /repository/backend/src/routes/routes.js:123',
  };
  const server = await startApp(state);
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 500);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(result.text.includes('<html'), false);
    assert.equal(result.text.includes('secret'), false);
    assert.equal(result.text.includes('routes.js'), false);
    assert.equal(result.text.includes('/repository/'), false);
    assert.equal(result.text.includes('Error:'), false);
    assert.ok(state.errors.some(entry => (
      entry.module === 'ErrorBoundary'
      && entry.data.path === '/api/market'
      && entry.data.status === 500
      && entry.data.category === 'unhandled'
    )));

    state.throwHistory = false;
    const health = await request(server, { path: '/api/status' });
    assert.equal(health.statusCode, 200);
  } finally {
    await stopApp(server);
  }
});

test('malformed JSON returns the exact controlled JSON contract', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      rawBody: '{invalid}',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(result.statusCode, 400);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Invalid JSON payload' });
    assert.ok(state.errors.some(entry => (
      entry.data.category === 'malformed-json' && entry.data.status === 400
    )));
  } finally {
    await stopApp(server);
  }
});

test('validation errors remain explicit 400 responses', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/candles?timeframe=invalid',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.json(), { error: 'Invalid timeframe', supported: ['1h'] });
  } finally {
    await stopApp(server);
  }
});

test('rate limiting remains an explicit 429 response', async () => {
  const server = await startApp({ configValues: { RATE_LIMIT_MAX_REQUESTS: 1 } });
  try {
    const first = await request(server, { path: '/api/status' });
    const second = await request(server, { path: '/api/status' });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error, 'Rate limit exceeded');
  } finally {
    await stopApp(server);
  }
});

test('unknown routes preserve the existing 404 behavior', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/does-not-exist',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 404);
    assert.match(result.text, /Cannot GET \/api\/does-not-exist/);
  } finally {
    await stopApp(server);
  }
});

test('/api/config remains a successful 200 response', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/config',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 200);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.equal(result.json().port, 3000);
  } finally {
    await stopApp(server);
  }
});

test('headers-sent errors delegate to Express without a second write', () => {
  const errors = [];
  const logger = {
    error(module, message, data) {
      errors.push({ module, message, data });
    },
  };
  const error = new Error('secret internal failure');
  const nextCalls = [];
  const res = {
    headersSent: true,
    status() {
      throw new Error('headers-sent handler attempted a second write');
    },
    json() {
      throw new Error('headers-sent handler attempted a second write');
    },
  };

  createErrorHandler(logger)(error, {
    method: 'GET',
    path: '/api/partial',
  }, res, forwardedError => nextCalls.push(forwardedError));

  assert.deepEqual(nextCalls, [error]);
  assert.deepEqual(errors, [{
    module: 'ErrorBoundary',
    message: 'Request error',
    data: {
      method: 'GET',
      path: '/api/partial',
      status: 500,
      category: 'unhandled',
    },
  }]);
});
