const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { createIndicatorRegistry } = require('../../src/engine/indicators');
const { ATREngine } = require('../../src/engine/atr');

const FIXED_ISO = '2024-01-01T00:00:00.000Z';
const FIXED_NOW = Date.parse(FIXED_ISO);

function makeCandles(closeAt, rangeAt = () => 1, count = 60) {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    const range = rangeAt(index);
    const openTime = index * 3600000;
    return {
      open: close,
      high: close + range,
      low: close - range,
      close,
      volume: 1000,
      openTime,
      timestamp: new Date(openTime).toISOString(),
    };
  });
}

function buildHarness(initialCandles) {
  let candles = initialCandles;
  const registry = createIndicatorRegistry('BTCUSDT');
  const candleEngine = {
    setCandles(next) {
      candles = next;
    },
    getCandles(_timeframe, limit) {
      const result = [...candles];
      return limit && limit > 0 ? result.slice(-limit) : result;
    },
    getActive: () => null,
  };
  const state = { trades: [] };
  const logger = { info() {}, warn() {}, error() {} };

  const atrEngine = new ATREngine({ candleEngine, logger, symbol: 'BTCUSDT' });
  const pipeline = createExecutionPipeline({
    config: { get: key => key === 'CONFLUENCE_BULLISH_THRESHOLD' ? 65 : key === 'CONFLUENCE_BEARISH_THRESHOLD' ? 35 : undefined },
    logger,
    symbol: 'BTCUSDT',
    clock: { now: () => FIXED_NOW, isoNow: () => FIXED_ISO, localeTime: () => '12:00:00 AM' },
    candleEngine,
    indicatorRegistry: registry,
    regimeEngine: { calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low', decisionReason: 'Trend' }) },
    confluenceEngine: {
      calculate: (input, timeframe) => {
        const rsi = registry.get('RSI').calculate(input, timeframe);
        const bullish = rsi.value >= 50;
        return {
          score: bullish ? 80 : 20,
          bias: bullish ? 'Bullish' : 'Bearish',
          confidence: 80,
          components: { rsi: { score: rsi.strength, confidence: rsi.confidence } },
        };
      },
    },
    atrEngine,
    analyzer: { getAnalysis: () => ({ trend: { '1H': 'Bullish' } }) },
    structureEngine: { calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }) },
    macdEngine: { calculate: () => ({ ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' }) },
    bollingerEngine: { calculate: () => ({ ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false }) },
    regimeDecisionEngine: { evaluate: () => ({ allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' }) },
    mtfConfirmationEngine: { evaluate: () => ({ mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 }) },
    advanceRiskEngine: {
      evaluate: ({ atr }) => {
        const allowed = atr.atr < 5;
        return {
          tradeAllowed: allowed,
          rejectionReason: allowed ? null : 'ATR contamination',
          positionSize: 1,
          stopLoss: 96,
          takeProfit: 112,
          riskReward: 3,
          session: 'ASIAN',
        };
      },
      onTradeClosed() {},
    },
    mtfEngine: { calculate: () => ({ overallBias: 'Bullish' }) },
    paperTradeEngine: {
      signal: (_engines, price, timeframe, direction) => {
        const trade = { tradeId: `T-${state.trades.length + 1}`, direction, entryPrice: price, stopLoss: 96, takeProfit: 112, riskReward: 3, positionSize: 1, confidence: 80, reason: 'Accepted' };
        state.trades.push(trade);
        return trade;
      },
      evaluateTrades: () => [],
      onCandle: () => ({ closed: [] }),
      open: () => [],
      closed: () => [],
      getBalance: () => 10000,
    },
  });

  return { pipeline, candleEngine, registry, atrEngine, state };
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
    confluence: decision.confluence,
    risk: decision.risk && {
      tradeAllowed: decision.risk.tradeAllowed,
      rejectionReason: decision.risk.rejectionReason,
    },
    tradeOpened: decision.verdict.tradeOpened,
    rejectionReason: decision.verdict.rejectionReason,
    tradeDirection: decision.verdict.trade?.direction || null,
  };
}

test('pipeline decision is isolated from preloaded RSI and ATR results', () => {
  const intended = makeCandles(index => 100 + index, () => 1);
  const conflicting = makeCandles(index => 200 - index, () => 10);

  const clean = buildHarness(intended);
  const expected = runPipeline(clean);

  const contaminated = buildHarness(intended);
  contaminated.candleEngine.setCandles(conflicting);
  contaminated.registry.get('RSI').calculate(conflicting, '1h');
  contaminated.atrEngine.calculate('1h', 60);
  contaminated.candleEngine.setCandles(intended);
  const actual = runPipeline(contaminated);

  assert.deepEqual(actual, expected);
  assert.equal(actual.risk.tradeAllowed, true);
  assert.equal(actual.tradeOpened, true);
});
