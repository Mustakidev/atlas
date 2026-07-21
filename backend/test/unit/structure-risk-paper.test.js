const test = require('node:test');
const assert = require('node:assert/strict');

const { StructureEngine } = require('../../src/engine/structure');
const { RiskEngine } = require('../../src/engine/risk');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { bearishCandles, bullishCandles, validCandles } = require('../fixtures/market');
const { fresh } = require('../helpers/fixtures');

function logger() {
  return { info() {}, warn() {}, error() {}, system() {} };
}

function validAtr() {
  return { ready: true, atr: 2, atrPercentage: 1.5 };
}

function validRiskInput() {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 100,
    direction: 'BUY',
    atr: validAtr(),
    trend: { trend: { '1H': 'Bullish' } },
    structure: { direction: 'bullish', score: 75 },
    confluence: { confidence: 80, score: 75 },
  };
}

test('Structure returns documented ready responses for bullish and bearish fixtures', () => {
  const engine = new StructureEngine(logger(), 'BTCUSDT');
  const bullish = engine.calculate(fresh(bullishCandles, 40));
  const bearish = engine.calculate(fresh(bearishCandles, 40));

  for (const result of [bullish, bearish]) {
    assert.equal(result.ready, true);
    assert.ok(['Bullish', 'Bearish', 'Ranging'].includes(result.structure));
    assert.ok(['bullish', 'bearish', 'neutral'].includes(result.direction));
    assert.ok(Array.isArray(result.swingPoints));
    assert.ok(Object.hasOwn(result, 'lastBOS'));
  }
});

test('Structure does not throw for empty or insufficient data', () => {
  const engine = new StructureEngine(logger(), 'BTCUSDT');
  const empty = engine.calculate([]);
  const short = engine.calculate(fresh(validCandles, 5));

  assert.equal(empty.ready, false);
  assert.equal(empty.structure, null);
  assert.equal(short.ready, false);
  assert.equal(short.direction, null);
});

test('Risk produces allowed and actionable blocked responses', () => {
  const risk = new RiskEngine({ logger: logger(), symbol: 'BTCUSDT' });
  const allowed = risk.evaluate(validRiskInput());
  const blocked = risk.evaluate({ ...validRiskInput(), atr: { ready: false, atr: null } });

  assert.equal(allowed.tradeAllowed, true);
  for (const key of ['entryPrice', 'direction', 'stopLoss', 'takeProfit', 'riskReward', 'tradeAllowed']) {
    assert.ok(Object.hasOwn(allowed, key), `allowed risk response missing ${key}`);
  }
  assert.equal(blocked.tradeAllowed, false);
  assert.equal(blocked.stopLoss, null);
  assert.equal(blocked.takeProfit, null);
  assert.equal(blocked.riskReward, null);
  assert.ok(blocked.rejectionReason, 'blocked risk response needs a reason');
});

test('AdvanceRisk produces allowed and actionable blocked responses', () => {
  const advanceRisk = new AdvanceRiskEngine({ logger: logger(), symbol: 'BTCUSDT', paperTradeEngine: null, config: {} });
  const allowed = advanceRisk.evaluate({ ...validRiskInput(), regime: 'TRENDING_BULL' });
  const blocked = advanceRisk.evaluate({ ...validRiskInput(), confluence: { confidence: 10, score: 50 }, regime: 'TRENDING_BULL' });

  assert.equal(allowed.tradeAllowed, true);
  assert.ok(Number.isFinite(allowed.positionSize));
  assert.ok(Object.hasOwn(allowed, 'dailyPnL'));
  assert.ok(Object.hasOwn(allowed, 'consecutiveLosses'));
  assert.equal(blocked.tradeAllowed, false);
  assert.ok(blocked.rejectionReason, 'blocked advance-risk response needs a reason');
  assert.equal(blocked.dailyPnL, 0);
  assert.equal(blocked.consecutiveLosses, 0);
});

function acceptedPaperSignal() {
  return {
    atr: { ready: true, atr: 2 },
    bollinger: { ready: false },
  };
}

test('PaperTrading opens accepted signals and rejects neutral signals', () => {
  const engine = new PaperTradingEngine({ logger: logger(), symbol: 'BTCUSDT' });
  const opened = engine.signal(acceptedPaperSignal(), 100, '1h', 'BUY');
  const rejected = engine.signal({}, 100, '1h');

  assert.ok(opened, 'accepted signal should open a trade');
  assert.equal(opened.status, 'OPEN');
  assert.equal(engine.open().length, 1);
  assert.equal(rejected, null);
  assert.equal(engine.open().length, 1, 'rejected signal must not add a trade');
});

test('PaperTrading closes an opened trade through the candle lifecycle', () => {
  const engine = new PaperTradingEngine({ logger: logger(), symbol: 'BTCUSDT' });
  const opened = engine.signal(acceptedPaperSignal(), 100, '1h', 'BUY');
  const closedResult = engine.onCandle({ open: 105, high: 106, low: 105, close: 106, openTime: 1, timestamp: '2024-01-01T01:00:00.000Z' });

  assert.equal(closedResult.closed.length, 1);
  assert.equal(closedResult.closed[0].tradeId, opened.tradeId);
  assert.equal(closedResult.closed[0].status, 'CLOSED');
  assert.equal(engine.open().length, 0);
  assert.equal(engine.closed().length, 1);
  assert.ok(engine.getBalance() > 10000, 'take-profit close should increase balance');
  assert.equal(engine.stats().openTrades, 0);
  assert.equal(engine.stats().closedTrades, 1);
});
