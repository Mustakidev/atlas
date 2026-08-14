const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { ReplayMtfCandleAdapterError } = require('../../src/engine/replayMtfCandleAdapter');
const { createReplayPipelineRunner } = require('../../src/engine/replayPipelineRunner');
const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');
const { normalizeReplayInput } = require('../../src/engine/replayInput');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = REPLAY_MTF_DURATIONS_MS['1h'];
const SECONDARY_TIMEFRAMES = ['1m', '5m', '15m'];
const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    if (key === 'MAX_HISTORY') return 500;
    return undefined;
  },
};

function makeClock() {
  let monotonic = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => monotonic++,
  };
}

function makePrimaryRaw(count = 51) {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index;
    const openTime = BASE_TIME + index * HOUR;
    return {
      openTime,
      timestamp: new Date(openTime).toISOString(),
      open,
      high: open + 2,
      low: open - 2,
      close: open + 1,
      volume: 10 + index,
    };
  });
}

function makePrimaryInput() {
  return normalizeReplayInput(makePrimaryRaw());
}

function makeMtfInput({ secondaryOffset = 0, secondaryRange = 1, tail = true } = {}) {
  const primaryRaw = makePrimaryRaw();
  const primaryHorizon = primaryRaw.length * HOUR;
  const timeframes = {};

  for (const timeframe of [...SECONDARY_TIMEFRAMES, '1h']) {
    const duration = REPLAY_MTF_DURATIONS_MS[timeframe];
    const count = timeframe === '1h'
      ? primaryRaw.length
      : Math.ceil(primaryHorizon / duration) + (tail ? 1 : 0);
    timeframes[timeframe] = Array.from({ length: count }, (_, index) => {
      if (timeframe === '1h') return { ...primaryRaw[index] };

      const openTime = BASE_TIME + index * duration;
      const open = 200 + secondaryOffset + index * 0.1;
      return {
        openTime,
        timestamp: new Date(openTime).toISOString(),
        open,
        high: open + secondaryRange,
        low: open - secondaryRange,
        close: open + secondaryRange / 2,
        volume: 100 + index,
      };
    });
  }

  return normalizeReplayMultiTimeframeInput({
    schemaVersion: 2,
    primaryTimeframe: '1h',
    sourcePolicy: 'independent',
    timeframes,
  });
}

function makeAnalyzerInput() {
  return normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: 'BTCUSDT',
    snapshots: Array.from({ length: 17 }, (_, index) => ({
      timestamp: new Date(BASE_TIME + index * 60_000).toISOString(),
      price: 100 + index,
      volume: 1 + index,
      change24h: index,
    })),
  });
}

function shortenSecondaryStream(normalizedMtfInput, timeframe, length) {
  const timeframes = Object.freeze({
    ...normalizedMtfInput.timeframes,
    [timeframe]: Object.freeze(normalizedMtfInput.timeframes[timeframe].slice(0, length)),
  });
  return Object.freeze({ ...normalizedMtfInput, timeframes });
}

function makeBundle(normalizedMtfInput, normalizedInput) {
  const primaryInput = normalizedInput || makePrimaryInput();
  return createReplayDependencies({
    logger,
    symbol: 'BTCUSDT',
    config,
    normalizedInput: primaryInput,
    analyzerInput: makeAnalyzerInput(),
    clock: makeClock(),
    ...(normalizedMtfInput === undefined ? {} : { normalizedMtfInput }),
  });
}

function wrapAdapter(bundle, overrides = {}) {
  const adapter = bundle.replayMtfCandleAdapter;
  return {
    prepareBoundary: overrides.prepareBoundary || adapter.prepareBoundary.bind(adapter),
    commitBoundary: overrides.commitBoundary || adapter.commitBoundary.bind(adapter),
    getCandles: adapter.getCandles.bind(adapter),
    getActive: adapter.getActive.bind(adapter),
    getAllTimeframes: adapter.getAllTimeframes.bind(adapter),
  };
}

function wrapPrimaryEngine(bundle, overrides = {}) {
  const engine = bundle.candleEngine;
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (overrides[property]) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapPaperTradeEngine(bundle, onEvaluateTrades) {
  const engine = bundle.paperTradeEngine;
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property === 'evaluateTrades') {
        return (...args) => {
          onEvaluateTrades();
          return target.evaluateTrades(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withAdapter(bundle, overrides) {
  return {
    ...bundle,
    replayMtfCandleAdapter: wrapAdapter(bundle, overrides),
  };
}

function configurePipelineFixture(bundle, observations = [], lifecycleCalls = []) {
  bundle.confluenceEngine.calculate = (candles, timeframe) => {
    if (timeframe === '1h') {
      return {
        score: 80,
        bias: 'Bullish',
        confidence: 80,
        components: {},
        missing: [],
      };
    }

    const highPath = candles.at(-1).close > 500;
    return {
      score: highPath ? 62 : 82,
      bias: 'Bullish',
      confidence: highPath ? 62 : 82,
      components: {},
      missing: [],
    };
  };
  bundle.regimeEngine.calculate = () => ({
    regime: 'TRENDING_BULL',
    confidence: 80,
    trendScore: 80,
    rangeScore: 20,
    volatility: 'Low',
    decisionReason: 'Controlled primary regime',
  });
  bundle.analyzer.getAnalysis = () => ({ trend: { '1H': 'Bullish' }, price: 125 });
  bundle.regimeDecisionEngine.evaluate = () => ({
    allowTrade: true,
    preferredDirection: 'BUY',
    penalty: 0,
    reason: 'Allowed',
  });
  bundle.advanceRiskEngine.evaluate = ({ entryPrice }) => ({
    tradeAllowed: false,
    rejectionReason: 'Fixture risk gate',
    positionSize: 0,
    stopLoss: entryPrice - 5,
    takeProfit: entryPrice + 5,
    riskReward: 1,
    session: 'ASIAN',
  });
  bundle.mtfConfirmationEngine.evaluate = ({ timeframes }) => {
    observations.push(structuredClone(timeframes));
    return {
      mtfAllowed: true,
      rejectionReason: null,
      confidence: 100,
      alignmentScore: 100,
      timeframes,
    };
  };
  const originalOnCandle = bundle.paperTradeEngine.onCandle.bind(bundle.paperTradeEngine);
  bundle.paperTradeEngine.onCandle = (candle, context) => {
    lifecycleCalls.push(candle);
    return originalOnCandle(candle, context);
  };
}

function runQuietly(operation) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return operation();
  } finally {
    console.log = originalLog;
  }
}

function runCycles(bundle, count, input) {
  const runner = createReplayPipelineRunner({ dependencies: bundle, normalizedInput: input });
  for (let index = 0; index < count; index++) runQuietly(() => runner.runNextCycle());
  return runner;
}

function advanceBoth(bundle, boundaryTime) {
  const steps = (boundaryTime - BASE_TIME) / HOUR;
  let primaryTransition = null;
  let secondaryTransition = null;
  for (let index = 1; index <= steps; index++) {
    const currentBoundary = BASE_TIME + index * HOUR;
    const primaryPlan = bundle.candleEngine.prepareBoundary({ boundaryTime: currentBoundary });
    const secondaryPlan = bundle.replayMtfCandleAdapter.prepareBoundary({ boundaryTime: currentBoundary });
    bundle.clockController.advanceTo(currentBoundary);
    primaryTransition = bundle.candleEngine.commitBoundary(primaryPlan);
    secondaryTransition = bundle.replayMtfCandleAdapter.commitBoundary(secondaryPlan);
  }
  return { primaryTransition, secondaryTransition };
}

function semanticMtfFrames(decision) {
  return decision.mtfConfirmation.timeframes;
}

function semanticAnalyzerResult(result) {
  const { analyzedAt, ...semantic } = result;
  return semantic;
}

function openPaperTrade(bundle, entryPrice = 100, stopLoss = 1, takeProfit = 1000) {
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

test('runner accepts legacy and genuine-MTF capability shapes and rejects invalid shapes at construction', () => {
  const legacy = makeBundle();
  const optIn = makeBundle(makeMtfInput());

  assert.equal(createReplayPipelineRunner({ dependencies: legacy, normalizedInput: makePrimaryInput() }).hasNext(), true);
  assert.equal(createReplayPipelineRunner({ dependencies: optIn, normalizedInput: makePrimaryInput() }).hasNext(), true);

  const { replayMtfCandleAdapter, ...viewOnly } = optIn;
  assert.throws(
    () => createReplayPipelineRunner({ dependencies: viewOnly, normalizedInput: makePrimaryInput() }),
    error => error instanceof TypeError
      && error.code === 'INVALID_DEPENDENCIES'
      && error.message === 'dependencies.replayMtfCandleAdapter and dependencies.replayCandleView must be provided together',
  );

  const { replayCandleView, ...adapterOnly } = optIn;
  assert.throws(
    () => createReplayPipelineRunner({ dependencies: adapterOnly, normalizedInput: makePrimaryInput() }),
    error => error instanceof TypeError
      && error.code === 'INVALID_DEPENDENCIES'
      && error.message === 'dependencies.replayMtfCandleAdapter and dependencies.replayCandleView must be provided together',
  );

  assert.throws(
    () => createReplayPipelineRunner({
      dependencies: { ...optIn, replayMtfCandleAdapter: {} },
      normalizedInput: makePrimaryInput(),
    }),
    error => error instanceof TypeError
      && error.code === 'INVALID_DEPENDENCIES'
      && error.message === 'dependencies.replayMtfCandleAdapter must expose prepareBoundary(), commitBoundary(), getCandles(), and getActive()',
  );

  assert.throws(
    () => createReplayPipelineRunner({
      dependencies: {
        ...optIn,
        replayCandleView: { getCandles() {}, getActive() {} },
      },
      normalizedInput: makePrimaryInput(),
    }),
    error => error instanceof TypeError
      && error.code === 'INVALID_DEPENDENCIES'
      && error.message === 'dependencies.replayCandleView must expose getCandles(), getActive(), and getAllTimeframes()',
  );
});

test('genuine-MTF runner coordinates secondary prepare, primary prepare, clock, commits, Analyzer, and pipeline', () => {
  const input = makePrimaryInput();
  const bundle = makeBundle(makeMtfInput(), input);
  const order = [];
  const originalPrimaryPrepare = bundle.candleEngine.prepareBoundary.bind(bundle.candleEngine);
  const originalPrimaryCommit = bundle.candleEngine.commitBoundary.bind(bundle.candleEngine);
  const originalClockAdvance = bundle.clockController.advanceTo.bind(bundle.clockController);
  const originalSecondaryPrepare = bundle.replayMtfCandleAdapter.prepareBoundary.bind(bundle.replayMtfCandleAdapter);
  const originalSecondaryCommit = bundle.replayMtfCandleAdapter.commitBoundary.bind(bundle.replayMtfCandleAdapter);
  const originalOrchestrator = bundle.replayAnalyzerOrchestrator.runForBoundary.bind(bundle.replayAnalyzerOrchestrator);
  const dependencies = {
    ...bundle,
    replayMtfCandleAdapter: {
      ...wrapAdapter(bundle),
      prepareBoundary(options) {
        order.push('secondary-prepare');
        return originalSecondaryPrepare(options);
      },
      commitBoundary(plan) {
        order.push('secondary-commit');
        return originalSecondaryCommit(plan);
      },
    },
    candleEngine: wrapPrimaryEngine(bundle, {
      prepareBoundary(options) {
        order.push('primary-prepare');
        return originalPrimaryPrepare(options);
      },
      commitBoundary(plan) {
        order.push('primary-commit');
        return originalPrimaryCommit(plan);
      },
    }),
    clockController: {
      advanceTo(boundaryTime) {
        order.push('clock');
        return originalClockAdvance(boundaryTime);
      },
    },
    replayAnalyzerOrchestrator: {
      runForBoundary(boundaryTime) {
        order.push('analyzer');
        return originalOrchestrator(boundaryTime);
      },
    },
  };
  dependencies.paperTradeEngine = wrapPaperTradeEngine(bundle, () => order.push('pipeline'));

  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });
  runQuietly(() => runner.runNextCycle());

  assert.deepEqual(order, [
    'secondary-prepare',
    'primary-prepare',
    'clock',
    'primary-commit',
    'secondary-commit',
    'analyzer',
    'pipeline',
  ]);
});

test('secondary prepare failure is terminal before primary preparation, clock, commit, or pipeline', () => {
  const input = makePrimaryInput();
  const bundle = makeBundle(makeMtfInput(), input);
  let primaryPrepareCalls = 0;
  let primaryCommitCalls = 0;
  let clockCalls = 0;
  let pipelineCalls = 0;
  const primary = wrapPrimaryEngine(bundle, {
    prepareBoundary() {
      primaryPrepareCalls++;
      return undefined;
    },
    commitBoundary() {
      primaryCommitCalls++;
      return undefined;
    },
  });
  const dependencies = withAdapter(bundle, {
    prepareBoundary() {
      throw new Error('controlled secondary prepare failure');
    },
  });
  dependencies.candleEngine = primary;
  dependencies.clockController = { advanceTo() { clockCalls++; } };
  dependencies.paperTradeEngine = wrapPaperTradeEngine(bundle, () => pipelineCalls++);

  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });
  assert.throws(() => runQuietly(() => runner.runNextCycle()), error => error.code === 'CYCLE_FAILED');
  const state = runner.getState();

  assert.equal(state.status, 'FAILED');
  assert.equal(state.failure.phase, 'PREPARE');
  assert.equal(state.failure.clockAdvanced, false);
  assert.equal(state.failure.commitConfirmed, false);
  assert.equal(primaryPrepareCalls, 0);
  assert.equal(primaryCommitCalls, 0);
  assert.equal(clockCalls, 0);
  assert.equal(pipelineCalls, 0);
  assert.deepEqual(bundle.candleEngine.getCandles('1h'), []);
  assert.deepEqual(bundle.replayMtfCandleAdapter.getCandles('5m'), []);
});

test('primary prepare failure leaves the successful secondary plan uncommitted', () => {
  const input = makePrimaryInput();
  const bundle = makeBundle(makeMtfInput(), input);
  let secondaryPrepareCalls = 0;
  const originalSecondaryPrepare = bundle.replayMtfCandleAdapter.prepareBoundary.bind(bundle.replayMtfCandleAdapter);
  const dependencies = withAdapter(bundle, {
    prepareBoundary(options) {
      secondaryPrepareCalls++;
      return originalSecondaryPrepare(options);
    },
  });
  dependencies.candleEngine = wrapPrimaryEngine(bundle, {
    prepareBoundary() {
      throw new Error('controlled primary prepare failure');
    },
  });

  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });
  assert.throws(() => runQuietly(() => runner.runNextCycle()), error => error.code === 'CYCLE_FAILED');
  const state = runner.getState();

  assert.equal(secondaryPrepareCalls, 1);
  assert.equal(state.failure.phase, 'PREPARE');
  assert.equal(state.failure.clockAdvanced, false);
  assert.equal(state.failure.commitConfirmed, false);
  assert.deepEqual(bundle.candleEngine.getCandles('1h'), []);
  assert.deepEqual(bundle.replayMtfCandleAdapter.getCandles('5m'), []);
});

test('retryable clock failure after both prepares preserves both owners and retries', () => {
  const input = makePrimaryInput();
  const bundle = makeBundle(makeMtfInput(), input);
  let failures = 0;
  const originalAdvance = bundle.clockController.advanceTo.bind(bundle.clockController);
  const dependencies = {
    ...bundle,
    clockController: {
      advanceTo(boundaryTime) {
        if (failures++ === 0) {
          const error = new Error('controlled retryable clock failure');
          error.retryable = true;
          throw error;
        }
        return originalAdvance(boundaryTime);
      },
    },
  };
  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });

  assert.throws(() => runQuietly(() => runner.runNextCycle()), /controlled retryable clock failure/);
  assert.deepEqual(runner.getState(), {
    status: 'READY',
    cycleCount: 0,
    lastResult: null,
    failure: null,
  });
  assert.deepEqual(bundle.candleEngine.getCandles('1h'), []);
  assert.deepEqual(bundle.replayMtfCandleAdapter.getCandles('5m'), []);

  assert.equal(runQuietly(() => runner.runNextCycle()).index, 0);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
  assert.equal(bundle.replayMtfCandleAdapter.getCandles('5m').length, 12);
});

test('secondary commit failure is terminal after confirmed primary commit and does not call pipeline', () => {
  const input = makePrimaryInput();
  const bundle = makeBundle(makeMtfInput(), input);
  let secondaryCommitCalls = 0;
  let pipelineCalls = 0;
  const dependencies = withAdapter(bundle, {
    commitBoundary() {
      secondaryCommitCalls++;
      const error = new Error('controlled secondary commit failure');
      error.code = 'SECONDARY_COMMIT_FAILED';
      throw error;
    },
  });
  dependencies.paperTradeEngine = wrapPaperTradeEngine(bundle, () => pipelineCalls++);
  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });

  assert.throws(() => runQuietly(() => runner.runNextCycle()), error => error.code === 'CYCLE_FAILED');
  const state = runner.getState();

  assert.equal(secondaryCommitCalls, 1);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.failure.phase, 'COMMIT');
  assert.equal(state.failure.clockAdvanced, true);
  assert.equal(state.failure.commitConfirmed, true);
  assert.equal(state.failure.causeCode, 'SECONDARY_COMMIT_FAILED');
  assert.equal(pipelineCalls, 0);
  assert.equal(bundle.candleEngine.getCandles('1h').length, 1);
  assert.equal(bundle.replayMtfCandleAdapter.getCandles('5m').length, 0);
  assert.throws(() => runner.runNextCycle(), error => error.code === 'RUNNER_FAILED');
  assert.equal(secondaryCommitCalls, 1);
});

test('secondary boundary result mismatch is a terminal COMMIT failure without retry', () => {
  const input = makePrimaryInput();
  const bundle = makeBundle(makeMtfInput(), input);
  let pipelineCalls = 0;
  const originalCommit = bundle.replayMtfCandleAdapter.commitBoundary.bind(bundle.replayMtfCandleAdapter);
  const dependencies = withAdapter(bundle, {
    commitBoundary(plan) {
      const result = originalCommit(plan);
      return { boundaryTime: result.boundaryTime + HOUR };
    },
  });
  dependencies.paperTradeEngine = wrapPaperTradeEngine(bundle, () => pipelineCalls++);
  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });

  assert.throws(() => runQuietly(() => runner.runNextCycle()), error => error.code === 'CYCLE_FAILED');
  const state = runner.getState();

  assert.equal(state.failure.phase, 'COMMIT');
  assert.equal(state.failure.clockAdvanced, true);
  assert.equal(state.failure.commitConfirmed, true);
  assert.equal(state.failure.causeCode, 'MTF_BOUNDARY_MISMATCH');
  assert.equal(state.failure.message, 'Replay MTF commit did not confirm boundaryTime');
  assert.equal(pipelineCalls, 0);
  assert.throws(() => runner.runNextCycle(), error => error.code === 'RUNNER_FAILED');
});

test('actual R1 MISSING_BOUNDARY errors retain cause code and name', () => {
  const input = makePrimaryInput();
  const bundle = makeBundle(makeMtfInput(), input);
  const dependencies = withAdapter(bundle, {
    prepareBoundary() {
      throw new ReplayMtfCandleAdapterError('MISSING_BOUNDARY', 'controlled missing boundary');
    },
  });
  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });

  assert.throws(() => runQuietly(() => runner.runNextCycle()), error => error.code === 'CYCLE_FAILED');
  const state = runner.getState();

  assert.equal(state.failure.phase, 'PREPARE');
  assert.equal(state.failure.causeCode, 'MISSING_BOUNDARY');
  assert.equal(state.failure.causeName, 'ReplayMtfCandleAdapterError');
  assert.equal(state.failure.commitConfirmed, false);
  assert.equal(state.failure.clockAdvanced, false);
});

test('real R1 coverage defense fails at the first uncovered secondary boundary', () => {
  const input = makePrimaryInput();
  const normalizedMtfInput = shortenSecondaryStream(makeMtfInput({ tail: false }), '5m', 240);
  assert.equal(Object.isFrozen(normalizedMtfInput), true);
  assert.equal(Object.isFrozen(normalizedMtfInput.timeframes['5m']), true);
  const bundle = makeBundle(normalizedMtfInput, input);
  let secondaryPrepareCalls = 0;
  let secondaryCommitCalls = 0;
  let primaryPrepareCalls = 0;
  let primaryCommitCalls = 0;
  let clockCalls = 0;
  let pipelineCalls = 0;
  const originalSecondaryPrepare = bundle.replayMtfCandleAdapter.prepareBoundary.bind(bundle.replayMtfCandleAdapter);
  const originalSecondaryCommit = bundle.replayMtfCandleAdapter.commitBoundary.bind(bundle.replayMtfCandleAdapter);
  const originalClockAdvance = bundle.clockController.advanceTo.bind(bundle.clockController);
  const dependencies = withAdapter(bundle, {
    prepareBoundary(options) {
      secondaryPrepareCalls++;
      return originalSecondaryPrepare(options);
    },
    commitBoundary(plan) {
      secondaryCommitCalls++;
      return originalSecondaryCommit(plan);
    },
  });
  dependencies.candleEngine = wrapPrimaryEngine(bundle, {
    prepareBoundary(options) {
      primaryPrepareCalls++;
      return bundle.candleEngine.prepareBoundary(options);
    },
    commitBoundary(plan) {
      primaryCommitCalls++;
      return bundle.candleEngine.commitBoundary(plan);
    },
  });
  dependencies.clockController = {
    advanceTo(boundaryTime) {
      clockCalls++;
      return originalClockAdvance(boundaryTime);
    },
  };
  dependencies.paperTradeEngine = wrapPaperTradeEngine(bundle, () => pipelineCalls++);
  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: input });

  for (let index = 0; index < 20; index++) runQuietly(() => runner.runNextCycle());
  const primaryCandlesBeforeFailure = bundle.candleEngine.getCandles('1h');
  const secondaryCandlesBeforeFailure = bundle.replayMtfCandleAdapter.getCandles('5m');
  const primaryActiveBeforeFailure = bundle.candleEngine.getActive('1h');
  const secondaryActiveBeforeFailure = bundle.replayMtfCandleAdapter.getActive('5m');

  assert.throws(() => runQuietly(() => runner.runNextCycle()), error => error.code === 'CYCLE_FAILED');
  const state = runner.getState();

  assert.equal(state.failure.phase, 'PREPARE');
  assert.equal(state.failure.causeCode, 'MISSING_BOUNDARY');
  assert.equal(state.failure.causeName, 'ReplayMtfCandleAdapterError');
  assert.equal(state.failure.clockAdvanced, false);
  assert.equal(state.failure.commitConfirmed, false);
  assert.equal(secondaryPrepareCalls, 21);
  assert.equal(primaryPrepareCalls, 20);
  assert.equal(clockCalls, 20);
  assert.equal(primaryCommitCalls, 20);
  assert.equal(secondaryCommitCalls, 20);
  assert.equal(pipelineCalls, 20);
  assert.equal(bundle.clock.nowMs(), BASE_TIME + 20 * HOUR);
  assert.deepEqual(bundle.candleEngine.getCandles('1h'), primaryCandlesBeforeFailure);
  assert.deepEqual(bundle.replayMtfCandleAdapter.getCandles('5m'), secondaryCandlesBeforeFailure);
  assert.strictEqual(bundle.candleEngine.getActive('1h'), primaryActiveBeforeFailure);
  assert.strictEqual(bundle.replayMtfCandleAdapter.getActive('5m'), secondaryActiveBeforeFailure);
});

test('automatic runner advancement matches equivalent manual R3A owner advancement', () => {
  const input = makePrimaryInput();
  const normalizedMtfInput = makeMtfInput();
  const automatic = makeBundle(normalizedMtfInput, input);
  const manual = makeBundle(normalizedMtfInput, input);
  const automaticObservations = [];
  const manualObservations = [];
  const automaticLifecycle = [];
  const manualLifecycle = [];
  configurePipelineFixture(automatic, automaticObservations, automaticLifecycle);
  configurePipelineFixture(manual, manualObservations, manualLifecycle);

  const runner = runCycles(automatic, 20, input);
  const boundaryTime = BASE_TIME + 20 * HOUR;
  const { primaryTransition } = advanceBoth(manual, boundaryTime);
  const manualLifecycleCandle = primaryTransition.lifecycleCandle;
  const manualPrice = primaryTransition.active === null
    ? manualLifecycleCandle.close
    : primaryTransition.active.open;
  const manualPipeline = createExecutionPipeline({
    ...manual,
    mtfCandleEngine: manual.replayCandleView,
  });
  const manualDecision = runQuietly(() => {
    manualPipeline.run({
      price: manualPrice,
      timestamp: new Date(boundaryTime).toISOString(),
    }, { lifecycleCandle: manualLifecycleCandle });
    return manualPipeline.getLastDecision();
  });

  assert.equal(runner.getState().cycleCount, 20);
  assert.strictEqual(manualLifecycleCandle, input.candles[19]);
  assert.strictEqual(manualLifecycle.at(-1), manualLifecycleCandle);
  assert.notStrictEqual(manualLifecycleCandle, primaryTransition.active);
  assert.strictEqual(automaticLifecycle.at(-1), input.candles[19]);
  assert.notStrictEqual(automaticLifecycle.at(-1), automatic.candleEngine.getActive('1h'));
  assert.deepEqual(automatic.candleEngine.getCandles('1h'), manual.candleEngine.getCandles('1h'));
  assert.deepEqual(automatic.candleEngine.getActive('1h'), manual.candleEngine.getActive('1h'));
  assert.deepEqual(
    automatic.replayMtfCandleAdapter.getCandles('5m'),
    manual.replayMtfCandleAdapter.getCandles('5m'),
  );
  assert.deepEqual(automatic.replayCandleView.getActive('5m'), manual.replayCandleView.getActive('5m'));
  assert.equal(runner.getState().lastResult.price, manualPrice);
  assert.equal(runner.getState().lastResult.timestamp, new Date(boundaryTime).toISOString());
  assert.equal(manualDecision.timestamp, new Date(boundaryTime).toISOString());
  assert.deepEqual(
    semanticMtfFrames(runner.getState().lastResult.decision),
    semanticMtfFrames(manualDecision),
  );
});

test('different genuine secondary streams change MTF fields while primary outputs remain invariant', () => {
  const input = makePrimaryInput();
  const first = makeBundle(makeMtfInput({ secondaryOffset: 0, secondaryRange: 1 }), input);
  const second = makeBundle(makeMtfInput({ secondaryOffset: 1000, secondaryRange: 20 }), input);
  const firstRealAnalyzer = first.analyzer.getAnalysis.bind(first.analyzer);
  const secondRealAnalyzer = second.analyzer.getAnalysis.bind(second.analyzer);
  const firstObservations = [];
  const secondObservations = [];
  const firstLifecycle = [];
  const secondLifecycle = [];
  configurePipelineFixture(first, firstObservations, firstLifecycle);
  configurePipelineFixture(second, secondObservations, secondLifecycle);

  const firstRunner = runCycles(first, 20, input);
  const secondRunner = runCycles(second, 20, input);
  const firstDecision = firstRunner.getState().lastResult;
  const secondDecision = secondRunner.getState().lastResult;

  assert.deepEqual(first.candleEngine.getCandles('1h'), second.candleEngine.getCandles('1h'));
  assert.deepEqual(first.candleEngine.getActive('1h'), second.candleEngine.getActive('1h'));
  assert.deepEqual(firstDecision.price, secondDecision.price);
  assert.deepEqual(firstDecision.decision.engines.atr, secondDecision.decision.engines.atr);
  assert.deepEqual(firstDecision.decision.marketRegime, secondDecision.decision.marketRegime);
  assert.deepEqual(firstDecision.decision.risk, secondDecision.decision.risk);
  const firstAnalyzer = firstRealAnalyzer();
  const secondAnalyzer = secondRealAnalyzer();
  assert.ok(firstAnalyzer);
  assert.ok(secondAnalyzer);
  assert.notEqual(firstAnalyzer.analyzedAt, undefined);
  assert.notEqual(secondAnalyzer.analyzedAt, undefined);
  assert.deepEqual(semanticAnalyzerResult(firstAnalyzer), semanticAnalyzerResult(secondAnalyzer));
  assert.deepEqual(firstLifecycle.at(-1), first.candleEngine.getCandles('1h').at(-1));
  assert.deepEqual(secondLifecycle.at(-1), second.candleEngine.getCandles('1h').at(-1));
  assert.notDeepEqual(
    semanticMtfFrames(firstDecision.decision),
    semanticMtfFrames(secondDecision.decision),
  );
  assert.notEqual(
    semanticMtfFrames(firstDecision.decision)['5m'].confluence.score,
    semanticMtfFrames(secondDecision.decision)['5m'].confluence.score,
  );
  assert.ok(firstObservations.at(-1)['5m']);
  assert.ok(secondObservations.at(-1)['5m']);
});

test('full automatic horizon leaves secondary active state null and settles from primary final price', () => {
  const input = makePrimaryInput();
  const normalizedMtfInput = makeMtfInput({ tail: false });
  const bundle = makeBundle(normalizedMtfInput, input);
  const observations = [];
  configurePipelineFixture(bundle, observations);
  const opened = openPaperTrade(bundle);
  const eodCloseCalls = [];
  const eodRiskCalls = [];
  const evaluatedPrices = [];
  const originalClose = bundle.paperTradeEngine.close.bind(bundle.paperTradeEngine);
  const originalEvaluateTrades = bundle.paperTradeEngine.evaluateTrades.bind(bundle.paperTradeEngine);
  const originalOnTradeClosed = bundle.advanceRiskEngine.onTradeClosed.bind(bundle.advanceRiskEngine);
  bundle.paperTradeEngine.close = (...args) => {
    if (args[1] === 'End of Data') eodCloseCalls.push(args);
    return originalClose(...args);
  };
  bundle.paperTradeEngine.evaluateTrades = (price, context) => {
    evaluatedPrices.push({ price, context });
    return originalEvaluateTrades(price, context);
  };
  bundle.advanceRiskEngine.onTradeClosed = (pnl, context) => {
    eodRiskCalls.push({ pnl, context });
    return originalOnTradeClosed(pnl, context);
  };
  const runner = createReplayPipelineRunner({ dependencies: bundle, normalizedInput: input });

  try {
    while (runner.hasNext()) runQuietly(() => runner.runNextCycle());
  } finally {
    bundle.paperTradeEngine.close = originalClose;
    bundle.paperTradeEngine.evaluateTrades = originalEvaluateTrades;
    bundle.advanceRiskEngine.onTradeClosed = originalOnTradeClosed;
  }

  const state = runner.getState();
  const finalCandle = input.candles.at(-1);
  const finalBoundary = finalCandle.openTime + HOUR;
  const secondaryFinalPrice = normalizedMtfInput.timeframes['5m'].at(-1).close;
  assert.equal(state.status, 'EXHAUSTED');
  assert.equal(state.cycleCount, input.candles.length);
  assert.ok(opened);
  assert.equal(eodCloseCalls.length, 1);
  assert.deepEqual(eodCloseCalls[0][2], { nowMs: finalBoundary });
  assert.equal(eodRiskCalls.length, 1);
  assert.deepEqual(eodRiskCalls[0].context, { nowMs: finalBoundary });
  assert.deepEqual(evaluatedPrices.at(-1), {
    price: finalCandle.close,
    context: { nowMs: finalBoundary },
  });
  assert.equal(bundle.paperTradeEngine.getTrade(opened.tradeId).exitPrice, finalCandle.close);
  assert.equal(bundle.paperTradeEngine.getTrade(opened.tradeId).exitTime, new Date(finalBoundary).toISOString());
  assert.notEqual(finalCandle.close, secondaryFinalPrice);
  assert.equal(state.lastResult.price, finalCandle.close);
  assert.equal(bundle.replayMtfCandleAdapter.getActive('1m'), null);
  assert.equal(bundle.replayMtfCandleAdapter.getActive('5m'), null);
  assert.equal(bundle.replayMtfCandleAdapter.getActive('15m'), null);
  assert.equal(bundle.replayCandleView.getActive('5m'), null);
  assert.equal(bundle.replayMtfCandleAdapter.getCandles('5m').length, 612);

  const finalizedBeforeExhaustionCall = bundle.replayMtfCandleAdapter.getCandles('5m');
  assert.throws(() => runner.runNextCycle(), error => error.code === 'NO_REMAINING_CANDLES');
  assert.deepEqual(bundle.replayMtfCandleAdapter.getCandles('5m'), finalizedBeforeExhaustionCall);
});
