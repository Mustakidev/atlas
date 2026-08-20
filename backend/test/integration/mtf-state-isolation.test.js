const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { MTFConfirmationEngine } = require('../../src/engine/mtfConfirmation');

const FIXED_ISO = '2024-01-01T00:00:00.000Z';
const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const logger = { info() {}, warn() {}, error() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  },
};

function mixedTimeframes() {
  return {
    '1m': { confluence: { bias: 'Bearish', score: 30, confidence: 60 } },
    '5m': { confluence: { bias: 'Bullish', score: 70, confidence: 60 } },
    '15m': { confluence: { bias: 'Bullish', score: 80, confidence: 75 } },
    '1h': { confluence: { bias: 'Bullish', score: 85, confidence: 80 } },
  };
}

function makeCandles(count) {
  return Array.from({ length: count }, (_, index) => ({
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1,
    openTime: BASE_TIME + index * 60000,
    timestamp: new Date(BASE_TIME + index * 60000).toISOString(),
  }));
}

function runPipeline(harness) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    harness.pipeline.run({ symbol: 'BTCUSDT', price: 100, timestamp: FIXED_ISO });
  } finally {
    console.log = originalLog;
  }
  const decision = harness.pipeline.getLastDecision();
  return {
    mtf: {
      aggressive: decision.mtfConfirmation?.aggressive,
      mtfAllowed: decision.mtfConfirmation?.mtfAllowed,
      confidence: decision.mtfConfirmation?.confidence,
      alignmentScore: decision.mtfConfirmation?.alignmentScore,
      blockedBy: decision.mtfConfirmation?.blockedBy,
      rejectionReason: decision.mtfConfirmation?.rejectionReason,
    },
    gate: decision.gates.mtfConfirmation,
    tradeOpened: decision.verdict.tradeOpened,
    rejectionReason: decision.verdict.rejectionReason,
    signalCount: harness.signals.length,
  };
}

function createPipelineHarness() {
  const candles = makeCandles(20);
  const signals = [];
  const mtfConfirmationEngine = new MTFConfirmationEngine({ logger, symbol: 'BTCUSDT', config });
  const confluenceEngine = {
    calculate: (_candles, timeframe) => ({
      score: timeframe === '1m' ? 30 : 80,
      bias: timeframe === '1m' ? 'Bearish' : 'Bullish',
      confidence: 70,
      components: {},
    }),
  };
  const paperTradeEngine = {
    signal: (_engines, price, timeframe, direction) => {
      const trade = { tradeId: `T-${signals.length + 1}`, direction, entryPrice: price, timeframe };
      signals.push(trade);
      return trade;
    },
    evaluateTrades: () => [],
    onCandle: () => ({ closed: [] }),
    open: () => [],
    closed: () => [],
    getBalance: () => 10000,
  };
  const pipeline = createExecutionPipeline({
    config,
    logger,
    symbol: 'BTCUSDT',
    candleEngine: { getCandles: () => candles, getActive: () => null },
    regimeEngine: { calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low', decisionReason: 'Trend' }) },
    confluenceEngine,
    atrEngine: { calculate: () => ({ ready: true, atr: 2, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable' }) },
    analyzer: { getAnalysis: () => ({ trend: { '1H': 'Bullish' } }) },
    structureEngine: { calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }) },
    indicatorRegistry: { get(name) { return { calculate: () => name === 'RSI' ? { ready: true, value: 70, state: 'Overbought' } : { ready: true, value: 110, trend: 'Above' } }; } },
    macdEngine: { calculate: () => ({ ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' }) },
    bollingerEngine: { calculate: () => ({ ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false }) },
    regimeDecisionEngine: { evaluate: () => ({ allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' }) },
    mtfConfirmationEngine,
    advanceRiskEngine: { evaluate: () => ({ tradeAllowed: true, positionSize: 1, stopLoss: 96, takeProfit: 112, riskReward: 3, session: 'ASIAN' }), onTradeClosed() {} },
    mtfEngine: { calculate: () => ({ overallBias: 'Bullish' }) },
    paperTradeEngine,
    clock: { now: () => Date.parse(FIXED_ISO), isoNow: () => FIXED_ISO, localeTime: () => '12:00:00 AM' },
  });
  return { pipeline, mtfConfirmationEngine, signals };
}

test('normal pipeline remains isolated after an aggressive evaluation attempt', () => {
  const clean = createPipelineHarness();
  const cleanOutcome = runPipeline(clean);

  const reused = createPipelineHarness();
  reused.mtfConfirmationEngine.evaluate({ direction: 'BUY', aggressive: true, timeframes: mixedTimeframes() });
  const reusedOutcome = runPipeline(reused);

  assert.deepEqual(reusedOutcome, cleanOutcome);
  assert.equal(reusedOutcome.mtf.aggressive, false);
  assert.equal(reusedOutcome.mtf.mtfAllowed, false);
  assert.equal(reusedOutcome.tradeOpened, false);
  assert.equal(reusedOutcome.signalCount, 0);
});
