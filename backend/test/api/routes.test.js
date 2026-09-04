const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter } = require('../../src/routes/routes');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { cloneFixture, validMarketSnapshot } = require('../fixtures/market');

const riskLogger = { info() {}, warn() {}, error() {}, system() {} };

function riskApiDependencies() {
  const candles = [{ open: 100, high: 102, low: 98, close: 100, openTime: 1 }];
  return {
    logger: riskLogger,
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => candles,
      getActive: () => null,
    },
    atrEngine: {
      calculate: () => ({ ready: true, atr: 2, atrPercentage: 1 }),
    },
    analyzer: {
      getAnalysis: () => ({ trend: { '1H': 'Bullish' } }),
    },
    structureEngine: {
      calculate: () => ({ ready: true, direction: 'bullish', score: 80 }),
    },
    confluenceEngine: {
      calculate: () => ({ bias: 'Bullish', score: 80, confidence: 80 }),
    },
    regimeEngine: {
      calculate: () => ({ regime: 'TRENDING_BULL' }),
    },
    advanceRiskEngine: new AdvanceRiskEngine({
      logger: riskLogger,
      symbol: 'BTCUSDT',
      paperTradeEngine: null,
      config: {},
    }),
  };
}

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

function request(method, path, query = {}, body = {}) {
  return { method, url: path, originalUrl: path, path, query, body, headers: {}, ip: '127.0.0.1' };
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
  return dispatchRequest('GET', path, query, {}, overrides);
}

async function dispatchRequest(method, path, query = {}, body = {}, overrides = {}) {
  const router = createRouter(baseDeps(overrides));
  return new Promise((resolve, reject) => {
    const res = responseHarness(resolve, reject);
    router.handle(request(method, path, query, body), res, reject);
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
  const result = await dispatch('/advance-risk', { entryPrice: 'not-a-number' });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'entryPrice must be a positive number');
});

test('GET /api/advance-risk returns the canonical execution-plan contract', async () => {
  const result = await dispatch('/advance-risk', { entryPrice: '100', direction: 'BUY' }, riskApiDependencies());

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.engineVersion, '2.0.0');
  assert.equal(result.body.tradeAllowed, true);
  assert.equal(result.body.stopLoss, 96);
  assert.equal(result.body.takeProfit, 112);
  assert.equal(result.body.riskReward, 3);
  assert.equal(result.body.positionSize, 25);
  assert.equal(result.body.accountBalance, 10000);
  assert.equal(result.body.riskPerTradePct, 1);
  assert.equal(result.body.regime, 'TRENDING_BULL');
  assert.ok(['ASIAN', 'LONDON', 'NEW_YORK'].includes(result.body.session));
  assert.equal(result.body.dailyPnL, 0);
  assert.equal(result.body.dailyDrawdownPct, 0);
  assert.equal(result.body.consecutiveLosses, 0);
  assert.equal(result.body.rejectionReason, null);
  assert.equal(Object.hasOwn(result.body, 'positionSize'), true);
});

test('GET /api/advance-risk/state returns live AdvanceRisk state', async () => {
  const dependencies = riskApiDependencies();
  const before = dependencies.advanceRiskEngine.getState();
  const result = await dispatch('/advance-risk/state', {}, dependencies);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.available, true);
  for (const field of [
    'accountBalance', 'riskPerTradePct', 'dailyPnL', 'dailyDrawdownPct',
    'maxDailyLossPct', 'maxDailyDrawdownPct', 'consecutiveLosses',
    'maxConsecutiveLosses', 'dailyLossLimitReached', 'tradingEnabled',
    'session', 'sessionMultipliers', 'atrMultTrending', 'atrMultRanging',
    'rrTrending', 'rrRanging', 'lastUpdated',
  ]) {
    assert.equal(Object.hasOwn(result.body, field), true, `state missing ${field}`);
    assert.deepEqual(result.body[field], before[field], `state changed unexpectedly for ${field}`);
  }
  assert.equal(Object.hasOwn(result.body, 'riskReward'), false);
  assert.equal(Object.hasOwn(result.body, 'stopLoss'), false);
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

test('optional coordinator delays committed paper reads until the write settles', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const commitCoordinator = {
    readCommitted(read) {
      return gate.then(read);
    },
  };

  let settled = false;
  const pending = dispatch('/paper-trades', {}, { commitCoordinator }).then(result => {
    settled = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  assert.equal((await pending).statusCode, 200);
});

test('optional coordinator maps unsafe committed reads to durability unavailable', async () => {
  const commitCoordinator = {
    readCommitted() {
      const error = new Error('unsafe');
      error.code = 'LIVE_STATE_DURABILITY_UNAVAILABLE';
      return Promise.reject(error);
    },
  };

  const result = await dispatch('/paper-trades', {}, { commitCoordinator });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, { error: 'Live state durability unavailable' });
});

test('optional coordinator wraps AdvanceRisk lazy-reset reads as mutations', async () => {
  const calls = [];
  const commitCoordinator = {
    runMutation({ name, mutate }) {
      calls.push(name);
      return Promise.resolve(mutate());
    },
  };

  const result = await dispatch('/advance-risk/state', {}, {
    ...riskApiDependencies(),
    commitCoordinator,
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ['advance-risk-state']);
});

test('optional coordinator makes manual close wait and includes risk synchronization', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const closed = { tradeId: 'PT-1', status: 'CLOSED', pnl: 25, exitTime: '2024-01-01T00:00:00.000Z' };
  const commitCoordinator = {
    runMutation({ name, mutate }) {
      calls.push(name);
      const result = mutate();
      return gate.then(() => result);
    },
  };
  const result = await new Promise((resolve, reject) => {
    const router = createRouter(baseDeps({
      commitCoordinator,
      paperTradeEngine: { close: () => closed },
      advanceRiskEngine: { onTradeClosed: (pnl, context) => calls.push(['risk', pnl, context]) },
    }));
    const res = responseHarness(resolve, reject);
    router.handle(request('POST', '/paper-trades/close', {}, { tradeId: 'PT-1' }), res, reject);
    setImmediate(() => {
      assert.deepEqual(calls[0], 'manual-close');
      assert.deepEqual(calls[1][0], 'risk');
      release();
    });
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.tradeId, 'PT-1');
});

test('optional coordinator maps manual-close persistence failure to 503', async () => {
  const commitCoordinator = {
    runMutation({ mutate }) {
      mutate();
      const error = new Error('write failed');
      error.code = 'LIVE_STATE_DURABILITY_UNAVAILABLE';
      return Promise.reject(error);
    },
  };
  const result = await dispatchRequest('POST', '/paper-trades/close', {}, { tradeId: 'PT-1' }, {
    commitCoordinator,
    paperTradeEngine: { close: () => ({ tradeId: 'PT-1', status: 'CLOSED', pnl: 25, exitTime: '2024-01-01T00:00:00.000Z' }) },
    advanceRiskEngine: { onTradeClosed() {} },
  });

  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, { error: 'Live state durability unavailable' });
});
