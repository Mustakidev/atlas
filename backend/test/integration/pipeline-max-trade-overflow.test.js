const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const logger = { info() {}, warn() {}, error() {} };
const candles = Array.from({ length: 20 }, (_, index) => ({
  openTime: index * 3600000,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}));

function makeHarness() {
  let nowMs = 60000;
  let monotonicMs = 0;
  const riskClosures = [];
  const paperTradeEngine = new PaperTradingEngine({
    logger,
    symbol: 'BTCUSDT',
    clock: {
      nowMs: () => nowMs,
      monotonicMs: () => monotonicMs++,
    },
  });
  paperTradeEngine._maxTrades = 1;

  const pipeline = createExecutionPipeline({
    config: {
      get(key) {
        if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
        if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
        return undefined;
      },
    },
    logger,
    symbol: 'BTCUSDT',
    clock: {
      nowMs: () => nowMs,
      monotonicMs: () => monotonicMs++,
    },
    candleEngine: {
      getCandles: () => candles,
      getActive: () => null,
    },
    regimeEngine: {
      calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low' }),
    },
    confluenceEngine: {
      calculate: () => ({ score: 80, bias: 'Bullish', confidence: 80, components: {}, missing: [] }),
    },
    atrEngine: {
      calculate: () => ({ ready: true, atr: 2, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable' }),
    },
    analyzer: {
      getAnalysis: () => ({ trend: { '1H': 'Bullish' } }),
    },
    structureEngine: {
      calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }),
    },
    indicatorRegistry: {
      get: name => ({
        calculate: () => name === 'RSI'
          ? { ready: true, value: 70, state: 'Overbought' }
          : { ready: true, value: 110, trend: 'Above' },
      }),
    },
    macdEngine: {
      calculate: () => ({ ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' }),
    },
    bollingerEngine: {
      calculate: () => ({ ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false }),
    },
    regimeDecisionEngine: {
      evaluate: () => ({ allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' }),
    },
    mtfConfirmationEngine: {
      evaluate: () => ({ mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 }),
    },
    advanceRiskEngine: {
      evaluate: () => ({ tradeAllowed: true, positionSize: 1, stopLoss: 90, takeProfit: 200, riskReward: 4.4, session: 'ASIAN' }),
      onTradeClosed: (pnl, context) => riskClosures.push({ pnl, context }),
    },
    mtfEngine: {
      calculate: () => ({ overallBias: 'Bullish', timeframeAgreement: 100 }),
    },
    paperTradeEngine,
  });

  return {
    pipeline,
    paperTradeEngine,
    riskClosures,
    setNow(value) { nowMs = value; },
  };
}

function runQuietly(harness, price, nowMs) {
  harness.setNow(nowMs);
  const originalLog = console.log;
  console.log = () => {};
  try {
    harness.pipeline.run({ price, timestamp: new Date(nowMs).toISOString() });
  } finally {
    console.log = originalLog;
  }
  return harness.pipeline.getLastDecision();
}

test('pipeline observes signal-time overflow and notifies canonical risk once per closure', () => {
  const harness = makeHarness();

  const firstDecision = runQuietly(harness, 100, 60000);
  const secondDecision = runQuietly(harness, 101, 120000);
  const thirdDecision = runQuietly(harness, 102, 180000);
  const history = harness.paperTradeEngine.history();

  assert.equal(firstDecision.verdict.tradeOpened, true);
  assert.equal(firstDecision.verdict.trade.tradeId, 'PT-1');
  assert.equal(secondDecision.verdict.tradeOpened, true);
  assert.equal(secondDecision.verdict.trade.tradeId, 'PT-2');
  assert.equal(thirdDecision.verdict.tradeOpened, true);
  assert.equal(thirdDecision.verdict.trade.tradeId, 'PT-3');
  assert.deepEqual(harness.paperTradeEngine.open().map(trade => trade.tradeId), ['PT-3']);
  assert.deepEqual(history.map(trade => trade.tradeId), ['PT-1', 'PT-2']);
  assert.deepEqual(history.map(trade => trade.exitReason), ['Invalidated', 'Invalidated']);
  assert.deepEqual(history.map(trade => trade.status), ['CLOSED', 'CLOSED']);
  assert.deepEqual(harness.riskClosures, [
    { pnl: 1, context: { nowMs: 120000 } },
    { pnl: 1, context: { nowMs: 180000 } },
  ]);
  assert.equal(harness.paperTradeEngine.getBalance(), 10002);
  assert.equal(harness.paperTradeEngine.stats().closedTrades, 2);
  assert.equal(harness.paperTradeEngine.stats().openTrades, 1);
});
