const test = require('node:test');
const assert = require('node:assert/strict');

const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { CandleEngine } = require('../../src/engine/candles');
const { normalizeReplayInput } = require('../../src/engine/replayInput');
const executionPipelineModule = require('../../src/core/executionPipeline');

const pipelineSnapshots = [];
const pipelineCalls = [];
const originalCreateExecutionPipeline = executionPipelineModule.createExecutionPipeline;
executionPipelineModule.createExecutionPipeline = dependencies => {
  const pipeline = originalCreateExecutionPipeline(dependencies);
  const originalRun = pipeline.run.bind(pipeline);
  pipeline.run = (...args) => {
    pipelineCalls.push(args);
    pipelineSnapshots.push(args[0]);
    return originalRun(...args);
  };
  return pipeline;
};
const { createReplayPipelineRunner } = require('../../src/engine/replayPipelineRunner');
executionPipelineModule.createExecutionPipeline = originalCreateExecutionPipeline;

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MAX_DATE_MS = 8640000000000000;
const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  },
};

function rawCandles(count = 51, mutate, startTime = BASE_TIME) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    const candle = {
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
      openTime: startTime + index * HOUR,
      timestamp: new Date(startTime + index * HOUR).toISOString(),
    };
    mutate?.(candle, index);
    return candle;
  });
}

function normalizedInput(count = 51, timeframe = '1h', mutate, startTime = BASE_TIME) {
  if (count >= 51) return normalizeReplayInput(rawCandles(count, mutate, startTime), timeframe);

  const candles = rawCandles(count, mutate, startTime).map(candle => Object.freeze(candle));
  return Object.freeze({
    schemaVersion: 1,
    timeframe,
    candles: Object.freeze(candles),
  });
}

function customInput(candles) {
  const frozenCandles = candles.map(candle => Object.freeze({
    timestamp: new Date(candle.openTime).toISOString(),
    ...candle,
  }));
  return Object.freeze({
    schemaVersion: 1,
    timeframe: '1h',
    candles: Object.freeze(frozenCandles),
  });
}

function customCandle(openTime, open, close = open) {
  return {
    openTime,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1,
  };
}

function makeClock() {
  let monotonic = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => monotonic++,
  };
}

function makeBundle(input = normalizedInput()) {
  return createReplayDependencies({
    logger,
    symbol: 'BTCUSDT',
    config,
    normalizedInput: input,
    clock: makeClock(),
  });
}

function makeRunner(input = normalizedInput(), bundle = makeBundle(input)) {
  return { bundle, runner: createReplayPipelineRunner({ dependencies: bundle, normalizedInput: input }) };
}

function runQuietly(runner) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return runner.runNextCycle();
  } finally {
    console.log = originalLog;
  }
}

function prepareEligibleBundle(bundle, { allowMtf = false, useActualRisk = false } = {}) {
  bundle.analyzer.getAnalysis = () => ({ trend: { '1H': 'Bullish' } });
  bundle.regimeEngine.calculate = () => ({
    regime: 'TRENDING_BULL',
    confidence: 80,
    trendScore: 80,
    rangeScore: 20,
    volatility: 'Low',
  });
  bundle.confluenceEngine.calculate = () => ({
    score: 80,
    bias: 'Bullish',
    confidence: 80,
    components: {},
    missing: [],
  });
  bundle.atrEngine.calculate = () => ({
    ready: true,
    atr: 1,
    atrPercentage: 1,
    volatilityLevel: 'Low',
    volatilityTrend: 'Stable',
  });
  bundle.structureEngine.calculate = () => ({
    ready: true,
    direction: 'bullish',
    structure: 'Bullish',
    score: 80,
  });
  bundle.indicatorRegistry.get = name => ({
    calculate: () => name === 'RSI'
      ? { ready: true, value: 70, state: 'Overbought' }
      : { ready: true, value: 110, trend: 'Above' },
  });
  bundle.macdEngine.calculate = () => ({
    ready: true,
    macd: 1,
    signal: 0,
    histogram: 1,
    trend: 'Bullish',
  });
  bundle.bollingerEngine.calculate = () => ({
    ready: false,
    middleBand: null,
    upperBand: null,
    lowerBand: null,
    pricePosition: 'Inside Bands',
    squeeze: false,
  });
  bundle.regimeDecisionEngine.evaluate = () => ({
    allowTrade: true,
    preferredDirection: 'BUY',
    penalty: 0,
    reason: 'Allowed',
  });
  bundle.mtfEngine.calculate = () => ({ overallBias: 'Bullish', timeframeAgreement: 100 });

  if (allowMtf) {
    bundle.mtfConfirmationEngine.evaluate = () => ({
      mtfAllowed: true,
      rejectionReason: null,
      confidence: 80,
      alignmentScore: 100,
    });
    if (!useActualRisk) {
      bundle.advanceRiskEngine.evaluate = ({ entryPrice }) => ({
        tradeAllowed: true,
        positionSize: 1,
        stopLoss: entryPrice - 5,
        takeProfit: entryPrice + 5,
        riskReward: 1,
        session: 'ASIAN',
      });
    }
  }

}

function warmupToEligibleCycle(runner, count = 15) {
  for (let index = 0; index < count; index++) runQuietly(runner);
}

function openPaperTrade(bundle, entryPrice = 100, stopLoss = 96, takeProfit = 106) {
  return bundle.paperTradeEngine.signal({
    trend: { trend: { '1H': 'Bullish' } },
    structure: { ready: true, direction: 'bullish', structure: 'Bullish', score: 80 },
    rsi: { ready: true, value: 70, state: 'Overbought' },
    ema: { ready: true, value: 110, trend: 'Above' },
    macd: { ready: true, trend: 'Bullish', histogram: 1 },
    bollinger: { ready: false },
    confluence: { bias: 'Bullish', score: 80, confidence: 80 },
    mtf: { overallBias: 'Bullish', timeframeAgreement: 100 },
  }, entryPrice, '1h', 'BUY', {
    stopLoss,
    takeProfit,
    positionSize: 1,
    riskReward: 1,
  });
}

test('returns a frozen facade with the exact public methods', () => {
  const { runner } = makeRunner();

  assert.deepEqual(Object.keys(runner), ['hasNext', 'runNextCycle', 'getState']);
  assert.equal(Object.isFrozen(runner), true);
  assert.equal(typeof runner.hasNext, 'function');
  assert.equal(typeof runner.runNextCycle, 'function');
  assert.equal(typeof runner.getState, 'function');
});

test('initial state is READY, frozen, and defensively snapshotted', () => {
  const { runner } = makeRunner();
  const first = runner.getState();
  const second = runner.getState();

  assert.deepEqual(first, {
    status: 'READY',
    cycleCount: 0,
    lastResult: null,
    failure: null,
  });
  assert.equal(Object.isFrozen(first), true);
  assert.notStrictEqual(first, second);
  assert.equal(Object.isFrozen(second), true);
  assert.equal(runner.hasNext(), true);
});

test('first cycle advances the historical clock to the candle close boundary', () => {
  const input = normalizedInput();
  const { bundle, runner } = makeRunner(input);

  const result = runQuietly(runner);
  const closeTime = input.candles[0].openTime + HOUR;
  const closeTimestamp = new Date(closeTime).toISOString();

  assert.equal(bundle.clock.nowMs(), closeTime);
  assert.equal(result.timestamp, closeTimestamp);
  assert.equal(result.decision.timestamp, closeTimestamp);
  assert.equal(pipelineSnapshots[pipelineSnapshots.length - 1].timestamp, closeTimestamp);
});

test('transactional cycle order is prepare, clock, commit, then pipeline', () => {
  const input = normalizedInput(2);
  const bundle = makeBundle(input);
  const order = [];
  const originalPrepare = bundle.candleEngine.prepareBoundary.bind(bundle.candleEngine);
  const originalAdvance = bundle.clockController.advanceTo.bind(bundle.clockController);
  const originalCommit = bundle.candleEngine.commitBoundary.bind(bundle.candleEngine);
  const originalRun = bundle.candleEngine.getCandles.bind(bundle.candleEngine);

  bundle.candleEngine.prepareBoundary = (...args) => {
    order.push('prepare');
    return originalPrepare(...args);
  };
  bundle.candleEngine.commitBoundary = (...args) => {
    order.push('commit');
    return originalCommit(...args);
  };
  bundle.candleEngine.getCandles = (...args) => {
    order.push('pipeline-read');
    return originalRun(...args);
  };
  const orderedClockController = {
    advanceTo(...args) {
      order.push('clock');
      return originalAdvance(...args);
    },
  };
  const { runner } = makeRunner(input, { ...bundle, clockController: orderedClockController });

  runQuietly(runner);

  assert.deepEqual(order.slice(0, 4), ['prepare', 'clock', 'commit', 'pipeline-read']);
});

test('continuous discontinuity uses the next source open as the boundary price', () => {
  const input = customInput([
    customCandle(BASE_TIME, 100, 100),
    customCandle(BASE_TIME + HOUR, 105, 106),
  ]);
  const { bundle, runner } = makeRunner(input);
  const before = pipelineCalls.length;

  const result = runQuietly(runner);
  const [snapshot, options] = pipelineCalls[before];

  assert.equal(pipelineCalls[before].length, 2);
  assert.equal(snapshot.price, 105);
  assert.equal(snapshot.price, input.candles[1].open);
  assert.equal(options.lifecycleCandle, input.candles[0]);
  assert.notStrictEqual(options.lifecycleCandle, bundle.candleEngine.getActive('1h'));
  assert.equal(result.price, 105);
});

test('projection replacement finalizes exact sources one boundary later', () => {
  const input = normalizedInput(3);
  const { bundle, runner } = makeRunner(input);

  runQuietly(runner);
  const projection1 = bundle.candleEngine.getActive('1h');
  assert.strictEqual(bundle.candleEngine.getCandles('1h')[0], input.candles[0]);
  assert.notStrictEqual(projection1, input.candles[1]);

  runQuietly(runner);
  const projection2 = bundle.candleEngine.getActive('1h');
  assert.deepEqual(bundle.candleEngine.getCandles('1h'), [input.candles[0], input.candles[1]]);
  assert.strictEqual(bundle.candleEngine.getCandles('1h')[1], input.candles[1]);
  assert.notStrictEqual(bundle.candleEngine.getCandles('1h')[1], projection1);
  assert.notStrictEqual(projection2, input.candles[2]);

  runQuietly(runner);
  assert.deepEqual(bundle.candleEngine.getCandles('1h'), [
    input.candles[0],
    input.candles[1],
    input.candles[2],
  ]);
  assert.equal(bundle.candleEngine.getActive('1h'), null);
});

test('transactional runner never invokes legacy activation or finalization', () => {
  const input = normalizedInput(3);
  const bundle = makeBundle(input);
  bundle.candleEngine.nextActive = () => { throw new Error('legacy nextActive invoked'); };
  bundle.candleEngine.finalizeActive = () => { throw new Error('legacy finalizeActive invoked'); };
  const { runner } = makeRunner(input, bundle);

  runQuietly(runner);
  runQuietly(runner);
  runQuietly(runner);

  assert.equal(runner.getState().status, 'EXHAUSTED');
  assert.equal(runner.getState().cycleCount, 3);
});

test('transactional cycles preserve frozen source candles and input identity', () => {
  const input = normalizedInput(3);
  const sourceArray = input.candles;
  const sourceRefs = [...input.candles];
  const sourceSnapshots = input.candles.map(candle => ({ ...candle }));
  const { runner } = makeRunner(input);

  runQuietly(runner);
  runQuietly(runner);
  runQuietly(runner);

  assert.strictEqual(input.candles, sourceArray);
  assert.ok(Object.isFrozen(input.candles));
  input.candles.forEach((candle, index) => {
    assert.ok(Object.isFrozen(candle));
    assert.strictEqual(candle, sourceRefs[index]);
    assert.deepEqual(candle, sourceSnapshots[index]);
  });
});

test('gap boundary uses the completed close without fabricating intervals', () => {
  const input = customInput([
    customCandle(BASE_TIME, 100, 101),
    customCandle(BASE_TIME + 3 * HOUR, 105, 106),
  ]);
  const { bundle, runner } = makeRunner(input);
  const firstCall = pipelineCalls.length;

  const firstResult = runQuietly(runner);
  const firstSnapshot = pipelineCalls[firstCall][0];

  assert.equal(firstSnapshot.price, input.candles[0].close);
  assert.equal(bundle.candleEngine.getActive('1h'), null);
  assert.equal(firstResult.timestamp, new Date(BASE_TIME + HOUR).toISOString());

  const secondCall = pipelineCalls.length;
  const secondResult = runQuietly(runner);
  const secondSnapshot = pipelineCalls[secondCall][0];

  assert.equal(secondSnapshot.price, input.candles[1].close);
  assert.equal(secondResult.timestamp, new Date(BASE_TIME + 4 * HOUR).toISOString());
  assert.equal(runner.getState().cycleCount, 2);
});

test('terminal boundary uses the final close and executes exactly once', () => {
  const input = normalizedInput(1);
  const { bundle, runner } = makeRunner(input);
  const before = pipelineCalls.length;

  const result = runQuietly(runner);
  const [snapshot, options] = pipelineCalls[before];

  assert.equal(snapshot.price, input.candles[0].close);
  assert.equal(options.lifecycleCandle, input.candles[0]);
  assert.equal(bundle.candleEngine.getActive('1h'), null);
  assert.equal(result.openTime, input.candles[0].openTime);
  assert.equal(result.timestamp, new Date(input.candles[0].openTime + HOUR).toISOString());
  assert.equal(runner.getState().status, 'EXHAUSTED');
  assert.equal(runner.hasNext(), false);
});

test('consecutive replay cycles advance exactly one hour at close boundaries', () => {
  const input = normalizedInput(2);
  const { bundle, runner } = makeRunner(input);

  runQuietly(runner);
  const firstCloseTime = bundle.clock.nowMs();
  runQuietly(runner);
  const secondCloseTime = bundle.clock.nowMs();

  assert.equal(firstCloseTime, input.candles[0].openTime + HOUR);
  assert.equal(secondCloseTime, input.candles[1].openTime + HOUR);
  assert.equal(secondCloseTime - firstCloseTime, HOUR);
});

test('23:00 UTC candle executes at the new UTC day close boundary', () => {
  const startTime = Date.parse('2024-01-01T08:00:00.000Z');
  const input = normalizedInput(51, '1h', undefined, startTime);
  const bundle = makeBundle(input);
  prepareEligibleBundle(bundle, { allowMtf: true, useActualRisk: true });
  const { runner } = makeRunner(input, bundle);

  warmupToEligibleCycle(runner);
  const result = runQuietly(runner);
  const closeTimestamp = '2024-01-02T00:00:00.000Z';

  assert.equal(result.timestamp, closeTimestamp);
  assert.equal(result.decision.timestamp, closeTimestamp);
  assert.equal(result.decision.risk.timestamp, closeTimestamp);
  assert.equal(result.decision.risk.session, 'ASIAN');
});

test('schemaVersion 1 candles retain open-time identity without closeTime', () => {
  const input = normalizedInput();

  assert.equal(input.schemaVersion, 1);
  assert.equal(Object.hasOwn(input.candles[0], 'closeTime'), false);
  assert.equal(input.candles[0].timestamp, new Date(input.candles[0].openTime).toISOString());
});

test('transaction commits finalized history and causal active state before execution', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  const observations = [];
  const originalGetActive = bundle.candleEngine.getActive.bind(bundle.candleEngine);
  const originalGetCandles = bundle.candleEngine.getCandles.bind(bundle.candleEngine);
  bundle.candleEngine.getActive = timeframe => {
    const active = originalGetActive(timeframe);
    observations.push({ type: 'active', active });
    return active;
  };
  bundle.candleEngine.getCandles = (timeframe, limit) => {
    const candles = originalGetCandles(timeframe, limit);
    observations.push({ type: 'finalized', candles });
    return candles;
  };
  const { runner } = makeRunner(input, bundle);

  runQuietly(runner);

  const activeObservation = observations.find(observation => observation.type === 'active');
  const finalizedObservation = observations.find(observation => observation.type === 'finalized');
  assert.ok(activeObservation);
  assert.strictEqual(activeObservation.active.open, input.candles[1].open);
  assert.ok(finalizedObservation);
  assert.deepEqual(finalizedObservation.candles, [input.candles[0]]);
  assert.strictEqual(finalizedObservation.candles[0], input.candles[0]);
  assert.strictEqual(bundle.candleEngine.getActive('1h').open, input.candles[1].open);
});

test('successful cycle finalizes exactly one candle and leaves the causal projection active', () => {
  const input = normalizedInput(2);
  const { bundle, runner } = makeRunner(input);

  runQuietly(runner);

  assert.equal(bundle.candleEngine.getActive('1h').open, input.candles[1].open);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
  assert.strictEqual(bundle.candleEngine.getCandles('1h')[0], input.candles[0]);
});

test('cycleCount advances exactly once per successful cycle', () => {
  const { bundle, runner } = makeRunner();

  runQuietly(runner);
  assert.deepEqual(runner.getState(), {
    status: 'READY',
    cycleCount: 1,
    lastResult: runner.getState().lastResult,
    failure: null,
  });
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
});

test('insufficient-history rejection remains canonical', () => {
  const { runner } = makeRunner();

  const result = runQuietly(runner);

  assert.equal(result.decision.verdict.rejectionReason, 'Insufficient candles (1/15 minimum)');
});

test('canonical MTF insufficiency remains visible after sufficient history', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  prepareEligibleBundle(bundle);
  const { runner } = makeRunner(input, bundle);

  warmupToEligibleCycle(runner);
  const result = runQuietly(runner);

  assert.equal(result.decision.verdict.rejectionReason, 'Insufficient timeframe data: 1/3 minimum');
});

test('replay exposes no fabricated timeframe', () => {
  const { bundle } = makeRunner();

  assert.deepEqual(bundle.candleEngine.getAllTimeframes(), ['1h']);
});

test('existing trade lifecycle occurs before a new signal', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  prepareEligibleBundle(bundle, { allowMtf: true });
  const { runner } = makeRunner(input, bundle);
  warmupToEligibleCycle(runner);
  assert.ok(openPaperTrade(bundle, input.candles[15].close, input.candles[15].close - 5, input.candles[15].close + 5));

  const order = [];
  for (const method of ['evaluateTrades', 'onCandle', 'signal']) {
    const original = bundle.paperTradeEngine[method].bind(bundle.paperTradeEngine);
    bundle.paperTradeEngine[method] = (...args) => {
      order.push(method);
      return original(...args);
    };
  }

  runQuietly(runner);

  assert.ok(order.indexOf('evaluateTrades') < order.indexOf('onCandle'));
  assert.ok(order.indexOf('onCandle') < order.indexOf('signal'));
});

test('a candle closure advances AdvanceRisk exactly once', () => {
  const input = normalizedInput(51, '1h', (candle, index) => {
    if (index === 0) {
      candle.high = 106;
      candle.low = 99;
      candle.close = 100;
      candle.open = 100;
    }
  });
  const bundle = makeBundle(input);
  const { runner } = makeRunner(input, bundle);
  assert.ok(openPaperTrade(bundle));
  const closures = [];
  const originalOnTradeClosed = bundle.advanceRiskEngine.onTradeClosed.bind(bundle.advanceRiskEngine);
  bundle.advanceRiskEngine.onTradeClosed = (pnl, context) => {
    closures.push({ pnl, context });
    return originalOnTradeClosed(pnl, context);
  };

  runQuietly(runner);

  assert.equal(closures.length, 1);
  assert.equal(closures[0].context.nowMs, input.candles[0].openTime + HOUR);
  assert.equal(bundle.paperTradeEngine.closed()[0].exitTime,
    new Date(input.candles[0].openTime + HOUR).toISOString());
  assert.equal(bundle.paperTradeEngine.closed().length, 1);
});

test('newly opened trade is not evaluated against its opening candle', () => {
  const input = normalizedInput(51, '1h', (candle, index) => {
    if (index === 15) {
      candle.high = 200;
      candle.low = 50;
    }
  });
  const bundle = makeBundle(input);
  prepareEligibleBundle(bundle, { allowMtf: true });
  const { runner } = makeRunner(input, bundle);

  warmupToEligibleCycle(runner, 14);
  runQuietly(runner);

  assert.equal(bundle.paperTradeEngine.open().length, 1);
  assert.equal(bundle.paperTradeEngine.closed().length, 0);
});

test('returned decision and result mutation cannot alter runner state', () => {
  const { runner } = makeRunner();
  const result = runQuietly(runner);
  const before = runner.getState();

  result.decision.verdict.rejectionReason = 'mutated';
  result.price = -1;

  const after = runner.getState();
  assert.equal(after.lastResult.decision.verdict.rejectionReason, before.lastResult.decision.verdict.rejectionReason);
  assert.equal(after.lastResult.price, before.lastResult.price);
});

test('repeated getState snapshots are independent and frozen', () => {
  const { runner } = makeRunner();
  runQuietly(runner);
  const first = runner.getState();
  const second = runner.getState();

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.lastResult, second.lastResult);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.lastResult), true);
  assert.equal(Object.isFrozen(first.lastResult.decision), true);
  first.lastResult.decision.verdict.rejectionReason = 'mutated';
  assert.notEqual(second.lastResult.decision.verdict.rejectionReason, 'mutated');
});

test('two runners from separate dependency bundles remain isolated', () => {
  const firstInput = normalizedInput();
  const secondInput = normalizedInput();
  const first = makeRunner(firstInput);
  const second = makeRunner(secondInput);

  runQuietly(first.runner);

  assert.equal(first.runner.getState().cycleCount, 1);
  assert.equal(second.runner.getState().cycleCount, 0);
  assert.equal(first.bundle.candleEngine.getCandles('1h').length, 1);
  assert.equal(second.bundle.candleEngine.getCandles('1h').length, 0);
});

test('live CandleEngine state remains unchanged', () => {
  const live = new CandleEngine({ get: key => (key === 'MAX_HISTORY' ? 2 : undefined) }, {});
  const before = {
    candles: live.getCandles('1h'),
    active: live.getActive('1h'),
    timeframes: live.getAllTimeframes(),
  };
  const { runner } = makeRunner();

  runQuietly(runner);

  assert.deepEqual(live.getCandles('1h'), before.candles);
  assert.equal(live.getActive('1h'), before.active);
  assert.deepEqual(live.getAllTimeframes(), before.timeframes);
});

test('non-1h normalized input rejects', () => {
  const input = normalizedInput(51, '5m');
  const bundle = makeBundle(normalizedInput());

  assert.throws(
    () => createReplayPipelineRunner({ dependencies: bundle, normalizedInput: input }),
    error => error.code === 'INVALID_TIMEFRAME',
  );
});

test('close-boundary overflow fails before commit and preserves READY state', () => {
  const input = Object.freeze({
    schemaVersion: 1,
    timeframe: '1h',
    candles: Object.freeze([Object.freeze({
      openTime: MAX_DATE_MS,
      timestamp: new Date(MAX_DATE_MS).toISOString(),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    })]),
  });
  const bundle = makeBundle(input);
  const { runner } = makeRunner(input, bundle);

  assert.throws(
    () => runQuietly(runner),
    error => error instanceof TypeError && /closeTime/.test(error.message),
  );
  assert.equal(runner.hasNext(), true);
  assert.deepEqual(runner.getState(), {
    status: 'READY',
    cycleCount: 0,
    lastResult: null,
    failure: null,
  });
  assert.equal(bundle.clock.nowMs(), MAX_DATE_MS);
  assert.equal(bundle.candleEngine.getActive('1h'), null);
});

test('empty normalized input rejects', () => {
  const bundle = makeBundle();
  const input = Object.freeze({ schemaVersion: 1, timeframe: '1h', candles: Object.freeze([]) });

  assert.throws(
    () => createReplayPipelineRunner({ dependencies: bundle, normalizedInput: input }),
    error => error.code === 'INVALID_CANDLES',
  );
});

test('candle engine and normalized input timeframe mismatch rejects', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  const mismatchedCandleEngine = new Proxy(bundle.candleEngine, {
    get(target, property, receiver) {
      if (property === 'timeframe') return '5m';
      return Reflect.get(target, property, receiver);
    },
  });
  const mismatchedBundle = { ...bundle, candleEngine: mismatchedCandleEngine };

  assert.throws(
    () => createReplayPipelineRunner({ dependencies: mismatchedBundle, normalizedInput: input }),
    error => error.code === 'TIMEFRAME_MISMATCH',
  );
});

test('clock failure after preparation skips commit and preserves retryable state', () => {
  const input = normalizedInput(2);
  const bundle = makeBundle(input);
  const order = [];
  const originalPrepare = bundle.candleEngine.prepareBoundary.bind(bundle.candleEngine);
  const originalCommit = bundle.candleEngine.commitBoundary.bind(bundle.candleEngine);
  bundle.candleEngine.prepareBoundary = (...args) => {
    order.push('prepare');
    return originalPrepare(...args);
  };
  bundle.candleEngine.commitBoundary = (...args) => {
    order.push('commit');
    return originalCommit(...args);
  };
  const { runner } = makeRunner(input, {
    ...bundle,
    clockController: {
      advanceTo() {
        order.push('clock');
        throw new Error('controlled clock failure');
      },
    },
  });

  assert.throws(() => runQuietly(runner), /controlled clock failure/);
  assert.deepEqual(order, ['prepare', 'clock']);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 0);
  assert.equal(bundle.candleEngine.getActive('1h'), null);
  assert.deepEqual(runner.getState(), {
    status: 'READY',
    cycleCount: 0,
    lastResult: null,
    failure: null,
  });
  assert.equal(runner.hasNext(), true);
});

test('escaped pipeline failure after commit preserves committed state and fails runner', () => {
  const input = normalizedInput(2);
  const bundle = makeBundle(input);
  const originalGetCandles = bundle.candleEngine.getCandles.bind(bundle.candleEngine);
  bundle.candleEngine.getCandles = () => {
    throw new Error('controlled pipeline failure');
  };
  const { runner } = makeRunner(input, bundle);

  assert.throws(() => runQuietly(runner), /controlled pipeline failure/);
  const state = runner.getState();
  assert.equal(state.status, 'FAILED');
  assert.equal(state.cycleCount, 0);
  assert.equal(state.lastResult, null);
  assert.equal(bundle.candleEngine.getActive('1h').open, input.candles[1].open);
  assert.equal(originalGetCandles('1h').length, 1);
  assert.equal(runner.hasNext(), false);
  assert.throws(() => runner.runNextCycle(), error => error.code === 'RUNNER_FAILED');
});

test('post-commit exhaustion failure does not publish successful bookkeeping', () => {
  const input = normalizedInput(2);
  const bundle = makeBundle(input);
  const originalHasNext = bundle.candleEngine.hasNext.bind(bundle.candleEngine);
  let hasNextCalls = 0;
  bundle.candleEngine.hasNext = () => {
    hasNextCalls += 1;
    if (hasNextCalls === 2) throw new Error('controlled exhaustion check failure');
    return originalHasNext();
  };
  const { runner } = makeRunner(input, bundle);

  assert.throws(() => runQuietly(runner), /controlled exhaustion check failure/);
  const state = runner.getState();
  assert.equal(state.status, 'FAILED');
  assert.equal(state.cycleCount, 0);
  assert.equal(state.lastResult, null);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
  assert.equal(bundle.candleEngine.getActive('1h').open, input.candles[1].open);
  assert.equal(runner.hasNext(), false);
  assert.throws(() => runner.runNextCycle(), error => error.code === 'RUNNER_FAILED');
});

test('final successful cycle sets EXHAUSTED and retains its result', () => {
  const input = normalizedInput(1);
  const { bundle, runner } = makeRunner(input);

  const result = runQuietly(runner);
  const state = runner.getState();

  assert.equal(state.status, 'EXHAUSTED');
  assert.equal(state.cycleCount, 1);
  assert.equal(runner.hasNext(), false);
  assert.deepEqual(state.lastResult, result);
  assert.equal(result.openTime, input.candles[0].openTime);
  assert.equal(result.timestamp, new Date(input.candles[0].openTime + HOUR).toISOString());
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
});

test('EXHAUSTED runner refuses extra cycles without changing state', () => {
  const { runner } = makeRunner(normalizedInput(1));
  runQuietly(runner);
  const before = runner.getState();

  assert.throws(() => runner.runNextCycle(), error => error.code === 'NO_REMAINING_CANDLES');
  assert.deepEqual(runner.getState(), before);
});

test('runner has no StrategyReplay or report/statistics integration', () => {
  const { runner } = makeRunner();

  assert.deepEqual(Object.keys(runner), ['hasNext', 'runNextCycle', 'getState']);
  assert.equal(Object.hasOwn(runner, 'run'), false);
  assert.equal(Object.hasOwn(runner, 'stats'), false);
  assert.equal(Object.hasOwn(runner, 'report'), false);
});

test('runner module is referenced only by this integration test', () => {
  assert.equal(typeof createReplayPipelineRunner, 'function');
});
