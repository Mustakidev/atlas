const test = require('node:test');
const assert = require('node:assert/strict');

const applicationModule = require('../../src/application/productionReplayApplication');
const {
  createProductionReplayApplication,
  ProductionReplayApplicationError,
} = applicationModule;
const { ProductionReplayMtfSource } = require('../../src/engine/productionReplayMtfSource');
const { ProductionReplayAnalyzerSource } = require('../../src/engine/productionReplayAnalyzerSource');
const { CoinGeckoHistoricalAnalyzerClient } = require('../../src/network/coingeckoHistoricalAnalyzerClient');
const { normalizeReplayInput } = require('../../src/engine/replayInput');
const {
  normalizeReplayAnalyzerInput,
} = require('../../src/engine/replayAnalyzerInput');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');
const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { createReplayPipelineRunner } = require('../../src/engine/replayPipelineRunner');
const { createAbortError } = require('../../src/core/cancellation');

const HOUR_MS = REPLAY_MTF_DURATIONS_MS['1h'];
const DAY_MS = 86_400_000;
const MAX_HORIZON_MS = 99 * DAY_MS - HOUR_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;
const BASE_TIME = Date.parse('2026-01-10T00:00:00.000Z');
const PRIMARY_COUNT = 51;
const END_TIME = BASE_TIME + PRIMARY_COUNT * HOUR_MS;
const SYMBOL = 'BTCUSDT';
const COIN_ID = 'bitcoin';
const VS_CURRENCY = 'usd';
const DIAGNOSTIC_KEYS = new Set([
  'analyzedAt',
  'calculatedAt',
  'lastUpdated',
  'calculationTime',
  'analysisTime',
  'executionTime',
]);
const EXPECTED_REPLAY_KEYS = [
  'cycles',
  'runnerState',
  'trades',
  'stats',
  'performance',
  'risk',
];
const EXPECTED_CYCLE_KEYS = ['index', 'openTime', 'timestamp', 'price', 'decision'];
const EXPECTED_DECISION_KEYS = [
  'timestamp',
  'cycle',
  'price',
  'timeframe',
  'confluence',
  'thresholds',
  'gates',
  'engines',
  'marketRegime',
  'risk',
  'verdict',
  'regimeDecision',
  'mtfConfirmation',
];
const EXPECTED_TRADE_KEYS = [
  'tradeId',
  'symbol',
  'timeframe',
  'direction',
  'entryPrice',
  'entryTime',
  'stopLoss',
  'takeProfit',
  'riskReward',
  'positionSize',
  'currentPrice',
  'status',
  'exitPrice',
  'exitTime',
  'exitReason',
  'duration',
  'pnl',
  'pnlPercent',
  'confidence',
  'reason',
  'timestamp',
];
const EXPECTED_STATS_KEYS = [
  'totalTrades',
  'openTrades',
  'closedTrades',
  'pendingTrades',
  'winRate',
  'lossRate',
  'breakevenRate',
  'totalPnl',
  'totalPnlPercent',
  'averagePnl',
  'averagePnlPercent',
  'grossProfit',
  'grossLoss',
  'profitFactor',
  'netReturnPct',
  'expectancy',
  'expectancyRatio',
  'rewardRisk',
  'averageWin',
  'averageLoss',
  'averageDuration',
  'maxWin',
  'maxLoss',
  'largestWin',
  'largestLoss',
  'maxDrawdown',
  'maxDrawdownPct',
  'maxConsecutiveWins',
  'maxConsecutiveLosses',
  'currentStreak',
  'currentStreakType',
  'balance',
  'initialBalance',
  'byDirection',
  'byTimeframe',
  'byExitReason',
];
const EXPECTED_PERFORMANCE_KEYS = [
  'profitFactor',
  'expectancy',
  'expectancyRatio',
  'maxDrawdown',
  'maxDrawdownPct',
  'largestWin',
  'largestLoss',
  'avgConsecutiveWins',
  'avgConsecutiveLosses',
  'currentStreak',
  'currentStreakType',
  'totalPnl',
  'netReturnPct',
  'sharpeRatio',
  'sortinoRatio',
];
const EXPECTED_RISK_KEYS = [
  'accountBalance',
  'riskPerTradePct',
  'dailyPnL',
  'dailyDrawdownPct',
  'maxDailyLossPct',
  'maxDailyDrawdownPct',
  'consecutiveLosses',
  'maxConsecutiveLosses',
  'lossPauseRemainingMs',
  'dailyLossLimitReached',
  'tradingEnabled',
  'session',
  'sessionMultipliers',
  'atrMultTrending',
  'atrMultRanging',
  'rrTrending',
  'rrRanging',
];

const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    if (key === 'MAX_HISTORY') return 500;
    return undefined;
  },
};

function makeRiskPolicySource() {
  return {
    getPolicy() {
      return {
        accountBalance: 10000,
        riskPerTradePct: 1,
        atrMultTrending: 2,
        atrMultRanging: 1.5,
        rrTrending: 3,
        rrRanging: 1.8,
        maxDailyLossPct: 5,
        maxDailyDrawdownPct: 10,
        maxConsecutiveLosses: 3,
        cooldownMs: 3600000,
        sessionMultipliers: { ASIAN: 1, LONDON: 1, NEW_YORK: 1 },
      };
    },
  };
}

function makeClock() {
  let monotonic = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => monotonic++,
  };
}

function makeBinanceClient({ shortPrimary = false, error, calls }) {
  return {
    async fetchCandles(request, options) {
      const call = { ...request };
      if (options !== undefined) call.options = options;
      calls.push(call);
      if (error) throw error;
      const duration = REPLAY_MTF_DURATIONS_MS[request.timeframe];
      const requestedCount = (request.endTime - request.startTime) / duration;
      const count = shortPrimary && request.timeframe === '1h'
        ? requestedCount - 1
        : requestedCount;
      const candles = Array.from({ length: count }, (_, index) => {
        const openTime = request.startTime + index * duration;
        const open = 100 + index;
        return {
          openTime,
          open,
          high: open + 1,
          low: open - 1,
          close: open + 0.5,
          volume: 100 + index,
        };
      });
      return {
        candles,
        diagnostics: {
          provider: 'binance-spot-klines',
          symbol: request.symbol,
          timeframe: request.timeframe,
          startTime: request.startTime,
          endTime: request.endTime,
          candleCount: candles.length,
          firstOpenTime: candles[0]?.openTime,
          lastOpenTime: candles.at(-1)?.openTime,
        },
      };
    },
  };
}

function makeCoinGeckoPayload(startTime = BASE_TIME, endTime = END_TIME + HOUR_MS) {
  const acquisitionStart = startTime - DAY_MS;
  const count = (endTime - acquisitionStart) / HOUR_MS + 1;
  return {
    prices: Array.from({ length: count }, (_, index) => [
      acquisitionStart + index * HOUR_MS,
      1_000 + index * 2,
    ]),
    total_volumes: Array.from({ length: count }, (_, index) => [
      acquisitionStart + index * HOUR_MS,
      10_000 + index,
    ]),
  };
}

function makeCoinGeckoClient({ error, calls, payload } = {}) {
  return new CoinGeckoHistoricalAnalyzerClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (error) throw error;
      return {
        status: 200,
        async json() {
          return payload ?? makeCoinGeckoPayload();
        },
      };
    },
    logger,
    config: {
      baseUrl: 'https://provider.example.test/api/v3',
      apiKey: 'test-demo-key',
      coinId: COIN_ID,
      vsCurrency: VS_CURRENCY,
      timeout: 3210,
    },
  });
}

function makeProductionSources({
  shortPrimary = false,
  mtfError,
  analyzerError,
  mutateMtfResult,
  mutateAnalyzerResult,
} = {}) {
  const mtfCalls = [];
  const analyzerSourceCalls = [];
  const analyzerClientCalls = [];
  const order = [];
  const observed = { mtfResult: null, analyzerResult: null };
  const realMtfSource = new ProductionReplayMtfSource({
    client: makeBinanceClient({ shortPrimary, error: mtfError, calls: mtfCalls }),
  });
  const realAnalyzerSource = new ProductionReplayAnalyzerSource({
    client: makeCoinGeckoClient({ error: analyzerError, calls: analyzerClientCalls }),
    symbol: SYMBOL,
    coinId: COIN_ID,
    vsCurrency: VS_CURRENCY,
  });

  const mtfSource = {
    async fetch(request, options) {
      order.push('mtf');
      const result = options === undefined
        ? await realMtfSource.fetch(request)
        : await realMtfSource.fetch(request, options);
      observed.mtfResult = result;
      return mutateMtfResult ? mutateMtfResult(result) : result;
    },
  };
  const analyzerSource = {
    async fetch(request, options) {
      order.push('analyzer');
      const call = { ...request };
      if (options !== undefined) call.options = options;
      analyzerSourceCalls.push(call);
      const result = options === undefined
        ? await realAnalyzerSource.fetch(request)
        : await realAnalyzerSource.fetch(request, options);
      observed.analyzerResult = result;
      return mutateAnalyzerResult ? mutateAnalyzerResult(result) : result;
    },
  };

  return {
    mtfSource,
    analyzerSource,
    mtfCalls,
    analyzerSourceCalls,
    analyzerClientCalls,
    order,
    observed,
  };
}

function makeApplication(options = {}) {
  const sources = makeProductionSources(options);
  return {
    ...sources,
    application: createProductionReplayApplication({
      mtfSource: sources.mtfSource,
      analyzerSource: sources.analyzerSource,
      logger,
      config,
      clock: makeClock(),
      riskPolicySource: options.riskPolicySource || makeRiskPolicySource(),
    }),
  };
}

function request(startTime = BASE_TIME, endTime = END_TIME) {
  return { symbol: SYMBOL, startTime, endTime };
}

async function runQuietly(operation) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await operation();
  } finally {
    console.log = originalLog;
  }
}

function assertAppError(error, code, details = {}) {
  assert.ok(error instanceof ProductionReplayApplicationError);
  assert.equal(error.code, code);
  for (const [key, value] of Object.entries(details)) assert.equal(error[key], value);
  return true;
}

async function assertAppRejects(operation, code, details = {}) {
  await assert.rejects(operation, error => assertAppError(error, code, details));
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

function assertNoDiagnostics(value, path = '$', seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(DIAGNOSTIC_KEYS.has(key), false, `${path}.${key}`);
    assertNoDiagnostics(nested, `${path}.${key}`, seen);
  }
}

function makeCanonicalBundle(observed) {
  const normalizedMtfInput = normalizeReplayMultiTimeframeInput(observed.mtfResult.rawInput);
  const normalizedInput = normalizeReplayInput(normalizedMtfInput.timeframes['1h'], '1h');
  const dependencies = createReplayDependencies({
    logger,
    symbol: SYMBOL,
    config,
    normalizedInput,
    normalizedMtfInput,
    analyzerInput: observed.analyzerResult.analyzerInput,
    clock: makeClock(),
  });
  const runner = createReplayPipelineRunner({ dependencies, normalizedInput });
  return { normalizedMtfInput, normalizedInput, dependencies, runner };
}

function runCanonicalBundle(bundle, observeBoundaries = false) {
  const observations = [];
  const midpoint = Math.floor(PRIMARY_COUNT / 2);
  while (bundle.runner.hasNext()) {
    const result = bundle.runner.runNextCycle();
    if (observeBoundaries && [0, midpoint, PRIMARY_COUNT - 1].includes(result.index)) {
      observations.push({
        index: result.index,
        boundaryTime: Date.parse(result.timestamp),
        analyzerEventTime: bundle.dependencies.analyzerHistory.getEventTimestamp(),
      });
    }
  }
  return observations;
}

function cloneAnalyzerResultWithSnapshots(sourceResult, snapshots) {
  return {
    analyzerInput: normalizeReplayAnalyzerInput({
      schemaVersion: 1,
      symbol: SYMBOL,
      snapshots,
    }),
    provenance: { ...sourceResult.provenance },
  };
}

function withRunnerFactoryStub(stub, operation) {
  const runnerModulePath = require.resolve('../../src/engine/replayPipelineRunner');
  const applicationPath = require.resolve('../../src/application/productionReplayApplication');
  const runnerModule = require(runnerModulePath);
  const originalRunnerFactory = runnerModule.createReplayPipelineRunner;
  runnerModule.createReplayPipelineRunner = stub;
  delete require.cache[applicationPath];
  try {
    return operation(require(applicationPath));
  } finally {
    runnerModule.createReplayPipelineRunner = originalRunnerFactory;
    delete require.cache[applicationPath];
  }
}

test('exports only the locked factory and error, and returns a one-method frozen application', () => {
  assert.deepEqual(Object.keys(applicationModule), [
    'createProductionReplayApplication',
    'ProductionReplayApplicationError',
  ]);

  const { application } = makeApplication();
  assert.deepEqual(Object.keys(application), ['run']);
  assert.equal(Object.isFrozen(application), true);
  assert.equal(typeof application.run, 'function');
});

test('validates factory dependencies against the existing canonical interfaces', () => {
  const valid = makeApplication();
  const cases = [
    ['mtfSource', { mtfSource: null }],
    ['analyzerSource', { analyzerSource: null }],
    ['logger', { logger: {} }],
    ['config', { config: {} }],
    ['clock', { clock: {} }],
    ['riskPolicySource', { riskPolicySource: {} }],
    ['riskPolicySource', { riskPolicySource: undefined }],
  ];

  for (const [label, overrides] of cases) {
    const value = key => Object.hasOwn(overrides, key) ? overrides[key] : {
      mtfSource: valid.mtfSource,
      analyzerSource: valid.analyzerSource,
      logger,
      config,
      clock: makeClock(),
      riskPolicySource: makeRiskPolicySource(),
    }[key];
    assert.throws(() => createProductionReplayApplication({
      mtfSource: value('mtfSource'),
      analyzerSource: value('analyzerSource'),
      logger: value('logger'),
      config: value('config'),
      clock: value('clock'),
      riskPolicySource: value('riskPolicySource'),
    }), error => error instanceof TypeError && error.message.includes(label));
  }
});

test('runs the real no-network A1H1/A1H2 production chain and returns exact projections', async () => {
  const setup = makeApplication();
  const originalRequest = request();
  const result = await runQuietly(() => setup.application.run(originalRequest));

  assert.deepEqual(Object.keys(result), ['replay', 'provenance']);
  assert.deepEqual(Object.keys(result.replay), EXPECTED_REPLAY_KEYS);
  assert.deepEqual(Object.keys(result.replay.runnerState), ['status', 'cycleCount', 'failure']);
  assert.equal(Object.hasOwn(result.replay.runnerState, 'lastResult'), false);
  assert.deepEqual(Object.keys(result.replay.stats), EXPECTED_STATS_KEYS);
  assert.deepEqual(Object.keys(result.replay.performance), EXPECTED_PERFORMANCE_KEYS);
  assert.deepEqual(Object.keys(result.replay.risk), EXPECTED_RISK_KEYS);
  assert.equal(Object.hasOwn(result.replay.risk, 'lastUpdated'), false);

  assert.equal(setup.mtfCalls.length, 4);
  assert.deepEqual(setup.order, ['mtf', 'analyzer']);
  assert.deepEqual(setup.mtfCalls.map(call => call.timeframe), ['1m', '5m', '15m', '1h']);
  assert.ok(setup.mtfCalls.every(call =>
    call.symbol === SYMBOL && call.startTime === BASE_TIME && call.endTime === END_TIME));
  assert.equal(setup.analyzerClientCalls.length, 1);
  assert.deepEqual(setup.analyzerSourceCalls, [{
    symbol: SYMBOL,
    startTime: BASE_TIME,
    endTime: END_TIME + HOUR_MS,
  }]);
  const analyzerUrl = new URL(setup.analyzerClientCalls[0].url);
  assert.equal(analyzerUrl.searchParams.get('to'), String((END_TIME + HOUR_MS) / 1000));

  assert.equal(result.replay.cycles.length, PRIMARY_COUNT);
  assert.equal(result.replay.runnerState.status, 'EXHAUSTED');
  assert.equal(result.replay.runnerState.cycleCount, PRIMARY_COUNT);
  assert.equal(result.replay.runnerState.failure, null);
  assert.equal(result.replay.cycles.at(-1).timestamp, new Date(END_TIME).toISOString());
  assert.equal(result.replay.cycles.at(-1).openTime, END_TIME - HOUR_MS);
  assert.deepEqual(Object.keys(result.replay.cycles[0]), EXPECTED_CYCLE_KEYS);
  assert.deepEqual(Object.keys(result.replay.cycles[0].decision), EXPECTED_DECISION_KEYS);
  assert.equal(result.replay.cycles[0].decision.regimeDecision, null);
  assert.equal(result.replay.cycles[0].decision.mtfConfirmation === null
    || typeof result.replay.cycles[0].decision.mtfConfirmation === 'object', true);

  assert.deepEqual(Object.keys(result.provenance), [
    'sourceType',
    'semanticMode',
    'symbol',
    'startTime',
    'endTime',
    'primaryTimeframe',
    'mtf',
    'analyzer',
  ]);
  assert.equal(result.provenance.sourceType, 'production-replay-application');
  assert.equal(result.provenance.semanticMode, 'historical-equivalent');
  assert.equal(result.provenance.mtf.requestedEndTime, END_TIME);
  assert.equal(result.provenance.analyzer.requestedEndTime, END_TIME + HOUR_MS);
  assert.notStrictEqual(result.provenance.mtf, setup.observed.mtfResult.provenance);
  assert.notStrictEqual(result.provenance.analyzer, setup.observed.analyzerResult.provenance);
  assert.equal(Object.isFrozen(setup.observed.mtfResult.rawInput), false);
  assert.equal(Object.isFrozen(setup.observed.mtfResult.provenance), false);
  assert.deepEqual(originalRequest, request());
  assert.equal(Object.hasOwn(result, 'request'), false);
  assertNoDiagnostics(result);
  assertDeepFrozen(result);
  assert.equal(setup.observed.mtfResult.rawInput[Symbol.for('APP_MUTATION_CHECK')] ?? null, null);
});

test('Replay composition suppresses direct pipeline console output', async () => {
  const setup = makeApplication();
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args);
  try {
    await setup.application.run(request());
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(output, []);
});

test('limits timestamp stripping to canonical MTF confirmation output', async () => {
  const provenanceTimestamp = '2026-01-10T00:00:00.000Z';
  const setup = makeApplication({
    mutateMtfResult: result => ({
      ...result,
      provenance: {
        ...result.provenance,
        timestamp: provenanceTimestamp,
      },
    }),
  });
  const result = await runQuietly(() => setup.application.run(request()));
  const confirmedCycle = result.replay.cycles.find(cycle => cycle.decision.mtfConfirmation);

  assert.ok(confirmedCycle);
  assert.equal(Object.hasOwn(confirmedCycle.decision.mtfConfirmation, 'timestamp'), false);
  assert.equal(result.provenance.mtf.timestamp, provenanceTimestamp);
  assert.equal(result.replay.cycles[0].timestamp, new Date(BASE_TIME + HOUR_MS).toISOString());
});

test('preserves semantic trade timestamps in APP-owned projections', async () => {
  const trade = {
    tradeId: 'synthetic-trade',
    symbol: SYMBOL,
    timeframe: '1h',
    direction: 'BUY',
    entryPrice: 100,
    entryTime: '2026-01-10T00:00:00.000Z',
    stopLoss: 90,
    takeProfit: 120,
    riskReward: 2,
    positionSize: 1,
    currentPrice: 110,
    status: 'CLOSED',
    exitPrice: 110,
    exitTime: '2026-01-10T01:00:00.000Z',
    exitReason: 'Synthetic test',
    duration: 3_600_000,
    pnl: 10,
    pnlPercent: 10,
    confidence: 80,
    reason: 'Synthetic test',
    timestamp: '2026-01-10T01:00:00.000Z',
  };

  await withRunnerFactoryStub(({ dependencies }) => {
    dependencies.paperTradeEngine.all = () => [trade];
    return {
      hasNext: () => false,
      runNextCycle: () => { throw new Error('not reached'); },
      getState: () => ({ status: 'EXHAUSTED', cycleCount: PRIMARY_COUNT, failure: null }),
    };
  }, async freshModule => {
    const setup = makeApplication();
    const application = freshModule.createProductionReplayApplication({
      mtfSource: setup.mtfSource,
      analyzerSource: setup.analyzerSource,
      logger,
      config,
      clock: makeClock(),
      riskPolicySource: makeRiskPolicySource(),
    });
    const result = await runQuietly(() => application.run(request()));
    assert.equal(result.replay.trades[0].timestamp, trade.timestamp);
    assert.equal(result.replay.trades[0].entryTime, trade.entryTime);
    assert.equal(result.replay.trades[0].exitTime, trade.exitTime);
  });
});

test('certifies real 1m/5m/15m/1h counts, indexed time, causal boundaries, and terminal EOD state', async () => {
  const setup = makeApplication();
  const result = await runQuietly(() => setup.application.run(request()));
  const bundle = makeCanonicalBundle(setup.observed);
  const finalPrimary = bundle.normalizedMtfInput.timeframes['1h'].at(-1);

  assert.equal(bundle.normalizedMtfInput.timeframes['1m'].length, 3060);
  assert.equal(bundle.normalizedMtfInput.timeframes['5m'].length, 612);
  assert.equal(bundle.normalizedMtfInput.timeframes['15m'].length, 204);
  assert.equal(bundle.normalizedMtfInput.timeframes['1h'].length, 51);
  assert.equal(finalPrimary.openTime, END_TIME - HOUR_MS);
  assert.equal(finalPrimary.closeTime, END_TIME);
  assert.equal(setup.observed.analyzerResult.analyzerInput.snapshots.length, 52);
  for (let index = 0; index < PRIMARY_COUNT; index += 1) {
    assert.equal(
      Date.parse(setup.observed.analyzerResult.analyzerInput.snapshots[index].timestamp),
      bundle.normalizedMtfInput.timeframes['1h'][index].openTime,
    );
  }
  assert.equal(
    Date.parse(setup.observed.analyzerResult.analyzerInput.snapshots[PRIMARY_COUNT].timestamp),
    END_TIME,
  );
  assert.equal(result.replay.cycles.length, PRIMARY_COUNT);
  assert.equal(result.replay.cycles.at(-1).openTime, END_TIME - HOUR_MS);
  assert.equal(Date.parse(result.replay.cycles.at(-1).timestamp), END_TIME);
  assert.equal(result.replay.runnerState.status, 'EXHAUSTED');
  assert.equal(result.replay.runnerState.cycleCount, PRIMARY_COUNT);
  assert.equal(result.replay.runnerState.failure, null);

  const originalLog = console.log;
  console.log = () => {};
  let observations;
  try {
    observations = runCanonicalBundle(bundle, true);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(observations.map(observation => observation.index), [0, 25, 50]);
  for (const observation of observations) {
    assert.equal(observation.analyzerEventTime <= observation.boundaryTime, true);
  }
  assert.equal(observations.at(-1).analyzerEventTime, END_TIME);
  assert.equal(bundle.dependencies.analyzerHistory.getEventTimestamp(), END_TIME);
  assert.equal(bundle.runner.getState().status, 'EXHAUSTED');
  assert.equal(bundle.runner.getState().cycleCount, PRIMARY_COUNT);
  assert.equal(bundle.runner.hasNext(), false);
  assert.throws(() => bundle.runner.runNextCycle(), error => error.code === 'NO_REMAINING_CANDLES');
  assert.deepEqual(bundle.dependencies.paperTradeEngine.open(), []);
  assert.deepEqual(bundle.dependencies.replayMtfCandleAdapter.getCandles('1m').length, 3060);
  assert.deepEqual(bundle.dependencies.replayMtfCandleAdapter.getCandles('5m').length, 612);
  assert.deepEqual(bundle.dependencies.replayMtfCandleAdapter.getCandles('15m').length, 204);
  assert.deepEqual(bundle.dependencies.candleEngine.getCandles('1h').length, 51);
  assert.strictEqual(
    bundle.dependencies.mtfEngine.candleEngine,
    bundle.dependencies.replayCandleView,
  );
  assert.equal(bundle.dependencies.replayCandleView.getCandles('1m').length, 3060);
  assert.equal(bundle.dependencies.replayCandleView.getCandles('5m').length, 612);
  assert.equal(bundle.dependencies.replayCandleView.getCandles('15m').length, 204);
  assert.equal(bundle.dependencies.replayCandleView.getCandles('1h').length, 51);
  assert.equal(bundle.dependencies.replayMtfCandleAdapter.getActive('1m'), null);
  assert.equal(bundle.dependencies.replayMtfCandleAdapter.getActive('5m'), null);
  assert.equal(bundle.dependencies.replayMtfCandleAdapter.getActive('15m'), null);
});

test('rejects invalid roots and exact-key violations before any source call', async () => {
  const cases = [
    null,
    [],
    new Date(BASE_TIME),
    new (class Request {})(),
    { ...request(), timeframe: '1h' },
    { ...request(), [Symbol('unexpected')]: true },
    { ...request(), symbol: 'btc/usdt' },
    { ...request(), startTime: '2026-01-10T00:00:00.000Z' },
    { ...request(), endTime: END_TIME + 1 },
    { ...request(), endTime: BASE_TIME },
    { ...request(), endTime: BASE_TIME + MAX_HORIZON_MS + HOUR_MS },
    request(
      MAX_DATE_MS - (MAX_DATE_MS % HOUR_MS) - 51 * HOUR_MS,
      MAX_DATE_MS - (MAX_DATE_MS % HOUR_MS),
    ),
  ];

  for (const invalidRequest of cases) {
    const setup = makeApplication();
    await assertAppRejects(() => setup.application.run(invalidRequest), 'INVALID_REQUEST');
    assert.equal(setup.mtfCalls.length, 0);
    assert.equal(setup.analyzerClientCalls.length, 0);
  }

  const nullPrototypeRequest = Object.assign(Object.create(null), request());
  const accepted = makeApplication({ mtfError: Object.assign(new Error('stop after validation'), { code: 'STOP' }) });
  await assertAppRejects(() => accepted.application.run(nullPrototypeRequest), 'MTF_SOURCE_FAILURE');
  assert.equal(accepted.mtfCalls.length, 1);
  assert.equal(accepted.analyzerClientCalls.length, 0);
});

test('accepts the exact maximum application horizon and rejects only the next hour', async () => {
  const calls = [];
  const stop = Object.assign(new Error('bounded test stop'), { code: 'BOUNDARY_STOP' });
  const application = createProductionReplayApplication({
    mtfSource: { fetch: async value => { calls.push(value); throw stop; } },
    analyzerSource: { fetch: async () => { throw new Error('not reached'); } },
    logger,
    config,
    clock: makeClock(),
    riskPolicySource: makeRiskPolicySource(),
  });
  const maxRequest = request(BASE_TIME, BASE_TIME + MAX_HORIZON_MS);
  await assertAppRejects(() => application.run(maxRequest), 'MTF_SOURCE_FAILURE');
  assert.equal(calls.length, 1);
  await assertAppRejects(
    () => application.run(request(BASE_TIME, BASE_TIME + MAX_HORIZON_MS + HOUR_MS)),
    'INVALID_REQUEST',
  );
  assert.equal(calls.length, 1);
});

test('preserves the locked failure order and exact source error identity', async () => {
  const mtfError = Object.assign(new Error('mtf down'), { code: 'PROVIDER_UNAVAILABLE', extra: 'secret' });
  const mtfCalls = [];
  const mtfFailure = createProductionReplayApplication({
    mtfSource: { fetch: async () => { mtfCalls.push(true); throw mtfError; } },
    analyzerSource: { fetch: async () => { throw new Error('not reached'); } },
    logger,
    config,
    clock: makeClock(),
    riskPolicySource: makeRiskPolicySource(),
  });
  await assertAppRejects(() => mtfFailure.run(request()), 'MTF_SOURCE_FAILURE', {
    source: 'mtf',
    phase: 'acquisition',
    originalCode: 'PROVIDER_UNAVAILABLE',
    cause: mtfError,
  });
  assert.equal(mtfCalls.length, 1);

  const validMtf = await makeApplication().mtfSource.fetch(request());
  const shortAnalyzerCalls = [];
  const shortRawInput = {
    ...validMtf.rawInput,
    timeframes: {
      ...validMtf.rawInput.timeframes,
      '1h': validMtf.rawInput.timeframes['1h'].slice(0, -1),
    },
  };
  const shortMtf = createProductionReplayApplication({
    mtfSource: { fetch: async () => ({ rawInput: shortRawInput, provenance: validMtf.provenance }) },
    analyzerSource: { fetch: async () => { shortAnalyzerCalls.push(true); } },
    logger,
    config,
    clock: makeClock(),
    riskPolicySource: makeRiskPolicySource(),
  });
  await assertAppRejects(() => shortMtf.run(request()), 'MTF_SOURCE_FAILURE', {
    source: 'mtf',
    phase: 'normalization',
    originalCode: 'INSUFFICIENT_HISTORY',
  });
  assert.equal(shortAnalyzerCalls.length, 0);

  const analyzerError = Object.assign(new Error('analyzer down'), { code: 'RATE_LIMITED' });
  const analyzerFailure = makeApplication();
  analyzerFailure.analyzerSource.fetch = async () => { throw analyzerError; };
  await assertAppRejects(() => analyzerFailure.application.run(request()), 'ANALYZER_SOURCE_FAILURE', {
    source: 'analyzer',
    phase: 'acquisition',
    originalCode: 'RATE_LIMITED',
    cause: analyzerError,
  });

  const uncoded = new Error('uncoded');
  const uncodedFailure = createProductionReplayApplication({
    mtfSource: { fetch: async () => { throw uncoded; } },
    analyzerSource: { fetch: async () => { throw new Error('not reached'); } },
    logger,
    config,
    clock: makeClock(),
    riskPolicySource: makeRiskPolicySource(),
  });
  await assert.rejects(uncodedFailure.run(request()), error => {
    assertAppError(error, 'MTF_SOURCE_FAILURE', { source: 'mtf', phase: 'acquisition', cause: uncoded });
    assert.equal(Object.hasOwn(error, 'originalCode'), false);
    assert.equal(Object.hasOwn(error, 'extra'), false);
    return true;
  });
});

test('rejects MTF composition mismatches and prevents Analyzer I/O', async () => {
  const mutations = [
    result => ({ ...result, provenance: { ...result.provenance, provider: 'other' } }),
    result => ({ ...result, provenance: { ...result.provenance, symbol: 'ETHUSDT' } }),
    result => ({ ...result, provenance: { ...result.provenance, requestedStartTime: BASE_TIME + HOUR_MS } }),
    result => ({ ...result, provenance: { ...result.provenance, requestedEndTime: END_TIME + HOUR_MS } }),
    result => ({ ...result, rawInput: { ...result.rawInput, primaryTimeframe: '5m' } }),
    result => ({ ...result, rawInput: { ...result.rawInput, sourcePolicy: 'aggregated' } }),
    result => ({ ...result, provenance: undefined }),
  ];

  for (const mutateMtfResult of mutations) {
    const setup = makeApplication({ mutateMtfResult });
    await assertAppRejects(() => setup.application.run(request()), 'SOURCE_MISMATCH', {
      source: 'mtf',
      phase: 'composition',
    });
    assert.equal(setup.analyzerClientCalls.length, 0);
  }
});

test('rejects Analyzer composition mismatches and indexed temporal violations', async () => {
  const provenanceMutations = [
    result => ({ ...result, provenance: { ...result.provenance, sourceType: 'wrong' } }),
    result => ({ ...result, provenance: { ...result.provenance, semanticMode: 'live' } }),
    result => ({ ...result, provenance: { ...result.provenance, provider: 'other' } }),
    result => ({ ...result, provenance: { ...result.provenance, symbol: 'ETHUSDT' } }),
    result => ({ ...result, provenance: { ...result.provenance, requestedStartTime: BASE_TIME + HOUR_MS } }),
    result => ({ ...result, provenance: { ...result.provenance, requestedEndTime: END_TIME } }),
  ];

  for (const mutateAnalyzerResult of provenanceMutations) {
    const setup = makeApplication({ mutateAnalyzerResult });
    await assertAppRejects(() => setup.application.run(request()), 'SOURCE_MISMATCH', {
      source: 'analyzer',
      phase: 'composition',
    });
  }

  const indexedSetup = makeApplication();
  const originalAnalyzerFetch = indexedSetup.analyzerSource.fetch;
  indexedSetup.analyzerSource.fetch = async requestValue => {
    const result = await originalAnalyzerFetch(requestValue);
    const snapshots = result.analyzerInput.snapshots.map((snapshot, index) => index === 10
      ? { ...snapshot, timestamp: new Date(Date.parse(snapshot.timestamp) + 30 * 60 * 1000).toISOString() }
      : snapshot);
    return cloneAnalyzerResultWithSnapshots(result, snapshots);
  };
  await assertAppRejects(() => indexedSetup.application.run(request()), 'SOURCE_MISMATCH', {
    source: 'analyzer',
    phase: 'composition',
    field: 'snapshots[10].timestamp',
  });
});

test('rejects missing terminal Analyzer coverage and does not execute the runner', async () => {
  const setup = makeApplication();
  const originalAnalyzerFetch = setup.analyzerSource.fetch;
  setup.analyzerSource.fetch = async requestValue => {
    const result = await originalAnalyzerFetch(requestValue);
    return cloneAnalyzerResultWithSnapshots(result, result.analyzerInput.snapshots.slice(0, -1));
  };
  await assertAppRejects(() => setup.application.run(request()), 'SOURCE_MISMATCH', {
    source: 'analyzer',
    phase: 'composition',
    field: 'count',
  });
});

test('maps dependency construction failures and leaves no partial application result', async () => {
  const dependencyError = Object.assign(new Error('config snapshot failed'), { code: 'CONFIG_FAILURE' });
  const setup = makeApplication();
  const failingConfig = { get() { throw dependencyError; } };
  const application = createProductionReplayApplication({
    mtfSource: setup.mtfSource,
    analyzerSource: setup.analyzerSource,
    logger,
    config: failingConfig,
    clock: makeClock(),
    riskPolicySource: makeRiskPolicySource(),
  });

  await assertAppRejects(() => application.run(request()), 'DEPENDENCY_FAILURE', {
    source: 'dependencies',
    phase: 'construction',
    originalCode: 'CONFIG_FAILURE',
    cause: dependencyError,
  });
});

test('maps runner construction and execution failures to REPLAY_FAILURE without partial output', async () => {
  const constructionError = Object.assign(new Error('runner construction failed'), { code: 'RUNNER_BUILD' });
  const constructionSetup = makeApplication();
  await withRunnerFactoryStub(() => { throw constructionError; }, async freshModule => {
    const application = freshModule.createProductionReplayApplication({
      mtfSource: constructionSetup.mtfSource,
      analyzerSource: constructionSetup.analyzerSource,
      logger,
      config,
      clock: makeClock(),
      riskPolicySource: makeRiskPolicySource(),
    });
    await assert.rejects(application.run(request()), error => {
      assert.equal(error.name, 'ProductionReplayApplicationError');
      assert.equal(error.code, 'REPLAY_FAILURE');
      assert.equal(error.source, 'runner');
      assert.equal(error.phase, 'construction');
      assert.equal(error.originalCode, 'RUNNER_BUILD');
      assert.equal(error.cause, constructionError);
      return true;
    });
  });

  const executionError = Object.assign(new Error('runner execution failed'), { code: 'RUNNER_EXEC' });
  const executionSetup = makeApplication();
  await withRunnerFactoryStub(() => ({
    hasNext() { throw executionError; },
    runNextCycle() { throw new Error('not reached'); },
    getState() { return { status: 'FAILED', cycleCount: 0, failure: executionError }; },
  }), async freshModule => {
    const application = freshModule.createProductionReplayApplication({
      mtfSource: executionSetup.mtfSource,
      analyzerSource: executionSetup.analyzerSource,
      logger,
      config,
      clock: makeClock(),
      riskPolicySource: makeRiskPolicySource(),
    });
    await assert.rejects(application.run(request()), error => {
      assert.equal(error.name, 'ProductionReplayApplicationError');
      assert.equal(error.code, 'REPLAY_FAILURE');
      assert.equal(error.source, 'runner');
      assert.equal(error.phase, 'execution');
      assert.equal(error.originalCode, 'RUNNER_EXEC');
      assert.equal(error.cause, executionError);
      return true;
    });
  });
});

test('repeated production-shaped runs are semantically deterministic with fresh projections', async () => {
  const first = makeApplication();
  const second = makeApplication();
  const firstResult = await runQuietly(() => first.application.run(request()));
  const secondResult = await runQuietly(() => second.application.run(request()));

  assert.deepEqual(firstResult, secondResult);
  assert.notStrictEqual(firstResult, secondResult);
  assert.notStrictEqual(firstResult.replay, secondResult.replay);
  assert.notStrictEqual(firstResult.replay.cycles, secondResult.replay.cycles);
});

test('classifies source cancellation as internal CANCELLED without partial output', async () => {
  const controller = new AbortController();
  const cause = createAbortError();
  const setup = makeApplication();
  setup.mtfSource.fetch = async () => {
    controller.abort();
    throw cause;
  };

  await assert.rejects(
    setup.application.run(request(), { signal: controller.signal }),
    error => {
      assert.equal(error.name, 'ProductionReplayApplicationError');
      assert.equal(error.code, 'CANCELLED');
      assert.equal(error.cause, cause);
      assert.equal(error.source, 'lifecycle');
      return true;
    },
  );
});

test('forwards one lifecycle signal through both Replay source boundaries', async () => {
  const controller = new AbortController();
  const setup = makeApplication();

  await runQuietly(() => setup.application.run(request(), { signal: controller.signal }));

  assert.ok(setup.mtfCalls.every(call => call.options?.signal === controller.signal));
  assert.equal(setup.analyzerSourceCalls[0].options.signal, controller.signal);
  assert.equal(setup.analyzerClientCalls[0].options.signal, controller.signal);
});

test('cooperatively cancels a synchronous Replay run at a macrotask checkpoint', async () => {
  const cycleCount = 128;
  const endTime = BASE_TIME + cycleCount * HOUR_MS;
  const mtfTimeframes = Object.fromEntries(Object.entries(REPLAY_MTF_DURATIONS_MS).map(([timeframe, duration]) => [
    timeframe,
    Array.from({ length: (endTime - BASE_TIME) / duration }, (_, index) => ({
      openTime: BASE_TIME + index * duration,
      timestamp: new Date(BASE_TIME + index * duration).toISOString(),
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 1,
    })),
  ]));
  const snapshots = Array.from({ length: cycleCount + 1 }, (_, index) => ({
    timestamp: new Date(BASE_TIME + index * HOUR_MS).toISOString(),
    price: 100 + index,
    volume: 1,
    change24h: 0,
  }));
  const mtfResult = {
    rawInput: {
      schemaVersion: 2,
      primaryTimeframe: '1h',
      sourcePolicy: 'independent',
      timeframes: mtfTimeframes,
    },
    provenance: {
      provider: 'binance-spot-klines',
      symbol: SYMBOL,
      requestedStartTime: BASE_TIME,
      requestedEndTime: endTime,
    },
  };
  const analyzerResult = {
    analyzerInput: normalizeReplayAnalyzerInput({
      schemaVersion: 1,
      symbol: SYMBOL,
      snapshots,
    }),
    provenance: {
      sourceType: 'production-replay-analyzer',
      semanticMode: 'historical-equivalent',
      provider: 'coingecko',
      symbol: SYMBOL,
      requestedStartTime: BASE_TIME,
      requestedEndTime: endTime + HOUR_MS,
    },
  };
  const controller = new AbortController();
  const originalSetImmediate = setImmediate;
  let yieldCount = 0;

  await withRunnerFactoryStub(() => {
    let index = 0;
    return {
      hasNext() { return index < cycleCount; },
      runNextCycle() {
        const cycle = {
          index,
          openTime: BASE_TIME + index * HOUR_MS,
          timestamp: new Date(BASE_TIME + (index + 1) * HOUR_MS).toISOString(),
          price: 100 + index,
          decision: {},
        };
        index++;
        return cycle;
      },
      getState() {
        return { status: 'EXHAUSTED', cycleCount: index, failure: null };
      },
    };
  }, async freshModule => {
    const application = freshModule.createProductionReplayApplication({
      mtfSource: { fetch: async () => mtfResult },
      analyzerSource: { fetch: async () => analyzerResult },
      logger,
      config,
      clock: makeClock(),
      riskPolicySource: makeRiskPolicySource(),
    });
    global.setImmediate = (callback, ...args) => {
      yieldCount++;
      if (yieldCount === 2) controller.abort();
      return originalSetImmediate(callback, ...args);
    };
    try {
      await assert.rejects(
        application.run(request(BASE_TIME, endTime), { signal: controller.signal }),
        error => error.name === 'ProductionReplayApplicationError' && error.code === 'CANCELLED',
      );
    } finally {
      global.setImmediate = originalSetImmediate;
    }
  });

  assert.equal(yieldCount, 2);
});

test('final post-projection checkpoint prevents a cancelled result from returning', async () => {
  const controller = new AbortController();
  const application = makeApplication().application;
  const originalSetImmediate = setImmediate;
  let yieldCount = 0;
  global.setImmediate = (callback, ...args) => {
    yieldCount++;
    if (yieldCount === 3) controller.abort();
    return originalSetImmediate(callback, ...args);
  };

  try {
    await assert.rejects(
      runQuietly(() => application.run(request(), { signal: controller.signal })),
      error => assertAppError(error, 'CANCELLED'),
    );
  } finally {
    global.setImmediate = originalSetImmediate;
  }
  assert.equal(yieldCount, 3);
});
