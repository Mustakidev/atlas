const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createApp, createErrorHandler } = require('../../src/app');
const { cloneFixture, validMarketSnapshot } = require('../fixtures/market');
const {
  REGIME_DECISION_KEYS,
  REGIME_HISTORY_KEYS,
  STATS_KEYS,
  SUCCESS_KEYS,
  SUPPORTED_TIMEFRAMES,
  TRADE_KEYS,
  createControlledSuccessResponse,
  normalizeReplayResponse,
} = require('../fixtures/replay-contract');

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
  const candles = state.candles || [];
  const supportedTimeframes = state.supportedTimeframes || ['1h'];
  const defaultReplayEngine = {
    run: () => ({
      stats: { totalTrades: 0, winRate: 0, profitFactor: 0 },
      calculationTime: 0,
      trades: [],
    }),
  };
  const strategyReplayEngine = Object.hasOwn(state, 'strategyReplayEngine')
    ? state.strategyReplayEngine
    : defaultReplayEngine;
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
      getAllTimeframes: () => supportedTimeframes,
      getCandles: (timeframe, limit) => {
        state.candleRequests = state.candleRequests || [];
        state.candleRequests.push({ timeframe, limit });
        return [...candles];
      },
      getActive: () => state.activeCandle || null,
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
    strategyReplayEngine,
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

const NODE_FETCH_PATH = require.resolve('node-fetch');

async function withFetchMock(mock, callback) {
  const original = require.cache[NODE_FETCH_PATH];
  require.cache[NODE_FETCH_PATH] = {
    id: NODE_FETCH_PATH,
    filename: NODE_FETCH_PATH,
    loaded: true,
    exports: mock,
  };

  try {
    return await callback();
  } finally {
    if (original) require.cache[NODE_FETCH_PATH] = original;
    else delete require.cache[NODE_FETCH_PATH];
  }
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

function replayCandle(index = 0) {
  const openTime = Date.parse('2024-01-01T00:00:00.000Z') + index * 3600000;
  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1,
  };
}

const replayHeaders = { 'x-api-key': API_KEY };

function minimalReplayResult() {
  return {
    stats: { totalTrades: 0, winRate: 0, profitFactor: 0 },
    calculationTime: 0,
    trades: [],
  };
}

test('replay GET returns the controlled legacy contract without an envelope and POST remains non-contract', async () => {
  const state = {
    candles: [replayCandle()],
    strategyReplayEngine: { run: () => createControlledSuccessResponse() },
  };
  const server = await startApp(state);

  try {
    const getResult = await request(server, {
      path: '/api/strategy/replay',
      headers: replayHeaders,
    });
    assert.equal(getResult.statusCode, 200);

    const body = getResult.json();
    assert.deepEqual(Object.keys(body), SUCCESS_KEYS);
    assert.deepEqual(normalizeReplayResponse(body), normalizeReplayResponse(createControlledSuccessResponse()));
    assert.equal(body.engineVersion, '1.0.0');
    assert.equal(body.dataSource, 'Historical OHLCV candles (strategy replay)');
    assert.deepEqual(Object.keys(body.trades[0]), TRADE_KEYS);
    assert.deepEqual(Object.keys(body.trades[0].regimeDecision), REGIME_DECISION_KEYS);
    assert.deepEqual(Object.keys(body.regimeHistory[0]), REGIME_HISTORY_KEYS);
    assert.deepEqual(Object.keys(body.stats), STATS_KEYS);

    const postResult = await request(server, {
      method: 'POST',
      path: '/api/strategy/replay',
      headers: replayHeaders,
    });
    assert.equal(postResult.statusCode, 404);
    assert.match(postResult.text, /Cannot POST \/api\/strategy\/replay/);
  } finally {
    await stopApp(server);
  }
});

test('replay query contract applies defaults, lowercasing, validation, and live-source invariance', async () => {
  const state = {
    candles: [replayCandle()],
    supportedTimeframes: SUPPORTED_TIMEFRAMES,
    strategyReplayEngine: {
      run(candles, timeframe) {
        state.replayCalls = state.replayCalls || [];
        state.replayCalls.push({ count: candles.length, timeframe });
        return minimalReplayResult();
      },
    },
  };
  const server = await startApp(state);

  try {
    for (const [path, expectedTimeframe] of [
      ['/api/strategy/replay', '1h'],
      ['/api/strategy/replay?timeframe=1h', '1h'],
      ['/api/strategy/replay?timeframe=1H', '1h'],
      ['/api/strategy/replay?timeframe=5M', '5m'],
    ]) {
      const result = await request(server, { path, headers: replayHeaders });
      assert.equal(result.statusCode, 200);
      assert.equal(state.replayCalls.at(-1).timeframe, expectedTimeframe);
    }

    const invalid = await request(server, {
      path: '/api/strategy/replay?timeframe=2h',
      headers: replayHeaders,
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), {
      error: 'Invalid timeframe',
      supported: SUPPORTED_TIMEFRAMES,
    });

    const callsBeforeDays = state.replayCalls.length;
    for (const days of ['0', '-5', 'abc', '999999']) {
      const result = await request(server, {
        path: `/api/strategy/replay?days=${days}`,
        headers: replayHeaders,
      });
      assert.equal(result.statusCode, 200);
    }
    assert.equal(state.replayCalls.length, callsBeforeDays + 4);
    assert.deepEqual(state.replayCalls.slice(-4), [
      { count: 1, timeframe: '1h' },
      { count: 1, timeframe: '1h' },
      { count: 1, timeframe: '1h' },
      { count: 1, timeframe: '1h' },
    ]);
    assert.ok(state.candleRequests.every(({ limit }) => limit === 500));
  } finally {
    await stopApp(server);
  }
});

test('replay live source excludes the active candle, requests 500, and skips fallback', async () => {
  const candles = Array.from({ length: 501 }, (_, index) => replayCandle(index));
  const state = {
    candles,
    activeCandle: candles.at(-1),
    strategyReplayEngine: {
      run(input) {
        state.replayInput = input;
        return minimalReplayResult();
      },
    },
  };
  const server = await startApp(state);

  try {
    const result = await withFetchMock(async () => {
      throw new Error('fallback must not be called');
    }, () => request(server, {
      path: '/api/strategy/replay?days=999999',
      headers: replayHeaders,
    }));

    assert.equal(result.statusCode, 200);
    assert.deepEqual(state.candleRequests, [{ timeframe: '1h', limit: 500 }]);
    assert.equal(state.replayInput.length, 500);
    assert.notEqual(state.replayInput.at(-1).openTime, state.activeCandle.openTime);
  } finally {
    await stopApp(server);
  }
});

test('replay fallback normalizes days, maps OHLC, and sets volume to zero', async () => {
  const state = {
    strategyReplayEngine: {
      run(candles, timeframe) {
        state.replayInput = candles;
        state.replayTimeframe = timeframe;
        return minimalReplayResult();
      },
    },
  };
  const urls = [];
  const server = await startApp(state);

  try {
    await withFetchMock(async url => {
      urls.push(url);
      return {
        ok: true,
        async json() {
          return [[1704067200000, 100, 105, 95, 102]];
        },
      };
    }, async () => {
      for (const days of [undefined, '0', '-5', 'abc', '999999']) {
        const query = days === undefined ? '' : `?days=${days}`;
        const result = await request(server, {
          path: `/api/strategy/replay${query}`,
          headers: replayHeaders,
        });
        assert.equal(result.statusCode, 200);
        assert.equal(state.replayInput[0].open, 100);
        assert.equal(state.replayInput[0].high, 105);
        assert.equal(state.replayInput[0].low, 95);
        assert.equal(state.replayInput[0].close, 102);
        assert.equal(state.replayInput[0].volume, 0);
        assert.equal(state.replayTimeframe, '1h');
      }
    });
  } finally {
    await stopApp(server);
  }

  assert.deepEqual(urls.map(url => new URL(url).searchParams.get('days')), [
    '30', '30', '30', '30', '10000',
  ]);
});

test('replay fallback with no rows returns the exact 404 contract', async () => {
  const server = await startApp({});

  try {
    const result = await withFetchMock(async () => ({
      ok: true,
      async json() { return []; },
    }), () => request(server, {
      path: '/api/strategy/replay',
      headers: replayHeaders,
    }));

    assert.equal(result.statusCode, 404);
    assert.deepEqual(result.json(), { error: 'No candle data available for replay' });
  } finally {
    await stopApp(server);
  }
});

test('replay engine unavailable returns the exact 503 contract', async () => {
  const server = await startApp({ strategyReplayEngine: null });

  try {
    const result = await request(server, {
      path: '/api/strategy/replay',
      headers: replayHeaders,
    });

    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.json(), { error: 'Strategy replay engine not available' });
  } finally {
    await stopApp(server);
  }
});

test('replay runtime failures remain generic and are logged without leakage', async () => {
  const state = {
    candles: [replayCandle()],
    strategyReplayEngine: {
      run() {
        throw new Error('secret replay failure /internal/path');
      },
    },
  };
  const server = await startApp(state);

  try {
    const result = await request(server, {
      path: '/api/strategy/replay',
      headers: replayHeaders,
    });

    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(result.text.includes('secret replay failure'), false);
    assert.equal(result.text.includes('/internal/path'), false);
    assert.equal(result.text.includes('Error:'), false);
    assert.ok(state.errors.some(entry => (
      entry.module === 'ErrorBoundary'
        && entry.data.path === '/api/strategy/replay'
        && entry.data.status === 500
        && entry.data.category === 'unhandled'
    )));
  } finally {
    await stopApp(server);
  }
});

test('replay authentication preserves missing and invalid API-key contracts', async () => {
  const missingServer = await startApp({});
  try {
    const result = await request(missingServer, { path: '/api/strategy/replay' });
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), {
      error: 'Authentication required',
      message: 'Missing X-API-Key header',
    });
  } finally {
    await stopApp(missingServer);
  }

  const invalidServer = await startApp({});
  try {
    const result = await request(invalidServer, {
      path: '/api/strategy/replay',
      headers: { 'x-api-key': 'wrong-key' },
    });
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), {
      error: 'Authentication required',
      message: 'Invalid API key',
    });
  } finally {
    await stopApp(invalidServer);
  }
});

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

test('async replay rejection before response returns a generic JSON 500', async () => {
  const server = await startApp({});
  try {
    const result = await withFetchMock(async () => {
      throw new Error('secret fetch failure /repository/backend/server.js:456');
    }, () => request(server, {
      path: '/api/strategy/replay?timeframe=1h&days=1',
      headers: { 'x-api-key': API_KEY },
    }));

    assert.equal(result.statusCode, 500);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(result.text.includes('secret fetch failure'), false);
    assert.equal(result.text.includes('<html'), false);

    const health = await request(server, { path: '/api/status' });
    assert.equal(health.statusCode, 200);
  } finally {
    await stopApp(server);
  }
});

test('async replay rejection after awaited fallback work returns a generic JSON 500', async () => {
  const server = await startApp({});
  try {
    const result = await withFetchMock(async () => ({
      ok: true,
      async json() {
        await new Promise(resolve => setImmediate(resolve));
        throw new Error('secret parser failure /repository/backend/src/routes/routes.js:789');
      },
    }), () => request(server, {
      path: '/api/strategy/replay?timeframe=1h&days=1',
      headers: { 'x-api-key': API_KEY },
    }));

    assert.equal(result.statusCode, 500);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(result.text.includes('secret parser failure'), false);
    assert.equal(result.text.includes('routes.js'), false);

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
