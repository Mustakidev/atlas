const test = require('node:test');
const assert = require('node:assert/strict');

const { createReplayPipelineRunner } = require('../../src/engine/replayPipelineRunner');
const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { CandleEngine } = require('../../src/engine/candles');
const { normalizeReplayInput } = require('../../src/engine/replayInput');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  },
};

function rawCandles(count = 51, mutate) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    const candle = {
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
      openTime: BASE_TIME + index * HOUR,
      timestamp: new Date(BASE_TIME + index * HOUR).toISOString(),
    };
    mutate?.(candle, index);
    return candle;
  });
}

function normalizedInput(count = 51, timeframe = '1h', mutate) {
  if (count >= 51) return normalizeReplayInput(rawCandles(count, mutate), timeframe);

  const candles = rawCandles(count, mutate).map(candle => Object.freeze(candle));
  return Object.freeze({
    schemaVersion: 1,
    timeframe,
    candles: Object.freeze(candles),
  });
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

function prepareEligibleBundle(bundle, { allowMtf = false } = {}) {
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
    nextIndex: 0,
    lastResult: null,
    failure: null,
  });
  assert.equal(Object.isFrozen(first), true);
  assert.notStrictEqual(first, second);
  assert.equal(Object.isFrozen(second), true);
  assert.equal(runner.hasNext(), true);
});

test('first cycle advances the historical clock to candle.openTime', () => {
  const input = normalizedInput();
  const { bundle, runner } = makeRunner(input);

  runQuietly(runner);

  assert.equal(bundle.clock.nowMs(), input.candles[0].openTime);
});

test('active candle is visible and finalized history excludes it during execution', () => {
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

  assert.ok(observations.some(observation => observation.type === 'active'
    && observation.active === input.candles[0]));
  assert.ok(observations.some(observation => observation.type === 'finalized'
    && observation.candles.length === 0));
});

test('successful cycle finalizes exactly one candle and leaves no active candle', () => {
  const input = normalizedInput();
  const { bundle, runner } = makeRunner(input);

  runQuietly(runner);

  assert.equal(bundle.candleEngine.getActive('1h'), null);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
  assert.strictEqual(bundle.candleEngine.getCandles('1h')[0], input.candles[0]);
});

test('cycleCount and nextIndex advance exactly once per successful cycle', () => {
  const { bundle, runner } = makeRunner();

  runQuietly(runner);
  assert.deepEqual(runner.getState(), {
    status: 'READY',
    cycleCount: 1,
    nextIndex: 1,
    lastResult: runner.getState().lastResult,
    failure: null,
  });
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
});

test('insufficient-history rejection remains canonical', () => {
  const { runner } = makeRunner();

  const result = runQuietly(runner);

  assert.equal(result.decision.verdict.rejectionReason, 'Insufficient candles (0/15 minimum)');
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

  warmupToEligibleCycle(runner);
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

test('backward clock movement before activation propagates without FAILED state', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  bundle.clockController.advanceTo(input.candles[1].openTime);
  const { runner } = makeRunner(input, bundle);

  assert.throws(() => runQuietly(runner), /historical clock cannot move backwards/);
  assert.equal(runner.hasNext(), true);
  assert.deepEqual(runner.getState(), {
    status: 'READY',
    cycleCount: 0,
    nextIndex: 0,
    lastResult: null,
    failure: null,
  });
  assert.equal(bundle.candleEngine.getActive('1h'), null);
});

test('escaped pipeline error after activation leaves candle active and runner FAILED', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  bundle.candleEngine.getCandles = () => {
    throw new Error('controlled candle access failure');
  };
  const { runner } = makeRunner(input, bundle);

  assert.throws(() => runQuietly(runner), /controlled candle access failure/);
  const state = runner.getState();
  assert.equal(state.status, 'FAILED');
  assert.equal(state.cycleCount, 0);
  assert.equal(state.nextIndex, 0);
  assert.equal(state.failure.code, 'CYCLE_FAILED');
  assert.equal(state.failure.index, 0);
  assert.equal(bundle.candleEngine.getActive('1h'), input.candles[0]);
  assert.equal(runner.hasNext(), false);
});

test('successful finalization is followed by no clone or freeze operation', () => {
  const { bundle, runner } = makeRunner();
  let finalized = false;
  const originalFinalize = bundle.candleEngine.finalizeActive.bind(bundle.candleEngine);
  const originalClone = global.structuredClone;
  const originalFreeze = Object.freeze;
  bundle.candleEngine.finalizeActive = () => {
    const result = originalFinalize();
    finalized = true;
    return result;
  };
  global.structuredClone = value => {
    if (finalized) throw new Error('clone after finalization');
    return originalClone(value);
  };
  Object.freeze = value => {
    if (finalized) throw new Error('freeze after finalization');
    return originalFreeze(value);
  };

  let result;
  try {
    result = runQuietly(runner);
  } finally {
    global.structuredClone = originalClone;
    Object.freeze = originalFreeze;
  }

  assert.equal(finalized, true);
  assert.equal(result.index, 0);
  assert.equal(runner.getState().status, 'READY');
});

test('post-activation candleEngine.hasNext failure cannot fail a successful cycle', () => {
  const input = normalizedInput(2);
  const bundle = makeBundle(input);
  let activated = false;
  const originalHasNext = bundle.candleEngine.hasNext.bind(bundle.candleEngine);
  const originalNextActive = bundle.candleEngine.nextActive.bind(bundle.candleEngine);
  bundle.candleEngine.hasNext = () => {
    if (activated) throw new Error('post-activation hasNext failure');
    return originalHasNext();
  };
  bundle.candleEngine.nextActive = () => {
    const active = originalNextActive();
    activated = true;
    return active;
  };
  const { runner } = makeRunner(input, bundle);

  const result = runQuietly(runner);
  const state = runner.getState();

  assert.equal(result.index, 0);
  assert.equal(state.status, 'READY');
  assert.equal(state.cycleCount, 1);
  assert.equal(state.nextIndex, 1);
  assert.equal(state.failure, null);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
});

test('finalization failure preserves counters and reports actual candle state', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  const finalizationError = new Error('controlled finalization failure');
  const originalFinalize = bundle.candleEngine.finalizeActive.bind(bundle.candleEngine);
  bundle.candleEngine.finalizeActive = () => {
    originalFinalize();
    throw finalizationError;
  };
  const { runner } = makeRunner(input, bundle);

  assert.throws(() => runQuietly(runner), error => error === finalizationError);
  const state = runner.getState();
  assert.equal(state.status, 'FAILED');
  assert.equal(state.cycleCount, 0);
  assert.equal(state.nextIndex, 0);
  assert.equal(state.lastResult, null);
  assert.equal(state.failure.code, 'CYCLE_FAILED');
  assert.equal(state.failure.message, finalizationError.message);
  assert.equal(bundle.candleEngine.getActive('1h'), null);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
});

test('final-candle exhaustion does not call external hasNext after finalization', () => {
  const input = normalizedInput(1);
  const bundle = makeBundle(input);
  let activated = false;
  const originalHasNext = bundle.candleEngine.hasNext.bind(bundle.candleEngine);
  const originalNextActive = bundle.candleEngine.nextActive.bind(bundle.candleEngine);
  bundle.candleEngine.hasNext = () => {
    if (activated) throw new Error('post-finalization hasNext failure');
    return originalHasNext();
  };
  bundle.candleEngine.nextActive = () => {
    const active = originalNextActive();
    activated = true;
    return active;
  };
  const { runner } = makeRunner(input, bundle);

  const result = runQuietly(runner);
  const state = runner.getState();

  assert.equal(result.index, 0);
  assert.equal(state.status, 'EXHAUSTED');
  assert.equal(state.cycleCount, 1);
  assert.equal(state.nextIndex, 1);
  assert.equal(state.failure, null);
});

test('FAILED runner refuses continuation deterministically', () => {
  const input = normalizedInput();
  const bundle = makeBundle(input);
  bundle.candleEngine.getCandles = () => { throw new Error('controlled failure'); };
  const { runner } = makeRunner(input, bundle);
  assert.throws(() => runQuietly(runner), /controlled failure/);

  assert.throws(() => runner.runNextCycle(), error => error.code === 'RUNNER_FAILED');
  assert.equal(runner.hasNext(), false);
});

test('final successful cycle sets EXHAUSTED and retains its result', () => {
  const input = normalizedInput(1);
  const { bundle, runner } = makeRunner(input);

  const result = runQuietly(runner);
  const state = runner.getState();

  assert.equal(state.status, 'EXHAUSTED');
  assert.equal(state.cycleCount, 1);
  assert.equal(state.nextIndex, 1);
  assert.equal(runner.hasNext(), false);
  assert.deepEqual(state.lastResult, result);
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
