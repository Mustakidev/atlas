const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { bullishCandles } = require('../fixtures/market');
const { fresh } = require('../helpers/fixtures');

const FIXED_ISO = '2024-01-01T00:00:00.000Z';
const FIXED_NOW = Date.parse(FIXED_ISO);

function createHarness({ candleCount = 30 } = {}) {
  let nowCalls = 0;
  let monotonicValue = 0;
  const clock = {
    nowMs: () => {
      nowCalls++;
      return FIXED_NOW;
    },
    monotonicMs: () => ++monotonicValue,
  };
  const candles = fresh(bullishCandles, candleCount);
  const logger = { info() {}, warn() {}, error() {} };
  const config = {
    get(key) {
      if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
      if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
      return undefined;
    },
  };
  const paperTradeEngine = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock });
  const advanceRiskEngine = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine, config, clock });
  nowCalls = 0;

  const pipeline = createExecutionPipeline({
    config,
    logger,
    symbol: 'BTCUSDT',
    clock,
    candleEngine: {
      getCandles: () => [...candles],
      getActive: () => null,
    },
    regimeEngine: {
      calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low', decisionReason: 'Trend' }),
    },
    confluenceEngine: {
      calculate: () => ({ score: 80, bias: 'Bullish', confidence: 80, components: {} }),
    },
    atrEngine: {
      calculate: () => ({ ready: true, atr: 2, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable' }),
    },
    analyzer: { getAnalysis: () => ({ trend: { '1H': 'Bullish' } }) },
    structureEngine: { calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }) },
    indicatorRegistry: {
      get(name) {
        return { calculate: () => name === 'RSI'
          ? { ready: true, value: 70, state: 'Overbought' }
          : { ready: true, value: 110, trend: 'Above' } };
      },
    },
    macdEngine: { calculate: () => ({ ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' }) },
    bollingerEngine: { calculate: () => ({ ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false }) },
    regimeDecisionEngine: { evaluate: () => ({ allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' }) },
    mtfConfirmationEngine: { evaluate: () => ({ mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 }) },
    advanceRiskEngine,
    mtfEngine: { calculate: () => ({ overallBias: 'Bullish', timeframeAgreement: 100 }) },
    paperTradeEngine,
  });

  return { clock, pipeline, paperTradeEngine, advanceRiskEngine, getNowCalls: () => nowCalls };
}

function runQuietly(pipeline, price = 100) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    pipeline.run({ price, timestamp: FIXED_ISO });
  } finally {
    console.log = originalLog;
  }
}

test('one pipeline cycle captures domain time once and propagates it', () => {
  const harness = createHarness();

  runQuietly(harness.pipeline);
  const decision = harness.pipeline.getLastDecision();
  const trade = harness.paperTradeEngine.open()[0];

  assert.equal(harness.getNowCalls(), 1);
  assert.equal(decision.timestamp, FIXED_ISO);
  assert.equal(decision.risk.timestamp, FIXED_ISO);
  assert.equal(trade.entryTime, FIXED_ISO);
  assert.equal(harness.pipeline.getPipelineHealth().lastSuccessfulCycle, FIXED_ISO);
});

test('pipeline cooldown uses the captured cycle time', () => {
  const harness = createHarness();

  runQuietly(harness.pipeline);
  runQuietly(harness.pipeline);

  const decision = harness.pipeline.getLastDecision();
  assert.equal(decision.verdict.tradeOpened, false);
  assert.equal(decision.verdict.rejectionReason, 'Cooldown active — 60s remaining (min 60s between trades)');
  assert.equal(harness.paperTradeEngine.open().length, 1);
});

test('pipeline propagates one closure time to PaperTrading and AdvanceRisk exactly once', () => {
  const harness = createHarness({ candleCount: 0 });
  const paperContexts = [];
  const riskContexts = [];
  const evaluateTrades = harness.paperTradeEngine.evaluateTrades.bind(harness.paperTradeEngine);
  const onTradeClosed = harness.advanceRiskEngine.onTradeClosed.bind(harness.advanceRiskEngine);
  harness.paperTradeEngine.evaluateTrades = (price, context) => {
    paperContexts.push(context);
    return evaluateTrades(price, context);
  };
  harness.advanceRiskEngine.onTradeClosed = (pnl, context) => {
    riskContexts.push(context);
    return onTradeClosed(pnl, context);
  };

  harness.paperTradeEngine.signal({}, 100, '1h', 'BUY', {
    stopLoss: 90,
    takeProfit: 110,
    positionSize: 1,
    riskReward: 2,
  }, { nowMs: FIXED_NOW - 3600000 });

  runQuietly(harness.pipeline, 90);

  assert.equal(paperContexts.length, 1);
  assert.equal(riskContexts.length, 1);
  assert.strictEqual(paperContexts[0], riskContexts[0]);
  assert.equal(paperContexts[0].nowMs, FIXED_NOW);
  assert.equal(harness.advanceRiskEngine.getDailyPnL(), -10);
  assert.equal(harness.advanceRiskEngine.getConsecutiveLosses(), 1);
  assert.equal(harness.paperTradeEngine.closed().length, 1);
});
