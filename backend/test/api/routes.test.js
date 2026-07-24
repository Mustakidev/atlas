const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter } = require('../../src/routes/routes');
const { cloneFixture, validMarketSnapshot } = require('../fixtures/market');

function responseHarness(resolve, reject) {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    end(body) { resolve({ statusCode: this.statusCode, body }); },
  };
}

function request(method, path, query = {}) {
  return { method, url: path, originalUrl: path, path, query, body: {}, headers: {}, ip: '127.0.0.1' };
}

function baseDeps(overrides = {}) {
  const snapshot = cloneFixture(validMarketSnapshot());
  return {
    apiManager: {
      isConnected: () => true,
      getHealth: () => ({ connected: true, consecutiveFailures: 0, lastFetchTime: snapshot.timestamp }),
    },
    history: {
      latest: () => cloneFixture(snapshot),
      last: () => [cloneFixture(snapshot)],
      size: () => 1,
    },
    cache: { getAge: () => 100 },
    analyzer: { getAnalysis: () => null },
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => [],
      getActive: () => null,
    },
    logger: { getLogs: () => [], info() {}, warn() {}, error() {}, system() {} },
    config: {
      getAll: () => ({ PORT: 3000, REFRESH_INTERVAL: 2000, CACHE_TTL: 30000, MAX_HISTORY: 500, LOG_LEVEL: 'INFO', REQUEST_TIMEOUT: 10000, MAX_RETRIES: 5, INITIAL_BACKOFF: 1000 }),
      get: () => 'BTCUSDT',
    },
    eventBus: {},
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
    },
    riskEngine: null,
    strategyReplayEngine: null,
    regimeEngine: null,
    regimeDecisionEngine: null,
    advanceRiskEngine: null,
    mtfConfirmationEngine: null,
    symbol: 'BTCUSDT',
    getLastDecision: () => null,
    getPipelineHealth: () => ({ pipelineCycleCount: 0, pipelineErrors: 0, lastPipelineError: null, lastSuccessfulCycle: null }),
    ...overrides,
  };
}

async function dispatch(path, query, overrides = {}) {
  const router = createRouter(baseDeps(overrides));
  return new Promise((resolve, reject) => {
    const res = responseHarness(resolve, reject);
    router.handle(request('GET', path, query), res, reject);
  });
}

test('GET /api/market returns the current market contract', async () => {
  const result = await dispatch('/market');

  assert.equal(result.statusCode, 200);
  assert.equal(typeof result.body.connected, 'boolean');
  for (const key of ['symbol', 'price', 'timestamp']) {
    assert.ok(Object.hasOwn(result.body, key), `market response missing ${key}`);
  }
  assert.equal(typeof result.body.price, 'number');
  assert.equal(typeof result.body.timestamp, 'string');
});

test('GET /api/status returns health and pipeline fields', async () => {
  const result = await dispatch('/status');

  assert.equal(result.statusCode, 200);
  assert.equal(typeof result.body.version, 'string');
  assert.equal(typeof result.body.uptime, 'number');
  assert.equal(typeof result.body.historySize, 'number');
  assert.ok(Object.hasOwn(result.body, 'connected'));
  assert.ok(Object.hasOwn(result.body, 'pipeline'));
});

test('GET /api/signal/inspector returns the no-decision fallback', async () => {
  const result = await dispatch('/signal/inspector');

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    available: false,
    message: 'No decision data yet — waiting for first pipeline cycle',
  });
});

test('GET /api/signal/inspector returns an available decision shape', async () => {
  const result = await dispatch('/signal/inspector', {}, {
    getLastDecision: () => ({ price: 100, gates: {}, verdict: { tradeOpened: false, rejectionReason: 'blocked' } }),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.available, true);
  assert.equal(result.body.price, 100);
  assert.equal(result.body.verdict.rejectionReason, 'blocked');
});

test('GET /api/paper-trades returns aggregate trade fields', async () => {
  const result = await dispatch('/paper-trades');

  assert.equal(result.statusCode, 200);
  for (const key of ['open', 'closed', 'stats', 'performance', 'balance']) {
    assert.ok(Object.hasOwn(result.body, key), `paper-trades response missing ${key}`);
  }
  assert.ok(Array.isArray(result.body.open));
  assert.ok(Array.isArray(result.body.closed));
  assert.equal(typeof result.body.balance, 'number');
});

test('GET /api/candles returns timeframe and candle collections', async () => {
  const candles = [{ open: 100, high: 102, low: 98, close: 101, openTime: 1704067200000 }];
  const result = await dispatch('/candles', { timeframe: '1h', limit: '10' }, {
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => cloneFixture(candles),
      getActive: () => null,
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.timeframe, '1h');
  assert.equal(result.body.count, 1);
  assert.ok(Array.isArray(result.body.candles));
  assert.equal(result.body.candles[0].close, 101);
});

test('invalid entryPrice is rejected by query sanitization', async () => {
  const result = await dispatch('/risk', { entryPrice: 'not-a-number' });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'entryPrice must be a positive number');
});

test('indicator route preserves per-indicator engine failure fallback', async () => {
  const result = await dispatch('/indicators', {}, {
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => [{ close: 100 }],
      getActive: () => null,
    },
    indicatorRegistry: {
      has: () => false,
      getNames: () => ['Broken'],
      calculateAll: () => ({ Broken: { result: { value: null, signal: 'Error', error: 'deterministic failure' } } }),
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.indicators.Broken.result.signal, 'Error');
  assert.equal(result.body.indicators.Broken.result.error, 'deterministic failure');
});

test('GET /api/validation preserves the cached result contract and rerun flag', async () => {
  const calls = [];
  const validationResult = {
    timestamp: '2024-01-01T00:00:00.000Z',
    overall: 'PASS',
    engines: {},
    details: {},
    engineVersion: '1.0.0',
    lastUpdated: '2024-01-01T00:00:00.000Z',
    calculationTime: 1,
    dataSource: 'Isolated synthetic datasets (never production data)',
  };
  const validationEngine = {
    runAll(forceRerun) {
      calls.push(forceRerun);
      return validationResult;
    },
  };

  const cached = await dispatch('/validation', {}, { validationEngine });
  const rerun = await dispatch('/validation', { rerun: 'true' }, { validationEngine });

  assert.equal(cached.statusCode, 200);
  assert.strictEqual(cached.body, validationResult);
  assert.equal(rerun.statusCode, 200);
  assert.strictEqual(rerun.body, validationResult);
  assert.deepEqual(calls, [false, true]);
});

test('GET /api/validation returns 503 when the engine is unavailable', async () => {
  const result = await dispatch('/validation');

  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error, 'Validation engine not available');
});
