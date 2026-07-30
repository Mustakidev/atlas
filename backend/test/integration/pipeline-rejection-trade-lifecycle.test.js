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
  const confluence = mode === 'neutral'
    ? { score: 50, bias: 'Neutral', confidence: 50, components: {}, missing: [] }
    : { score: 80, bias: 'Bullish', confidence: 80, components: {} };

  const pipeline = createExecutionPipeline({
    config,
    logger,
    symbol: 'BTCUSDT',
    candleEngine: {
      getCandles: () => activeCandle ? [...finalized, activeCandle] : [...finalized],
      getActive: () => activeCandle,
    },
    regimeEngine: {
      calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low' }),
    },
    confluenceEngine: { calculate: () => confluence },
    atrEngine: { calculate: () => ({ ready: true, atr: 2, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable' }) },
    analyzer: { getAnalysis: () => ({ trend: { '1H': 'Bullish' } }) },
    structureEngine: { calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }) },
    indicatorRegistry: {
      get: name => ({ calculate: () => name === 'RSI'
        ? { ready: true, value: 70, state: 'Overbought' }
        : { ready: true, value: 110, trend: 'Above' } }),
    },
    macdEngine: { calculate: () => ({ ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' }) },
    bollingerEngine: { calculate: () => ({ ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false }) },
    regimeDecisionEngine: {
      evaluate: () => mode === 'regime'
        ? { allowTrade: false, reason: 'Wrong regime' }
        : { allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' },
    },
    mtfConfirmationEngine: {
      evaluate: () => mode === 'mtf'
        ? { mtfAllowed: false, rejectionReason: '1h disagrees', confidence: 20, alignmentScore: 25 }
        : { mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 },
    },
    advanceRiskEngine: {
      evaluate: () => mode === 'risk'
        ? { tradeAllowed: false, rejectionReason: 'Daily limit reached' }
        : { tradeAllowed: true, positionSize: 25, stopLoss: 96, takeProfit: 106, riskReward: 2.5, session: 'ASIAN' },
      onTradeClosed: pnl => riskClosures.push(pnl),
    },
    mtfEngine: { calculate: () => ({ overallBias: 'Bullish' }) },
    paperTradeEngine,
    clock: { now: () => now, isoNow: () => FIXED_ISO, localeTime: () => '00:00:00' },
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

  return { paperTradeEngine, pipeline, riskClosures, candleCalls, evaluateCalls };
}

function run(pipeline, price) {
  if (arguments.length < 2) price = 100;
  const originalLog = console.log;
  console.log = () => {};
  try {
    pipeline.run({ symbol: 'BTCUSDT', price, timestamp: FIXED_ISO });
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
