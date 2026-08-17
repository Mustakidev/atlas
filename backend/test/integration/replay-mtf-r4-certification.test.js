const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { createReplayPipelineRunner } = require('../../src/engine/replayPipelineRunner');
const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');
const { normalizeReplayInput } = require('../../src/engine/replayInput');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = REPLAY_MTF_DURATIONS_MS['1h'];
const PRIMARY_COUNT = 520;
const SECONDARY_TIMEFRAMES = ['1m', '5m', '15m'];
const DIAGNOSTIC_KEYS = new Set([
  'analyzedAt',
  'calculatedAt',
  'lastUpdated',
  'calculationTime',
  'analysisTime',
  'executionTime',
]);

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

function makePrimaryRaw() {
  return Array.from({ length: PRIMARY_COUNT }, (_, index) => {
    const open = 100 + index * 2;
    const openTime = BASE_TIME + index * HOUR;
    return {
      openTime,
      timestamp: new Date(openTime).toISOString(),
      open,
      high: open + 1.5,
      low: open - 0.5,
      close: open + 1,
      volume: 100 + index,
    };
  });
}

function makeAnalyzerRaw(primaryRaw) {
  return Array.from({ length: primaryRaw.length + 1 }, (_, index) => {
    const source = primaryRaw[Math.min(index, primaryRaw.length - 1)];
    return {
      timestamp: new Date(BASE_TIME + index * HOUR).toISOString(),
      price: index === primaryRaw.length ? source.close : source.close,
      volume: source.volume,
      change24h: index,
    };
  });
}

function makeInputs({ secondaryOffset = 0, secondaryRange = 0.5 } = {}) {
  const primaryRaw = makePrimaryRaw();
  const timeframes = {};

  for (const timeframe of [...SECONDARY_TIMEFRAMES, '1h']) {
    const duration = REPLAY_MTF_DURATIONS_MS[timeframe];
    const count = timeframe === '1h'
      ? primaryRaw.length
      : (primaryRaw.length * HOUR) / duration;

    timeframes[timeframe] = Array.from({ length: count }, (_, index) => {
      if (timeframe === '1h') return { ...primaryRaw[index] };

      const openTime = BASE_TIME + index * duration;
      const open = 200 + secondaryOffset + index * 0.01;
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

  return {
    normalizedInput: normalizeReplayInput(primaryRaw),
    normalizedMtfInput: normalizeReplayMultiTimeframeInput({
      schemaVersion: 2,
      primaryTimeframe: '1h',
      sourcePolicy: 'independent',
      timeframes,
    }),
    analyzerInput: normalizeReplayAnalyzerInput({
      schemaVersion: 1,
      symbol: 'BTCUSDT',
      snapshots: makeAnalyzerRaw(primaryRaw),
    }),
  };
}

function assertCausalAnalyzerState(bundle, analyzerInput, boundaryTime) {
  const selectedEventTimestampMs = bundle.analyzerHistory.getEventTimestamp();
  const expectedEvent = analyzerInput.snapshots
    .filter(snapshot => Date.parse(snapshot.timestamp) <= boundaryTime)
    .at(-1);

  assert.ok(expectedEvent, `Analyzer source has no event at or before ${boundaryTime}`);
  assert.ok(Number.isSafeInteger(selectedEventTimestampMs));
  assert.ok(selectedEventTimestampMs <= boundaryTime, `Analyzer future event leaked at ${boundaryTime}`);

  const selectedEventTimestamp = new Date(selectedEventTimestampMs).toISOString();
  assert.equal(selectedEventTimestamp, expectedEvent.timestamp);

  return {
    boundaryTime,
    selectedEventTimestamp,
    expectedEventTimestamp: expectedEvent.timestamp,
  };
}

function semantic(value, path = []) {
  if (Array.isArray(value)) return value.map((item, index) => semantic(item, [...path, index]));
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (DIAGNOSTIC_KEYS.has(key)) continue;
    if (key === 'timestamp' && path.some(part => part === 'mtf' || part === 'mtfConfirmation')) continue;
    result[key] = semantic(nested, [...path, key]);
  }
  return result;
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

function makeBundle(inputs) {
  return createReplayDependencies({
    logger,
    symbol: 'BTCUSDT',
    config,
    normalizedInput: inputs.normalizedInput,
    normalizedMtfInput: inputs.normalizedMtfInput,
    analyzerInput: inputs.analyzerInput,
    clock: makeClock(),
  });
}

function assertCausalSecondaryState(adapter, normalizedMtfInput, boundaryTime) {
  for (const timeframe of SECONDARY_TIMEFRAMES) {
    const source = normalizedMtfInput.timeframes[timeframe];
    const finalized = adapter.getCandles(timeframe);
    const expected = source.filter(candle => candle.closeTime <= boundaryTime);

    assert.equal(finalized.length, expected.length, `${timeframe} finalized count at ${boundaryTime}`);
    for (let index = 0; index < finalized.length; index++) {
      assert.strictEqual(finalized[index], expected[index], `${timeframe} source identity at ${boundaryTime}`);
      assert.ok(finalized[index].closeTime <= boundaryTime, `${timeframe} future close leaked`);
      assert.ok(finalized[index].openTime <= boundaryTime, `${timeframe} future open leaked`);
    }
    assert.equal(finalized.some(candle => candle.openTime > boundaryTime), false);

    const active = adapter.getActive(timeframe);
    const activeSource = source.find(candle => candle.openTime === boundaryTime);
    if (activeSource === undefined) {
      assert.equal(active, null, `${timeframe} active state exists without a source at boundary`);
      continue;
    }

    assert.ok(active, `${timeframe} source at boundary is missing an active projection`);
    assert.equal(active.openTime, boundaryTime, `${timeframe} active projection boundary`);
    assert.equal(active.open, activeSource.open, `${timeframe} active projection source open`);
    assert.equal(active.high, active.open, `${timeframe} active projection high`);
    assert.equal(active.low, active.open, `${timeframe} active projection low`);
    assert.equal(active.close, active.open, `${timeframe} active projection close`);
    assert.equal(active.volume, 0, `${timeframe} active projection volume`);
    assert.equal(source.includes(active), false, `${timeframe} active projection is fabricated as source`);
  }
}

function wrapCausalAdapter(bundle, normalizedMtfInput, observations) {
  const adapter = bundle.replayMtfCandleAdapter;
  return {
    ...bundle,
    replayMtfCandleAdapter: {
      prepareBoundary: adapter.prepareBoundary.bind(adapter),
      commitBoundary(plan) {
        const transition = adapter.commitBoundary(plan);
        assertCausalSecondaryState(adapter, normalizedMtfInput, transition.boundaryTime);
        observations.push({
          boundaryTime: transition.boundaryTime,
          finalizedCounts: Object.fromEntries(SECONDARY_TIMEFRAMES.map(timeframe => [
            timeframe,
            adapter.getCandles(timeframe).length,
          ])),
          active: Object.fromEntries(SECONDARY_TIMEFRAMES.map(timeframe => [
            timeframe,
            semantic(adapter.getActive(timeframe)),
          ])),
        });
        return transition;
      },
      getCandles: adapter.getCandles.bind(adapter),
      getActive: adapter.getActive.bind(adapter),
      getAllTimeframes: adapter.getAllTimeframes.bind(adapter),
    },
  };
}

function installLifecycleCapture(bundle, normalizedInput, lifecycleIndices) {
  const originalOnCandle = bundle.paperTradeEngine.onCandle.bind(bundle.paperTradeEngine);
  bundle.paperTradeEngine.onCandle = (candle, context) => {
    lifecycleIndices.push(normalizedInput.candles.indexOf(candle));
    return originalOnCandle(candle, context);
  };
}

function installEodCapture(bundle, eod) {
  const originalClose = bundle.paperTradeEngine.close.bind(bundle.paperTradeEngine);
  const originalRiskClosed = bundle.advanceRiskEngine.onTradeClosed.bind(bundle.advanceRiskEngine);

  bundle.paperTradeEngine.close = (...args) => {
    if (args[1] === 'End of Data') eod.close.push(structuredClone(args));
    return originalClose(...args);
  };
  bundle.advanceRiskEngine.onTradeClosed = (...args) => {
    eod.risk.push(structuredClone(args));
    return originalRiskClosed(...args);
  };
}

function openCertificationTrade(bundle) {
  return bundle.paperTradeEngine.signal({
    trend: { trend: { '1H': 'Bullish' } },
    structure: { ready: true, direction: 'bullish', structure: 'Bullish', score: 80 },
    rsi: { ready: true, value: 70, state: 'Overbought' },
    ema: { ready: true, value: 110, trend: 'Above' },
    macd: { ready: true, trend: 'Bullish', histogram: 1 },
    bollinger: { ready: false },
    confluence: { bias: 'Bullish', score: 80, confidence: 80 },
    mtf: { overallBias: 'Bullish', timeframeAgreement: 100 },
  }, 100, '1h', 'BUY', {
    stopLoss: 1,
    takeProfit: 1_000_000,
    positionSize: 1,
    riskReward: 1,
  });
}

function primaryAuthority(bundle, inputs, index, lifecycleIndices) {
  const finalized = bundle.candleEngine.getCandles('1h');
  const boundaryTime = inputs.normalizedInput.candles[index].openTime + HOUR;
  assert.equal(finalized.length, index + 1, `primary finalized count at ${index}`);
  assert.strictEqual(finalized.at(-1), inputs.normalizedInput.candles[index]);

  const active = bundle.candleEngine.getActive('1h');
  if (active === null) {
    assert.equal(index, inputs.normalizedInput.candles.length - 1);
  } else {
    assert.equal(active.openTime, boundaryTime);
    assert.equal(active.high, active.open);
    assert.equal(active.low, active.open);
    assert.equal(active.close, active.open);
    assert.equal(active.volume, 0);
  }

  return {
    finalizedCount: finalized.length,
    active: semantic(active),
    lifecycleIndex: lifecycleIndices.at(-1),
  };
}

function collectFinalState(bundle, runnerState, inputs) {
  return semantic({
    runner: runnerState,
    primary: {
      finalizedCount: bundle.candleEngine.getCandles('1h').length,
      active: bundle.candleEngine.getActive('1h'),
    },
    secondary: Object.fromEntries(SECONDARY_TIMEFRAMES.map(timeframe => [timeframe, {
      finalizedCount: bundle.replayMtfCandleAdapter.getCandles(timeframe).length,
      active: bundle.replayMtfCandleAdapter.getActive(timeframe),
    }])),
    analyzer: bundle.analyzer.getAnalysis(),
    analyzerHistory: bundle.analyzerHistory.all(),
    analyzerEventTimestamp: bundle.analyzerHistory.getEventTimestamp(),
    paper: {
      all: bundle.paperTradeEngine.all(),
      open: bundle.paperTradeEngine.open(),
      closed: bundle.paperTradeEngine.closed(),
      balance: bundle.paperTradeEngine.getBalance(),
      stats: bundle.paperTradeEngine.stats(),
    },
    risk: bundle.advanceRiskEngine.getState(),
    clock: inputs.normalizedInput.candles.at(-1).openTime + HOUR,
  });
}

function runAutomatic(inputs, { openTrade = false } = {}) {
  const bundle = makeBundle(inputs);
  const observations = [];
  const lifecycleIndices = [];
  const eod = { close: [], risk: [] };
  const dependencies = wrapCausalAdapter(bundle, inputs.normalizedMtfInput, observations);
  installLifecycleCapture(bundle, inputs.normalizedInput, lifecycleIndices);
  installEodCapture(bundle, eod);
  const trade = openTrade ? openCertificationTrade(bundle) : null;
  const runner = createReplayPipelineRunner({ dependencies, normalizedInput: inputs.normalizedInput });
  const cycles = [];
  const primaryAuthoritySnapshots = [];
  const analyzerSnapshots = [];
  const analyzerObservations = [];

  assert.equal(bundle.mtfConfirmationEngine.constructor.name, 'MTFConfirmationEngine');
  while (runner.hasNext()) {
    const result = runQuietly(() => runner.runNextCycle());
    const index = result.index;
    const boundaryTime = inputs.normalizedInput.candles[index].openTime + HOUR;
    assert.equal(result.timestamp, new Date(boundaryTime).toISOString());
    assert.equal(observations.at(-1).boundaryTime, boundaryTime);
    analyzerObservations.push(assertCausalAnalyzerState(
      bundle,
      inputs.analyzerInput,
      boundaryTime,
    ));

    cycles.push(semantic(result));
    primaryAuthoritySnapshots.push(primaryAuthority(bundle, inputs, index, lifecycleIndices));
    analyzerSnapshots.push(semantic(bundle.analyzer.getAnalysis()));
  }

  const state = runner.getState();
  assert.equal(state.status, 'EXHAUSTED');
  assert.equal(state.cycleCount, PRIMARY_COUNT);
  assert.equal(observations.length, PRIMARY_COUNT);
  assert.equal(lifecycleIndices.length, PRIMARY_COUNT);
  assert.ok(lifecycleIndices.every((sourceIndex, index) => sourceIndex === index));

  const finalCandle = inputs.normalizedInput.candles.at(-1);
  const finalBoundary = finalCandle.openTime + HOUR;
  assert.equal(state.lastResult.price, finalCandle.close);
  assert.equal(state.lastResult.timestamp, new Date(finalBoundary).toISOString());
  for (const timeframe of SECONDARY_TIMEFRAMES) {
    assert.equal(bundle.replayMtfCandleAdapter.getActive(timeframe), null);
  }

  const beforeExhaustion = collectFinalState(bundle, state, inputs);
  assert.throws(() => runner.runNextCycle(), error => error.code === 'NO_REMAINING_CANDLES');
  assert.deepEqual(collectFinalState(bundle, runner.getState(), inputs), beforeExhaustion);

  if (openTrade) {
    assert.ok(trade);
    assert.equal(eod.close.length, 1);
    assert.equal(eod.close[0][1], 'End of Data');
    assert.deepEqual(eod.close[0][2], { nowMs: finalBoundary });
    assert.equal(eod.risk.length, 1);
    assert.deepEqual(eod.risk[0][1], { nowMs: finalBoundary });
    assert.equal(bundle.paperTradeEngine.getTrade(trade.tradeId).exitPrice, finalCandle.close);
    assert.equal(bundle.paperTradeEngine.getTrade(trade.tradeId).exitTime, new Date(finalBoundary).toISOString());
  }

  return {
    bundle,
    inputs,
    runner,
    cycles,
    observations,
    primaryAuthoritySnapshots,
    analyzerSnapshots,
    analyzerObservations,
    finalState: beforeExhaustion,
    eod,
  };
}

function runManual(inputs, { openTrade = false } = {}) {
  const bundle = makeBundle(inputs);
  const lifecycleIndices = [];
  const eod = { close: [], risk: [] };
  installLifecycleCapture(bundle, inputs.normalizedInput, lifecycleIndices);
  installEodCapture(bundle, eod);
  const trade = openTrade ? openCertificationTrade(bundle) : null;
  const pipeline = createExecutionPipeline({
    ...bundle,
    mtfCandleEngine: bundle.replayCandleView,
  });
  const cycles = [];
  const analyzerObservations = [];

  for (let index = 0; index < PRIMARY_COUNT; index++) {
    const sourceCandle = inputs.normalizedInput.candles[index];
    const boundaryTime = sourceCandle.openTime + HOUR;
    const secondaryPlan = bundle.replayMtfCandleAdapter.prepareBoundary({ boundaryTime });
    const primaryPlan = bundle.candleEngine.prepareBoundary({ boundaryTime });
    bundle.clockController.advanceTo(boundaryTime);
    const primaryTransition = bundle.candleEngine.commitBoundary(primaryPlan);
    const secondaryTransition = bundle.replayMtfCandleAdapter.commitBoundary(secondaryPlan);

    assert.equal(secondaryTransition.boundaryTime, boundaryTime);
    assert.equal(primaryTransition.sourceIndex, index);
    assert.strictEqual(primaryTransition.lifecycleCandle, sourceCandle);

    const price = primaryTransition.active === null
      ? sourceCandle.close
      : primaryTransition.active.open;
    bundle.replayAnalyzerOrchestrator.runForBoundary(boundaryTime);
    analyzerObservations.push(assertCausalAnalyzerState(
      bundle,
      inputs.analyzerInput,
      boundaryTime,
    ));
    runQuietly(() => pipeline.run({
      price,
      timestamp: new Date(boundaryTime).toISOString(),
    }, { lifecycleCandle: primaryTransition.lifecycleCandle }));

    cycles.push(semantic({
      index,
      openTime: sourceCandle.openTime,
      timestamp: new Date(boundaryTime).toISOString(),
      price,
      decision: pipeline.getLastDecision(),
    }));
  }

  const finalBoundary = inputs.normalizedInput.candles.at(-1).openTime + HOUR;
  for (const candidate of bundle.paperTradeEngine.open()) {
    const closedTrade = bundle.paperTradeEngine.close(candidate.tradeId, 'End of Data', { nowMs: finalBoundary });
    bundle.advanceRiskEngine.onTradeClosed(closedTrade.pnl, { nowMs: finalBoundary });
  }

  const runnerState = {
    status: 'EXHAUSTED',
    cycleCount: PRIMARY_COUNT,
    lastResult: {
      ...cycles.at(-1),
    },
    failure: null,
  };

  assert.ok(lifecycleIndices.every((sourceIndex, index) => sourceIndex === index));
  if (openTrade) {
    assert.ok(trade);
    assert.equal(eod.close.length, 1);
    assert.equal(eod.close[0][1], 'End of Data');
    assert.deepEqual(eod.close[0][2], { nowMs: finalBoundary });
    assert.equal(eod.risk.length, 1);
    assert.deepEqual(eod.risk[0][1], { nowMs: finalBoundary });
    assert.equal(bundle.paperTradeEngine.getTrade(trade.tradeId).exitPrice, inputs.normalizedInput.candles.at(-1).close);
  }

  return {
    bundle,
    inputs,
    cycles,
    lifecycleIndices,
    analyzerObservations,
    finalState: collectFinalState(bundle, runnerState, inputs),
  };
}

function primarySemanticCycle(cycle) {
  const decision = cycle.decision;
  return semantic({
    index: cycle.index,
    openTime: cycle.openTime,
    timestamp: cycle.timestamp,
    price: cycle.price,
    engines: {
      trend: decision.engines.trend,
      structure: decision.engines.structure,
      rsi: decision.engines.rsi,
      ema: decision.engines.ema,
      macd: decision.engines.macd,
      atr: decision.engines.atr,
      bollinger: decision.engines.bollinger,
    },
    confluence: decision.confluence,
    marketRegime: decision.marketRegime,
    risk: decision.risk,
  });
}

test('MTF-R4 certifies long-horizon determinism, causality, terminal EOD, and exhaustion', () => {
  const first = runAutomatic(makeInputs(), { openTrade: true });
  const second = runAutomatic(makeInputs(), { openTrade: true });

  assert.equal(first.inputs.normalizedInput.candles.length, 520);
  assert.equal(first.inputs.normalizedMtfInput.timeframes['1m'].length, 31_200);
  assert.equal(first.inputs.normalizedMtfInput.timeframes['5m'].length, 6_240);
  assert.equal(first.inputs.normalizedMtfInput.timeframes['15m'].length, 2_080);
  assert.equal(first.inputs.normalizedMtfInput.timeframes['1h'].length, 520);
  assert.equal(first.inputs.analyzerInput.snapshots.length, 521);

  assert.deepEqual(first.cycles, second.cycles);
  assert.deepEqual(first.observations, second.observations);
  assert.deepEqual(first.primaryAuthoritySnapshots, second.primaryAuthoritySnapshots);
  assert.deepEqual(first.analyzerSnapshots, second.analyzerSnapshots);
  assert.deepEqual(first.analyzerObservations, second.analyzerObservations);
  assert.deepEqual(first.finalState, second.finalState);
  assert.equal(first.finalState.runner.status, 'EXHAUSTED');
  assert.equal(first.finalState.runner.cycleCount, 520);
  assert.equal(first.finalState.secondary['1m'].active, null);
  assert.equal(first.finalState.secondary['5m'].active, null);
  assert.equal(first.finalState.secondary['15m'].active, null);
  assert.equal(first.finalState.primary.active, null);
  assert.equal(first.finalState.clock, BASE_TIME + PRIMARY_COUNT * HOUR);
  assert.equal(first.finalState.analyzerEventTimestamp, BASE_TIME + PRIMARY_COUNT * HOUR);
  assert.equal(first.finalState.secondary['1m'].finalizedCount, 31_200);
  assert.equal(first.finalState.secondary['5m'].finalizedCount, 6_240);
  assert.equal(first.finalState.secondary['15m'].finalizedCount, 2_080);
  assert.equal(first.finalState.primary.finalizedCount, 520);
});

test('MTF-R4 proves genuine secondary influence while preserving primary authority', () => {
  const low = runAutomatic(makeInputs({ secondaryOffset: 0, secondaryRange: 0.5 }));
  const high = runAutomatic(makeInputs({ secondaryOffset: 1000, secondaryRange: 20 }));

  assert.deepEqual(
    low.cycles.map(primarySemanticCycle),
    high.cycles.map(primarySemanticCycle),
  );
  assert.deepEqual(low.primaryAuthoritySnapshots, high.primaryAuthoritySnapshots);
  assert.deepEqual(low.analyzerSnapshots, high.analyzerSnapshots);
  assert.deepEqual(low.analyzerObservations, high.analyzerObservations);
  assert.deepEqual(low.finalState.primary, high.finalState.primary);
  assert.deepEqual(low.finalState.analyzer, high.finalState.analyzer);
  assert.deepEqual(low.finalState.risk, high.finalState.risk);

  const lowMtfCycles = low.cycles
    .map((cycle, index) => ({ index, mtf: cycle.decision.mtfConfirmation }))
    .filter(({ mtf }) => mtf);
  const highMtfCycles = high.cycles
    .map((cycle, index) => ({ index, mtf: cycle.decision.mtfConfirmation }))
    .filter(({ mtf }) => mtf);
  assert.ok(lowMtfCycles.length > 0);
  assert.ok(highMtfCycles.length > 0);
  assert.deepEqual(
    lowMtfCycles.map(({ index }) => index),
    highMtfCycles.map(({ index }) => index),
  );
  assert.ok(lowMtfCycles.some(({ index, mtf }) =>
    JSON.stringify(mtf) !== JSON.stringify(high.cycles[index].decision.mtfConfirmation)));
});

test('MTF-R4 proves full-horizon runner equivalence with independent orchestration', () => {
  const inputs = makeInputs();
  const automatic = runAutomatic(inputs, { openTrade: true });
  const manual = runManual(makeInputs(), { openTrade: true });

  assert.deepEqual(automatic.cycles, manual.cycles);
  assert.deepEqual(
    automatic.primaryAuthoritySnapshots.map(snapshot => snapshot.lifecycleIndex),
    manual.lifecycleIndices,
  );
  assert.deepEqual(automatic.analyzerObservations, manual.analyzerObservations);
  assert.deepEqual(automatic.finalState, manual.finalState);
  assert.equal(automatic.finalState.runner.status, 'EXHAUSTED');
  assert.equal(manual.finalState.runner.status, 'EXHAUSTED');
  assert.equal(automatic.finalState.primary.finalizedCount, PRIMARY_COUNT);
  assert.equal(manual.finalState.primary.finalizedCount, PRIMARY_COUNT);
  assert.equal(automatic.finalState.secondary['1m'].finalizedCount, 31_200);
  assert.equal(manual.finalState.secondary['1m'].finalizedCount, 31_200);
});
