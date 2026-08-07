const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const FIXED_ISO = '2024-01-01T00:00:00.000Z';

const logger = { info() {}, warn() {}, error() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  },
};

function makeActiveCandle(overrides = {}) {
  return {
    openTime: 20 * 3600000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    timestamp: new Date(20 * 3600000).toISOString(),
    ...overrides,
  };
}

function makeFinalizedCandles() {
  return Array.from({ length: 20 }, (_, index) => ({
    openTime: index * 3600000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    timestamp: new Date(index * 3600000).toISOString(),
  }));
}

function makeSignalEngines(direction = 'BUY') {
  const bullish = direction === 'BUY';
  return {
    trend: { trend: { '1H': bullish ? 'Bullish' : 'Bearish' } },
    structure: { ready: true, direction: bullish ? 'bullish' : 'bearish', structure: bullish ? 'Bullish' : 'Bearish', score: 80 },
    rsi: { ready: true, value: bullish ? 70 : 30, state: bullish ? 'Overbought' : 'Oversold' },
    ema: { ready: true, value: 110, trend: bullish ? 'Above' : 'Below' },
    macd: { ready: true, trend: bullish ? 'Bullish' : 'Bearish', histogram: bullish ? 1 : -1 },
    bollinger: { ready: true, pricePosition: 'Inside Bands' },
    confluence: { bias: bullish ? 'Bullish' : 'Bearish', score: bullish ? 80 : 20, confidence: 80 },
    mtf: { overallBias: bullish ? 'Bullish' : 'Bearish', timeframeAgreement: 100 },
  };
}

function openTrade(paperTradeEngine, direction = 'BUY') {
  const plan = direction === 'BUY'
    ? { stopLoss: 96, takeProfit: 106, positionSize: 25, riskReward: 2.5 }
    : { stopLoss: 104, takeProfit: 96, positionSize: 25, riskReward: 2 };
  const trade = paperTradeEngine.signal(makeSignalEngines(direction), 100, '1h', direction, plan);
  assert.ok(trade);
  return trade;
}

function makeHarness(mode, activeCandle, now = 60000) {
  if (arguments.length < 2) activeCandle = makeActiveCandle();
  const paperTradeEngine = new PaperTradingEngine({ logger, symbol: 'BTCUSDT' });
  const finalized = makeFinalizedCandles();
  const riskClosures = [];
  const candleCalls = [];
  const evaluateCalls = [];
  const finalizedInputs = [];
  const dependencyCalls = [];
  const clockCalls = { now: 0, monotonic: 0 };
  const confluence = mode === 'neutral'
    ? { score: 50, bias: 'Neutral', confidence: 50, components: {}, missing: [] }
    : { score: 80, bias: 'Bullish', confidence: 80, components: {} };

  const clock = {
    now: () => {
      clockCalls.now++;
      return now;
    },
    monotonic: () => {
      clockCalls.monotonic++;
      return clockCalls.monotonic;
    },
  };

  const pipeline = createExecutionPipeline({
    config,
    logger,
    symbol: 'BTCUSDT',
    candleEngine: {
      getCandles: () => activeCandle ? [...finalized, activeCandle] : [...finalized],
      getActive: () => activeCandle,
    },
    regimeEngine: {
      calculate: candles => {
        dependencyCalls.push('regime');
        finalizedInputs.push(candles);
        return { regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low' };
      },
    },
    confluenceEngine: {
      calculate: candles => {
        dependencyCalls.push('confluence');
        finalizedInputs.push(candles);
        return confluence;
      },
    },
    atrEngine: {
      calculate: () => {
        dependencyCalls.push('atr');
        return { ready: true, atr: 2, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable' };
      },
    },
    analyzer: {
      getAnalysis: () => {
        dependencyCalls.push('analyzer');
        return { trend: { '1H': 'Bullish' } };
      },
    },
    structureEngine: {
      calculate: candles => {
        dependencyCalls.push('structure');
        finalizedInputs.push(candles);
        return { ready: true, direction: 'bullish', score: 80, structure: 'Bullish' };
      },
    },
    indicatorRegistry: {
      get: name => ({
        calculate: candles => {
          dependencyCalls.push(`indicator:${name}`);
          finalizedInputs.push(candles);
          return name === 'RSI'
            ? { ready: true, value: 70, state: 'Overbought' }
            : { ready: true, value: 110, trend: 'Above' };
        },
      }),
    },
    macdEngine: {
      calculate: () => {
        dependencyCalls.push('macd');
        return { ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' };
      },
    },
    bollingerEngine: {
      calculate: () => {
        dependencyCalls.push('bollinger');
        return { ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false };
      },
    },
    regimeDecisionEngine: {
      evaluate: () => {
        dependencyCalls.push('regimeDecision');
        return mode === 'regime'
          ? { allowTrade: false, reason: 'Wrong regime' }
          : { allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' };
      },
    },
    mtfConfirmationEngine: {
      evaluate: () => {
        dependencyCalls.push('mtfConfirmation');
        return mode === 'mtf'
          ? { mtfAllowed: false, rejectionReason: '1h disagrees', confidence: 20, alignmentScore: 25 }
          : { mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 };
      },
    },
    advanceRiskEngine: {
      evaluate: () => {
        dependencyCalls.push('advanceRisk');
        return mode === 'risk'
          ? { tradeAllowed: false, rejectionReason: 'Daily limit reached' }
          : { tradeAllowed: true, positionSize: 25, stopLoss: 96, takeProfit: 106, riskReward: 2.5, session: 'ASIAN' };
      },
      onTradeClosed: pnl => {
        dependencyCalls.push('advanceRiskClosure');
        riskClosures.push(pnl);
      },
    },
    mtfEngine: {
      calculate: () => {
        dependencyCalls.push('mtf');
        return { overallBias: 'Bullish' };
      },
    },
    paperTradeEngine,
    clock,
  });

  const onCandle = paperTradeEngine.onCandle.bind(paperTradeEngine);
  paperTradeEngine.onCandle = candle => {
    candleCalls.push(candle);
    return onCandle(candle);
  };
  const evaluateTrades = paperTradeEngine.evaluateTrades.bind(paperTradeEngine);
  paperTradeEngine.evaluateTrades = price => {
    evaluateCalls.push(price);
    return evaluateTrades(price);
  };

  return {
    paperTradeEngine,
    pipeline,
    riskClosures,
    candleCalls,
    evaluateCalls,
    finalizedInputs,
    dependencyCalls,
    clockCalls,
  };
}

function run(pipeline, price, options) {
  if (arguments.length < 2) price = 100;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const snapshot = { symbol: 'BTCUSDT', price, timestamp: FIXED_ISO };
    if (options === undefined) pipeline.run(snapshot);
    else pipeline.run(snapshot, options);
  } finally {
    console.log = originalLog;
  }
  return pipeline.getLastDecision();
}

function assertTakeProfitLifecycle(harness, decision, expectedReason) {
  assert.equal(decision.verdict.rejectionReason, expectedReason);
  assert.deepEqual(harness.evaluateCalls, [100]);
  assert.equal(harness.paperTradeEngine.open().length, 0);
  assert.equal(harness.paperTradeEngine.closed().length, 1);
  assert.equal(harness.paperTradeEngine.closed()[0].exitReason, 'Take Profit');
  assert.equal(harness.paperTradeEngine.closed()[0].pnl, 150);
  assert.deepEqual(harness.riskClosures, [150]);
}

test('neutral rejection processes an existing BUY trade through candle TP', () => {
  const harness = makeHarness('neutral', makeActiveCandle({ high: 106, low: 99 }));
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline);

  assertTakeProfitLifecycle(harness, decision, 'Confluence bias: Score 50 is between thresholds (35-65)');
});

test('regime rejection processes an existing BUY trade through candle TP', () => {
  const harness = makeHarness('regime', makeActiveCandle({ high: 106, low: 99 }));
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline);

  assertTakeProfitLifecycle(harness, decision, 'Regime Decision: Wrong regime');
});

test('MTF rejection processes an existing BUY trade through candle TP', () => {
  const harness = makeHarness('mtf', makeActiveCandle({ high: 106, low: 99 }));
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline);

  assertTakeProfitLifecycle(harness, decision, '1h disagrees');
});

test('risk and cooldown rejections process an existing BUY trade through candle TP', () => {
  const riskHarness = makeHarness('risk', makeActiveCandle({ high: 106, low: 99 }));
  openTrade(riskHarness.paperTradeEngine);
  assertTakeProfitLifecycle(riskHarness, run(riskHarness.pipeline), 'AdvanceRisk: Daily limit reached');

  const cooldownHarness = makeHarness('allowed', makeActiveCandle({ high: 106, low: 99 }), 0);
  openTrade(cooldownHarness.paperTradeEngine);
  assertTakeProfitLifecycle(cooldownHarness, run(cooldownHarness.pipeline), 'Cooldown active — 60s remaining (min 60s between trades)');
});

test('SELL stop-loss closure uses candle high and advances risk once', () => {
  const harness = makeHarness('neutral', makeActiveCandle({ high: 104, low: 99 }));
  openTrade(harness.paperTradeEngine, 'SELL');

  const decision = run(harness.pipeline);
  const closed = harness.paperTradeEngine.closed();

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(harness.evaluateCalls, [100]);
  assert.equal(harness.paperTradeEngine.open().length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitReason, 'Stop Loss');
  assert.equal(closed[0].pnl, -100);
  assert.deepEqual(harness.riskClosures, [-100]);
});

test('current-price closure is not duplicated by candle processing', () => {
  const harness = makeHarness('neutral', makeActiveCandle({ high: 106, low: 99 }));
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline, 106);

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(harness.evaluateCalls, [106]);
  assert.equal(harness.paperTradeEngine.open().length, 0);
  assert.equal(harness.paperTradeEngine.closed().length, 1);
  assert.deepEqual(harness.riskClosures, [150]);
});

test('missing options preserves the active-candle lifecycle fallback', () => {
  const activeCandle = makeActiveCandle({ high: 106, low: 99 });
  const harness = makeHarness('neutral', activeCandle);
  openTrade(harness.paperTradeEngine);

  run(harness.pipeline);

  assert.equal(harness.candleCalls.length, 1);
  assert.strictEqual(harness.candleCalls[0], activeCandle);
});

test('an options object without lifecycleCandle preserves the active-candle fallback', () => {
  const activeCandle = makeActiveCandle({ high: 106, low: 99 });
  const harness = makeHarness('neutral', activeCandle);
  openTrade(harness.paperTradeEngine);

  run(harness.pipeline, 100, {});

  assert.deepEqual(harness.candleCalls, [activeCandle]);
});

test('explicit completed lifecycle candle replaces the active-candle fallback exactly once', () => {
  const activeCandle = makeActiveCandle({ high: 101, low: 99 });
  const completedCandle = makeActiveCandle({ openTime: 21 * 3600000, high: 105, low: 95 });
  const harness = makeHarness('neutral', activeCandle);

  run(harness.pipeline, 100, { lifecycleCandle: completedCandle });

  assert.deepEqual(harness.candleCalls, [completedCandle]);
  assert.notStrictEqual(harness.candleCalls[0], activeCandle);
});

test('completed lifecycle extremes close an existing trade once without current-price or active-candle hits', () => {
  const activeCandle = makeActiveCandle({ high: 101, low: 99 });
  const completedCandle = makeActiveCandle({ openTime: 21 * 3600000, high: 106, low: 99, close: 100 });
  const harness = makeHarness('neutral', activeCandle);
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline, 100, { lifecycleCandle: completedCandle });

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(harness.evaluateCalls, [100]);
  assert.deepEqual(harness.candleCalls, [completedCandle]);
  assert.equal(harness.paperTradeEngine.open().length, 0);
  assert.equal(harness.paperTradeEngine.closed().length, 1);
  assert.equal(harness.paperTradeEngine.closed()[0].exitReason, 'Take Profit');
  assert.deepEqual(harness.riskClosures, [150]);
});

test('explicit lifecycle processing precedes signal and cannot close a newly opened trade', () => {
  const activeCandle = makeActiveCandle({ high: 101, low: 99 });
  const completedCandle = makeActiveCandle({ openTime: 21 * 3600000, high: 112, low: 95 });
  const harness = makeHarness('allowed', activeCandle);
  const order = [];
  const onCandle = harness.paperTradeEngine.onCandle.bind(harness.paperTradeEngine);
  const signal = harness.paperTradeEngine.signal.bind(harness.paperTradeEngine);
  harness.paperTradeEngine.onCandle = candle => {
    order.push('onCandle');
    return onCandle(candle);
  };
  harness.paperTradeEngine.signal = (...args) => {
    order.push('signal');
    return signal(...args);
  };

  const decision = run(harness.pipeline, 100, { lifecycleCandle: completedCandle });

  assert.equal(decision.verdict.tradeOpened, true);
  assert.ok(order.indexOf('onCandle') < order.indexOf('signal'));
  assert.equal(harness.paperTradeEngine.closed().length, 0);
  assert.equal(harness.paperTradeEngine.open().length, 1);
  assert.equal(harness.paperTradeEngine.open()[0].status, 'OPEN');
});

test('explicit lifecycle context does not alter finalized indicator inputs', () => {
  const activeCandle = makeActiveCandle({ high: 101, low: 99 });
  const completedCandle = makeActiveCandle({ openTime: 21 * 3600000, high: 200, low: 99, close: 200 });
  const harness = makeHarness('neutral', activeCandle);

  run(harness.pipeline, 100, { lifecycleCandle: completedCandle });

  assert.ok(harness.finalizedInputs.length > 0);
  for (const candles of harness.finalizedInputs) {
    assert.equal(candles.some(candle => candle === completedCandle), false);
    assert.equal(candles.some(candle => candle.openTime === completedCandle.openTime), false);
  }
});

test('price-based closure remains unchanged with explicit lifecycle context', () => {
  const activeCandle = makeActiveCandle({ high: 101, low: 99 });
  const completedCandle = makeActiveCandle({ openTime: 21 * 3600000, high: 101, low: 99 });
  const harness = makeHarness('neutral', activeCandle);
  openTrade(harness.paperTradeEngine);

  run(harness.pipeline, 106, { lifecycleCandle: completedCandle });

  assert.deepEqual(harness.evaluateCalls, [106]);
  assert.deepEqual(harness.candleCalls, [completedCandle]);
  assert.equal(harness.paperTradeEngine.closed().length, 1);
  assert.deepEqual(harness.riskClosures, [150]);
});

test('invalid lifecycle options are side-effect free and reject deterministically', () => {
  const invalidCases = [
    [{ unknown: true }, 'unknown option'],
    [{ lifecycleCandle: [] }, 'valid candle object'],
    [{ lifecycleCandle: { high: 106, low: 99 } }, 'valid candle object'],
    [{ lifecycleCandle: null }, 'valid candle object'],
    [{ lifecycleCandle: undefined }, 'valid candle object'],
  ];

  for (const [options, message] of invalidCases) {
    const harness = makeHarness('neutral', makeActiveCandle());
    const beforeDecision = harness.pipeline.getLastDecision();
    const beforeHealth = harness.pipeline.getPipelineHealth();

    assert.throws(() => run(harness.pipeline, 100, options), new RegExp(message));
    assert.strictEqual(harness.pipeline.getLastDecision(), beforeDecision);
    assert.deepEqual(harness.pipeline.getPipelineHealth(), beforeHealth);
    assert.deepEqual(harness.clockCalls, { now: 0, monotonic: 0 });
    assert.deepEqual(harness.evaluateCalls, []);
    assert.deepEqual(harness.candleCalls, []);
    assert.deepEqual(harness.dependencyCalls, []);
  }

  const harness = makeHarness('neutral', makeActiveCandle());
  const beforeHealth = harness.pipeline.getPipelineHealth();
  assert.throws(() => run(harness.pipeline, 100, []), /non-array object/);
  assert.deepEqual(harness.pipeline.getPipelineHealth(), beforeHealth);
  assert.deepEqual(harness.clockCalls, { now: 0, monotonic: 0 });
  assert.deepEqual(harness.evaluateCalls, []);
  assert.deepEqual(harness.candleCalls, []);
  assert.deepEqual(harness.dependencyCalls, []);
});

test('a valid call after malformed options behaves as the first accepted cycle', () => {
  const harness = makeHarness('neutral', makeActiveCandle());
  const freshHarness = makeHarness('neutral', makeActiveCandle());

  assert.throws(() => run(harness.pipeline, 100, { invalid: true }), /unknown option/);
  const decision = run(harness.pipeline);
  const freshDecision = run(freshHarness.pipeline);

  assert.equal(decision.cycle, 1);
  assert.equal(decision.timestamp, freshDecision.timestamp);
  assert.equal(decision.verdict.rejectionReason, freshDecision.verdict.rejectionReason);
  assert.equal(harness.clockCalls.now, 1);
  assert.equal(harness.clockCalls.monotonic, 0);
});

test('explicit lifecycle context preserves pipeline decision timestamp behavior', () => {
  const completedCandle = makeActiveCandle({ openTime: 21 * 3600000 });
  const harness = makeHarness('neutral', makeActiveCandle());

  const decision = run(harness.pipeline, 100, { lifecycleCandle: completedCandle });

  assert.equal(decision.timestamp, new Date(60000).toISOString());
});

test('candle touching neither level leaves the existing trade active', () => {
  const harness = makeHarness('neutral', makeActiveCandle({ high: 105, low: 97 }));
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline);

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(harness.evaluateCalls, [100]);
  assert.equal(harness.paperTradeEngine.open().length, 1);
  assert.equal(harness.paperTradeEngine.closed().length, 0);
  assert.equal(harness.paperTradeEngine.open()[0].status, 'ACTIVE');
  assert.deepEqual(harness.riskClosures, []);
});

test('missing active candle preserves current-price lifecycle and skips candle processing', () => {
  const harness = makeHarness('neutral', undefined);
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline, 106);

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(harness.evaluateCalls, [106]);
  assert.equal(harness.paperTradeEngine.open().length, 0);
  assert.equal(harness.paperTradeEngine.closed().length, 1);
  assert.deepEqual(harness.riskClosures, [150]);
  assert.equal(harness.candleCalls.length, 0);
});

test('malformed active candle extremes never close an existing trade', () => {
  const malformedCandles = [
    makeActiveCandle({ high: undefined }),
    makeActiveCandle({ low: undefined }),
    makeActiveCandle({ high: NaN }),
    makeActiveCandle({ low: NaN }),
    makeActiveCandle({ high: Infinity }),
    makeActiveCandle({ low: -Infinity }),
  ];

  for (const activeCandle of malformedCandles) {
    const harness = makeHarness('neutral', activeCandle);
    openTrade(harness.paperTradeEngine);

    const decision = run(harness.pipeline);

    assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
    assert.deepEqual(harness.evaluateCalls, [100]);
    assert.equal(harness.paperTradeEngine.open().length, 1);
    assert.equal(harness.paperTradeEngine.closed().length, 0);
    assert.deepEqual(harness.riskClosures, []);
    assert.equal(harness.candleCalls.length, 0);
  }
});

test('invalid prices preserve the rejection contract and skip all lifecycle processing', () => {
  for (const price of [undefined, null, 0, -1, NaN, Infinity, -Infinity]) {
    const harness = makeHarness('neutral', makeActiveCandle({ high: 106, low: 99 }));
    openTrade(harness.paperTradeEngine);

    const decision = run(harness.pipeline, price);

    assert.equal(decision.verdict.rejectionReason, 'No valid price data');
    assert.equal(decision.verdict.tradeOpened, false);
    assert.deepEqual(harness.evaluateCalls, []);
    assert.equal(harness.candleCalls.length, 0);
    assert.deepEqual(harness.riskClosures, []);
    assert.equal(harness.paperTradeEngine.open().length, 1);
    assert.equal(harness.paperTradeEngine.closed().length, 0);
  }
});

test('successful execution processes existing trades but not the new trade on the same candle', () => {
  const harness = makeHarness('allowed', makeActiveCandle({ high: 112, low: 95 }));
  openTrade(harness.paperTradeEngine);

  const decision = run(harness.pipeline);
  const open = harness.paperTradeEngine.open();

  assert.equal(decision.verdict.tradeOpened, true);
  assert.deepEqual(harness.evaluateCalls, [100]);
  assert.equal(harness.paperTradeEngine.closed().length, 1);
  assert.equal(harness.riskClosures.length, 1);
  assert.equal(open.length, 1);
  assert.equal(open[0].tradeId, 'PT-2');
  assert.equal(open[0].status, 'OPEN');
});

test('successful execution does not close a newly created trade using prior candle extremes', () => {
  const harness = makeHarness('allowed', makeActiveCandle({ high: 112, low: 95 }));

  const decision = run(harness.pipeline);

  assert.equal(decision.verdict.tradeOpened, true);
  assert.deepEqual(harness.evaluateCalls, [100]);
  assert.equal(harness.paperTradeEngine.open().length, 1);
  assert.equal(harness.paperTradeEngine.closed().length, 0);
  assert.deepEqual(harness.riskClosures, []);
});
