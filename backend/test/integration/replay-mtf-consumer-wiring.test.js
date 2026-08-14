const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');
const { normalizeReplayInput } = require('../../src/engine/replayInput');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = REPLAY_MTF_DURATIONS_MS['1h'];
const SECONDARY_TIMEFRAMES = ['1m', '5m', '15m'];
const LEGACY_KEYS = [
  'candleEngine', 'indicatorRegistry', 'analyzer', 'analyzerHistory',
  'replayAnalyzerOrchestrator', 'structureEngine', 'atrEngine',
  'macdEngine', 'bollingerEngine', 'confluenceEngine', 'regimeEngine',
  'regimeDecisionEngine', 'mtfConfirmationEngine', 'mtfEngine', 'paperTradeEngine',
  'advanceRiskEngine', 'logger', 'config', 'symbol', 'clock', 'clockController',
];
const OPT_IN_KEYS = [...LEGACY_KEYS, 'replayMtfCandleAdapter', 'replayCandleView'];
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

function makeMtfInput({ secondaryOffset = 0, secondaryRange = 1 } = {}) {
  const primaryRaw = makePrimaryRaw();
  const primaryHorizon = primaryRaw.length * HOUR;
  const timeframes = {};

  for (const timeframe of [...SECONDARY_TIMEFRAMES, '1h']) {
    const duration = REPLAY_MTF_DURATIONS_MS[timeframe];
    const count = timeframe === '1h'
      ? primaryRaw.length
      : Math.ceil(primaryHorizon / duration) + 1;
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
    snapshots: [{
      timestamp: new Date(BASE_TIME).toISOString(),
      price: 100,
      volume: 1,
      change24h: 0,
    }],
  });
}

function makeBundle(normalizedMtfInput) {
  return createReplayDependencies({
    logger,
    symbol: 'BTCUSDT',
    config,
    normalizedInput: makePrimaryInput(),
    analyzerInput: makeAnalyzerInput(),
    clock: makeClock(),
    ...(normalizedMtfInput === undefined ? {} : { normalizedMtfInput }),
  });
}

function advancePrimary(bundle, boundaryTime) {
  const steps = (boundaryTime - BASE_TIME) / HOUR;
  for (let index = 1; index <= steps; index++) {
    const currentBoundary = BASE_TIME + index * HOUR;
    const plan = bundle.candleEngine.prepareBoundary({ boundaryTime: currentBoundary });
    bundle.clockController.advanceTo(currentBoundary);
    bundle.candleEngine.commitBoundary(plan);
  }
}

function advanceBoth(bundle, boundaryTime) {
  const steps = (boundaryTime - BASE_TIME) / HOUR;
  let primaryTransition;
  let secondaryTransition;
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

function stableIndicatorResult(result) {
  return {
    ready: result.ready,
    atr: result.atr,
    atrPercentage: result.atrPercentage,
    volatilityLevel: result.volatilityLevel,
    volatilityTrend: result.volatilityTrend,
    candleCount: result.candleCount,
  };
}

function configurePipeline(bundle, lowerCalls = []) {
  const primaryCalls = [];
  const originalConfluence = bundle.confluenceEngine.calculate.bind(bundle.confluenceEngine);
  bundle.confluenceEngine.calculate = (candles, timeframe) => {
    if (timeframe === '1h') {
      primaryCalls.push(candles);
      return {
        score: 80,
        bias: 'Bullish',
        confidence: 80,
        components: {},
        missing: [],
      };
    }

    lowerCalls.push({ candles, timeframe });
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
  bundle.analyzer.getAnalysis = () => ({ trend: { '1H': 'Bullish' } });
  bundle.regimeDecisionEngine.evaluate = () => ({
    allowTrade: true,
    preferredDirection: 'BUY',
    penalty: 0,
    reason: 'Allowed',
  });
  bundle.advanceRiskEngine.evaluate = ({ entryPrice }) => ({
    tradeAllowed: true,
    positionSize: 1,
    stopLoss: entryPrice - 5,
    takeProfit: entryPrice + 5,
    riskReward: 1,
    session: 'ASIAN',
  });

  return { primaryCalls, originalConfluence };
}

function runQuietly(pipeline, snapshot = { price: 121, timestamp: new Date(BASE_TIME + 20 * HOUR).toISOString() }) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    pipeline.run(snapshot);
  } finally {
    console.log = originalLog;
  }
  return pipeline.getLastDecision();
}

function createOptInPipeline(bundle, lowerCalls = []) {
  return createExecutionPipeline({
    ...bundle,
    mtfCandleEngine: bundle.replayCandleView,
  });
}

test('legacy and opt-in factory shapes remain exactly 21 and 23 keys', () => {
  const legacy = makeBundle();
  const optIn = makeBundle(makeMtfInput());

  assert.deepEqual(Object.keys(legacy), LEGACY_KEYS);
  assert.deepEqual(Object.keys(optIn), OPT_IN_KEYS);
  assert.strictEqual(legacy.mtfEngine.candleEngine, legacy.candleEngine);
  assert.strictEqual(optIn.mtfEngine.candleEngine, optIn.replayCandleView);
  assert.strictEqual(legacy.atrEngine.candleEngine, legacy.candleEngine);
  assert.strictEqual(optIn.atrEngine.candleEngine, optIn.candleEngine);
});

test('opt-in graph starts empty and only manual owner advancement exposes secondary candles', () => {
  const mtfInput = makeMtfInput();
  const bundle = makeBundle(mtfInput);
  const boundaryTime = BASE_TIME + 20 * HOUR;

  assert.deepEqual(bundle.replayMtfCandleAdapter.getCandles('5m'), []);
  assert.deepEqual(bundle.replayCandleView.getCandles('5m'), []);

  advanceBoth(bundle, boundaryTime);

  const candles = bundle.replayCandleView.getCandles('5m');
  assert.equal(candles.length, 240);
  assert.strictEqual(candles[0], mtfInput.timeframes['5m'][0]);
  assert.equal(candles.at(-1).closeTime, boundaryTime);
  assert.equal(bundle.replayCandleView.getActive('5m').openTime, boundaryTime);
});

test('MTFEngine uses the combined view while legacy MTFEngine remains primary-only', () => {
  const boundaryTime = BASE_TIME + 20 * HOUR;
  const legacy = makeBundle();
  const optIn = makeBundle(makeMtfInput());

  advancePrimary(legacy, boundaryTime);
  advanceBoth(optIn, boundaryTime);

  const legacyResult = legacy.mtfEngine.calculate(100);
  const optInResult = optIn.mtfEngine.calculate(100);

  assert.equal(legacyResult.timeframes['1m'].candleCount, 0);
  assert.equal(legacyResult.timeframes['5m'].candleCount, 0);
  assert.equal(legacyResult.timeframes['15m'].candleCount, 0);
  assert.equal(legacyResult.timeframes['1h'].candleCount, 20);
  assert.equal(optInResult.timeframes['1m'].candleCount, 100);
  assert.equal(optInResult.timeframes['5m'].candleCount, 100);
  assert.equal(optInResult.timeframes['15m'].candleCount, 80);
  assert.equal(optInResult.timeframes['1h'].candleCount, 20);
});

test('pipeline fallback keeps legacy MTF reads on the primary owner', () => {
  const bundle = makeBundle();
  const boundaryTime = BASE_TIME + 20 * HOUR;
  const lowerCalls = [];
  const { primaryCalls } = configurePipeline(bundle, lowerCalls);
  advancePrimary(bundle, boundaryTime);
  bundle.clockController.advanceTo(boundaryTime);

  const pipeline = createExecutionPipeline({ ...bundle });
  const decision = runQuietly(pipeline);

  assert.equal(primaryCalls.length > 0, true);
  assert.strictEqual(primaryCalls[0][0], bundle.candleEngine.getCandles('1h')[0]);
  assert.deepEqual(lowerCalls, []);
  assert.deepEqual(Object.keys(decision.mtfConfirmation.timeframes), ['1h']);
  assert.strictEqual(bundle.atrEngine.candleEngine, bundle.candleEngine);
});

test('pipeline MTF owner consumes genuine finalized secondary arrays and preserves primary lifecycle input', () => {
  const mtfInput = makeMtfInput({ secondaryOffset: 0, secondaryRange: 1 });
  const bundle = makeBundle(mtfInput);
  const boundaryTime = BASE_TIME + 20 * HOUR;
  const lowerCalls = [];
  let primaryCalls;
  const lifecycleCalls = [];
  const originalOnCandle = bundle.paperTradeEngine.onCandle.bind(bundle.paperTradeEngine);
  bundle.paperTradeEngine.onCandle = (candle, context) => {
    lifecycleCalls.push({ candle, context });
    return originalOnCandle(candle, context);
  };

  advanceBoth(bundle, boundaryTime);
  primaryCalls = configurePipeline(bundle, lowerCalls).primaryCalls;
  const pipeline = createOptInPipeline(bundle, lowerCalls);
  const decision = runQuietly(pipeline);

  const fiveMinuteCall = lowerCalls.find(call => call.timeframe === '5m');
  assert.ok(fiveMinuteCall);
  assert.strictEqual(fiveMinuteCall.candles.at(-1), mtfInput.timeframes['5m'][239]);
  assert.equal(fiveMinuteCall.candles.at(-1).closeTime, boundaryTime);
  assert.equal(primaryCalls.length > 0, true);
  assert.ok(decision.mtfConfirmation);
  assert.deepEqual(Object.keys(decision.mtfConfirmation.timeframes), ['1m', '5m', '15m', '1h']);
  assert.equal(lifecycleCalls.length, 1);
  assert.strictEqual(lifecycleCalls[0].candle, bundle.candleEngine.getActive('1h'));
  assert.notStrictEqual(lifecycleCalls[0].candle, bundle.replayCandleView.getActive('5m'));
});

test('dedicated MTF ATR changes with secondary volatility while main ATR stays primary-equivalent', () => {
  const boundaryTime = BASE_TIME + 20 * HOUR;
  const lowVolatility = makeBundle(makeMtfInput({ secondaryOffset: 0, secondaryRange: 1 }));
  const highVolatility = makeBundle(makeMtfInput({ secondaryOffset: 1000, secondaryRange: 20 }));

  advanceBoth(lowVolatility, boundaryTime);
  advanceBoth(highVolatility, boundaryTime);

  const lowCalls = [];
  const highCalls = [];
  configurePipeline(lowVolatility, lowCalls);
  configurePipeline(highVolatility, highCalls);
  const lowPipeline = createOptInPipeline(lowVolatility, lowCalls);
  const highPipeline = createOptInPipeline(highVolatility, highCalls);
  const lowDecision = runQuietly(lowPipeline);
  const highDecision = runQuietly(highPipeline);

  assert.deepEqual(
    stableIndicatorResult(lowVolatility.atrEngine.calculate('1h')),
    stableIndicatorResult(highVolatility.atrEngine.calculate('1h')),
  );
  assert.notEqual(
    lowDecision.mtfConfirmation.timeframes['1m'].volatilityLevel,
    highDecision.mtfConfirmation.timeframes['1m'].volatilityLevel,
  );
  assert.equal(lowCalls.find(call => call.timeframe === '1m').candles.at(-1).close > 0, true);
  assert.equal(highCalls.find(call => call.timeframe === '1m').candles.at(-1).close > 500, true);
});

test('independent secondary paths change MTF confirmation fields without changing primary fields', () => {
  const boundaryTime = BASE_TIME + 20 * HOUR;
  const first = makeBundle(makeMtfInput({ secondaryOffset: 0, secondaryRange: 1 }));
  const second = makeBundle(makeMtfInput({ secondaryOffset: 1000, secondaryRange: 20 }));
  const firstCalls = [];
  const secondCalls = [];
  configurePipeline(first, firstCalls);
  configurePipeline(second, secondCalls);
  advanceBoth(first, boundaryTime);
  advanceBoth(second, boundaryTime);

  const firstDecision = runQuietly(createOptInPipeline(first, firstCalls));
  const secondDecision = runQuietly(createOptInPipeline(second, secondCalls));

  assert.deepEqual(
    firstDecision.engines.atr,
    secondDecision.engines.atr,
  );
  assert.deepEqual(
    firstDecision.marketRegime,
    secondDecision.marketRegime,
  );
  assert.notDeepEqual(
    firstDecision.mtfConfirmation.timeframes,
    secondDecision.mtfConfirmation.timeframes,
  );
  assert.notEqual(
    firstDecision.mtfConfirmation.timeframes['5m'].confluence.score,
    secondDecision.mtfConfirmation.timeframes['5m'].confluence.score,
  );
  assert.equal(firstCalls.some(call => call.timeframe === '5m'), true);
  assert.equal(secondCalls.some(call => call.timeframe === '5m'), true);
});

test('primary engines remain primary-backed and calculateAll key shapes stay unchanged', () => {
  const bundle = makeBundle(makeMtfInput());
  const boundaryTime = BASE_TIME + 20 * HOUR;
  advanceBoth(bundle, boundaryTime);

  assert.strictEqual(bundle.atrEngine.candleEngine, bundle.candleEngine);
  assert.strictEqual(bundle.macdEngine.candleEngine, bundle.candleEngine);
  assert.strictEqual(bundle.bollingerEngine.candleEngine, bundle.candleEngine);
  assert.strictEqual(bundle.confluenceEngine.candleEngine, bundle.candleEngine);
  assert.strictEqual(bundle.regimeEngine.candleEngine, bundle.candleEngine);

  assert.deepEqual(Object.keys(bundle.atrEngine.calculateAll()), ['1h']);
  assert.deepEqual(Object.keys(bundle.macdEngine.calculateAll()), ['1h']);
  assert.deepEqual(Object.keys(bundle.bollingerEngine.calculateAll()), ['1h']);
  assert.deepEqual(Object.keys(bundle.confluenceEngine.calculateAll()), ['1h']);
  assert.deepEqual(Object.keys(bundle.regimeEngine.calculateAll()), ['1h']);
});

test('separate opt-in graphs do not share primary or secondary state', () => {
  const input = makeMtfInput();
  const first = makeBundle(input);
  const second = makeBundle(input);

  advanceBoth(first, BASE_TIME + 20 * HOUR);

  assert.equal(first.candleEngine.getCandles('1h').length, 20);
  assert.equal(first.replayMtfCandleAdapter.getCandles('5m').length, 240);
  assert.equal(second.candleEngine.getCandles('1h').length, 0);
  assert.equal(second.replayMtfCandleAdapter.getCandles('5m').length, 0);
  assert.notStrictEqual(first.mtfEngine, second.mtfEngine);
  assert.notStrictEqual(first.mtfEngine.candleEngine, second.mtfEngine.candleEngine);
});
