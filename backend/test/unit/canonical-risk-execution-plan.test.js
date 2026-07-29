const test = require('node:test');
const assert = require('node:assert/strict');

const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const logger = { info() {}, warn() {}, error() {} };

function paperEngines() {
  return {
    trend: { trend: { '1H': 'Bullish' } },
    structure: { ready: true, direction: 'Bullish', structure: 'BOS', score: 1 },
    rsi: { ready: true, value: 70, state: 'Bullish' },
    ema: { ready: true, trend: 'Above', value: 1 },
    macd: { ready: true, trend: 'bullish', histogram: 1 },
    atr: { ready: true, atr: 2 },
    bollinger: { ready: false },
    confluence: { bias: 'Bullish', score: 80 },
    mtf: { overallBias: 'Bullish', timeframeAgreement: 100 },
  };
}

function createRisk() {
  const risk = new AdvanceRiskEngine({ logger, symbol: 'TEST', paperTradeEngine: null, config: {} });
  risk.setAccountBalance(25000);
  risk.setRiskPerTradePct(2);
  risk.setAtrMultTrending(3);
  risk.setAtrMultRanging(1.5);
  risk.setRrTrending(4);
  risk.setRrRanging(2);
  for (const session of ['ASIAN', 'LONDON', 'NEW_YORK']) risk.setSessionMultiplier(session, 2);
  return risk;
}

function evaluatePlan(regime, direction) {
  return createRisk().evaluate({
    symbol: 'TEST',
    timeframe: '1h',
    entryPrice: 100,
    atr: { ready: true, atr: 2, atrPercentage: 1 },
    direction,
    confluence: { confidence: 80 },
    regime,
  });
}

test('PaperTrading uses the exact approved plan across regimes and directions', () => {
  for (const regime of ['TRENDING_BULL', 'RANGING', 'HIGH_VOLATILITY']) {
    for (const direction of ['BUY', 'SELL']) {
      const plan = evaluatePlan(regime, direction);
      const paper = new PaperTradingEngine({ logger, symbol: 'TEST' });
      const trade = paper.signal(paperEngines(), 100, '1h', direction, plan);

      assert.equal(plan.tradeAllowed, true, `${regime}/${direction} risk plan should be allowed`);
      assert.ok(trade, `${regime}/${direction} should open a trade`);
      assert.equal(trade.stopLoss, plan.stopLoss);
      assert.equal(trade.takeProfit, plan.takeProfit);
      assert.equal(trade.positionSize, plan.positionSize);
      assert.equal(trade.riskReward, plan.riskReward);
    }
  }
});

test('PaperTrading rejects invalid supplied plans without fallback recalculation', () => {
  const invalidPlans = [
    { stopLoss: NaN, takeProfit: 106, positionSize: 25, riskReward: 1.5 },
    { stopLoss: 96, takeProfit: '106', positionSize: 25, riskReward: 1.5 },
    { stopLoss: 96, takeProfit: 106, positionSize: 0, riskReward: 1.5 },
    { stopLoss: 96, takeProfit: 106, positionSize: 25, riskReward: 0 },
    { stopLoss: 100, takeProfit: 106, positionSize: 25, riskReward: 1.5 },
    { stopLoss: 96, takeProfit: 100, positionSize: 25, riskReward: 1.5 },
  ];

  for (const plan of invalidPlans) {
    const paper = new PaperTradingEngine({ logger, symbol: 'TEST' });
    const trade = paper.signal(paperEngines(), 100, '1h', 'BUY', plan);
    assert.equal(trade, null);
    assert.equal(paper.open().length, 0);
  }

  const sellPlan = { stopLoss: 96, takeProfit: 106, positionSize: 25, riskReward: 1.5 };
  const paper = new PaperTradingEngine({ logger, symbol: 'TEST' });
  assert.equal(paper.signal(paperEngines(), 100, '1h', 'SELL', sellPlan), null);
  assert.equal(paper.open().length, 0);
});

test('PaperTrading preserves standalone signal calculations without a plan', () => {
  const paper = new PaperTradingEngine({ logger, symbol: 'TEST' });
  const trade = paper.signal(paperEngines(), 100, '1h', 'BUY');

  assert.ok(trade);
  assert.equal(trade.stopLoss, 96);
  assert.equal(trade.takeProfit, 106);
  assert.equal(trade.positionSize, 25);
  assert.equal(trade.riskReward, 1.5);
});
