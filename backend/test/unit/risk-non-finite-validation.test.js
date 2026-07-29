const test = require('node:test');
const assert = require('node:assert/strict');

const { RiskEngine } = require('../../src/engine/risk');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');

const logger = { info() {}, warn() {}, error() {} };

const invalidNumbers = [NaN, Infinity, -Infinity, '100', null, undefined];
const invalidPositiveNumbers = [...invalidNumbers, 0, -1];

function riskInput(overrides = {}) {
  return {
    symbol: 'TEST',
    timeframe: '1h',
    entryPrice: 100,
    atr: { ready: true, atr: 2, atrPercentage: 1 },
    direction: 'BUY',
    trend: null,
    structure: null,
    confluence: { confidence: 80 },
    ...overrides,
  };
}

function makeRisk() {
  return new RiskEngine({ logger, symbol: 'TEST' });
}

function makeAdvanceRisk() {
  return new AdvanceRiskEngine({ logger, symbol: 'TEST', paperTradeEngine: null, config: {} });
}

function assertFiniteAllowed(result, fields) {
  assert.equal(result.tradeAllowed, true, result.rejectionReason);
  for (const field of fields) {
    assert.equal(Number.isFinite(result[field]), true, `${field} must be finite`);
  }
}

test('RiskEngine rejects malformed entry prices and ATR values', () => {
  for (const value of invalidPositiveNumbers) {
    const entryResult = makeRisk().evaluate(riskInput({ entryPrice: value }));
    assert.equal(entryResult.tradeAllowed, false, `entryPrice=${String(value)}`);
    assert.equal(entryResult.rejectionReason, 'Invalid entry price');

    const atrResult = makeRisk().evaluate(riskInput({ atr: { ready: true, atr: value, atrPercentage: 1 } }));
    assert.equal(atrResult.tradeAllowed, false, `atr=${String(value)}`);
    assert.equal(atrResult.rejectionReason, 'ATR not ready or invalid');
  }
});

test('AdvanceRiskEngine rejects malformed entry prices and ATR values', () => {
  for (const value of invalidPositiveNumbers) {
    const entryResult = makeAdvanceRisk().evaluate(riskInput({ entryPrice: value, regime: 'TRENDING_BULL' }));
    assert.equal(entryResult.tradeAllowed, false, `entryPrice=${String(value)}`);
    assert.equal(entryResult.rejectionReason, 'Invalid entry price');

    const atrResult = makeAdvanceRisk().evaluate(riskInput({
      atr: { ready: true, atr: value, atrPercentage: 1 },
      regime: 'TRENDING_BULL',
    }));
    assert.equal(atrResult.tradeAllowed, false, `atr=${String(value)}`);
    assert.equal(atrResult.rejectionReason, 'ATR not ready or invalid');
  }
});

for (const [name, Engine, extra] of [
  ['RiskEngine', RiskEngine, {}],
  ['AdvanceRiskEngine', AdvanceRiskEngine, { regime: 'TRENDING_BULL' }],
]) {
  test(`${name} rejects malformed ATR percentages and confidence values`, () => {
    for (const value of [NaN, Infinity, -Infinity, '1', null, undefined, -1]) {
      const atrResult = new Engine({ logger, symbol: 'TEST', paperTradeEngine: null, config: {} }).evaluate(
        riskInput({ ...extra, atr: { ready: true, atr: 2, atrPercentage: value } })
      );
      assert.equal(atrResult.tradeAllowed, false, `atrPercentage=${String(value)}`);
      assert.match(atrResult.rejectionReason, /ATR percentage|Volatility/);

      const confidenceResult = new Engine({ logger, symbol: 'TEST', paperTradeEngine: null, config: {} }).evaluate(
        riskInput({ ...extra, confluence: { confidence: value } })
      );
      assert.equal(confidenceResult.tradeAllowed, false, `confidence=${String(value)}`);
      assert.match(confidenceResult.rejectionReason, /confidence/i);
    }
  });

  test(`${name} preserves finite threshold boundaries and output finiteness`, () => {
    const engine = new Engine({ logger, symbol: 'TEST', paperTradeEngine: null, config: {} });
    const result = engine.evaluate(riskInput({
      ...extra,
      atr: { ready: true, atr: 2, atrPercentage: 5 },
      confluence: { confidence: 30 },
    }));
    const fields = name === 'RiskEngine'
      ? ['entryPrice', 'stopLoss', 'takeProfit', 'riskReward', 'risk', 'reward', 'atrUsed', 'atrMultiplierSL', 'atrMultiplierTP', 'confluenceConfidence', 'volatilityPct']
      : ['entryPrice', 'stopLoss', 'takeProfit', 'riskReward', 'riskPerUnit', 'rewardPerUnit', 'positionSize', 'dollarRisk', 'accountBalance', 'riskPerTradePct', 'atrUsed', 'atrMultiplier', 'sessionMultiplier', 'dailyPnL', 'dailyDrawdownPct'];
    assertFiniteAllowed(result, fields);
  });
}

test('RiskEngine rejects overflow and rounded-zero risk distances', () => {
  const overflow = makeRisk().evaluate(riskInput({ entryPrice: Number.MAX_VALUE }));
  assert.equal(overflow.tradeAllowed, false);
  assert.equal(overflow.rejectionReason, 'Risk calculation produced non-finite value');

  const collapsed = makeRisk().evaluate(riskInput({ atr: { ready: true, atr: Number.MIN_VALUE, atrPercentage: 1 } }));
  assert.equal(collapsed.tradeAllowed, false);
  assert.equal(collapsed.rejectionReason, 'Risk distance must be finite and greater than zero');
});

test('AdvanceRiskEngine rejects overflow and rounded-zero risk distances', () => {
  const overflow = makeAdvanceRisk().evaluate(riskInput({ entryPrice: Number.MAX_VALUE, regime: 'TRENDING_BULL' }));
  assert.equal(overflow.tradeAllowed, false);
  assert.equal(overflow.rejectionReason, 'Risk calculation produced non-finite value');

  const collapsed = makeAdvanceRisk().evaluate(riskInput({
    atr: { ready: true, atr: Number.MIN_VALUE, atrPercentage: 1 },
    regime: 'TRENDING_BULL',
  }));
  assert.equal(collapsed.tradeAllowed, false);
  assert.equal(collapsed.rejectionReason, 'Risk distance must be finite and greater than zero');
});

test('RiskEngine setters reject invalid values without changing valid policy state', () => {
  const engine = makeRisk();
  engine.setRiskRewardRatio(3);
  engine.setMinConfidence(40);
  engine.setMaxVolatilityPct(4);
  const before = { ...engine.getInfo(), tpAtrMult: engine._tpAtrMult };

  const invalid = [
    ['setRiskRewardRatio', [NaN, Infinity, -Infinity, '3', null, undefined, 0, -1]],
    ['setMinConfidence', [NaN, Infinity, -Infinity, '40', null, undefined, -1, 101]],
    ['setMaxVolatilityPct', [NaN, Infinity, -Infinity, '4', null, undefined, 0, -1]],
  ];
  for (const [setter, values] of invalid) {
    for (const value of values) {
      engine[setter](value);
      assert.deepEqual({ ...engine.getInfo(), tpAtrMult: engine._tpAtrMult }, before, `${setter}=${String(value)}`);
    }
  }
});

test('AdvanceRiskEngine setters reject invalid values without changing valid policy state', () => {
  const engine = makeAdvanceRisk();
  const valid = [
    ['setAccountBalance', 12000],
    ['setRiskPerTradePct', 2],
    ['setMaxDailyLossPct', 6],
    ['setMaxDailyDrawdownPct', 12],
    ['setMaxConsecutiveLosses', 4],
    ['setConsecutiveCooldownMs', 1234],
    ['setAtrMultTrending', 2.5],
    ['setAtrMultRanging', 1.25],
    ['setRrTrending', 4],
    ['setRrRanging', 2],
  ];
  for (const [setter, value] of valid) engine[setter](value);
  engine.setSessionMultiplier('ASIAN', 2);
  const before = engine.getPolicy();

  const invalid = [
    ['setAccountBalance', [NaN, Infinity, -Infinity, '12000', null, undefined, 0, -1]],
    ['setRiskPerTradePct', [NaN, Infinity, -Infinity, '2', null, undefined, 0, -1, 101]],
    ['setMaxDailyLossPct', [NaN, Infinity, -Infinity, '6', null, undefined, 0, -1, 101]],
    ['setMaxDailyDrawdownPct', [NaN, Infinity, -Infinity, '12', null, undefined, 0, -1, 101]],
    ['setMaxConsecutiveLosses', [NaN, Infinity, -Infinity, '4', null, undefined, 0, -1]],
    ['setConsecutiveCooldownMs', [NaN, Infinity, -Infinity, '1234', null, undefined, 0, -1]],
    ['setAtrMultTrending', [NaN, Infinity, -Infinity, '2.5', null, undefined, 0, -1]],
    ['setAtrMultRanging', [NaN, Infinity, -Infinity, '1.25', null, undefined, 0, -1]],
    ['setRrTrending', [NaN, Infinity, -Infinity, '4', null, undefined, 0, -1]],
    ['setRrRanging', [NaN, Infinity, -Infinity, '2', null, undefined, 0, -1]],
  ];
  for (const [setter, values] of invalid) {
    for (const value of values) {
      engine[setter](value);
      assert.deepEqual(engine.getPolicy(), before, `${setter}=${String(value)}`);
    }
  }
  for (const value of [NaN, Infinity, -Infinity, '2', null, undefined, -1, 6]) {
    engine.setSessionMultiplier('ASIAN', value);
    assert.deepEqual(engine.getPolicy(), before, `setSessionMultiplier=${String(value)}`);
  }
});

test('valid finite setter boundaries remain accepted', () => {
  const risk = makeRisk();
  risk.setMinConfidence(0);
  risk.setMaxVolatilityPct(0.1);
  risk.setRiskRewardRatio(Number.MIN_VALUE);
  assert.equal(risk.getInfo().minConfidence, 0);
  assert.equal(risk.getInfo().maxVolatilityPct, 0.1);
  assert.equal(risk.getInfo().riskRewardRatio, Number.MIN_VALUE);

  const advance = makeAdvanceRisk();
  advance.setRiskPerTradePct(100);
  advance.setMaxDailyLossPct(100);
  advance.setMaxDailyDrawdownPct(100);
  advance.setSessionMultiplier('ASIAN', 0);
  assert.equal(advance.getPolicy().riskPerTradePct, 100);
  assert.equal(advance.getPolicy().maxDailyLossPct, 100);
  assert.equal(advance.getPolicy().maxDailyDrawdownPct, 100);
  assert.equal(advance.getPolicy().sessionMultipliers.ASIAN, 0);

  advance.setAccountBalance(Number.MIN_VALUE);
  advance.setMaxConsecutiveLosses(Number.MIN_VALUE);
  advance.setConsecutiveCooldownMs(Number.MIN_VALUE);
  advance.setAtrMultTrending(Number.MIN_VALUE);
  advance.setAtrMultRanging(Number.MIN_VALUE);
  advance.setRrTrending(Number.MIN_VALUE);
  advance.setRrRanging(Number.MIN_VALUE);
  advance.setSessionMultiplier('ASIAN', 5);
  const boundaryPolicy = advance.getPolicy();
  assert.equal(boundaryPolicy.accountBalance, Number.MIN_VALUE);
  assert.equal(boundaryPolicy.maxConsecutiveLosses, Number.MIN_VALUE);
  assert.equal(boundaryPolicy.cooldownMs, Number.MIN_VALUE);
  assert.equal(boundaryPolicy.atrMultTrending, Number.MIN_VALUE);
  assert.equal(boundaryPolicy.atrMultRanging, Number.MIN_VALUE);
  assert.equal(boundaryPolicy.rrTrending, Number.MIN_VALUE);
  assert.equal(boundaryPolicy.rrRanging, Number.MIN_VALUE);
  assert.equal(boundaryPolicy.sessionMultipliers.ASIAN, 5);
});

test('AdvanceRiskEngine ignores invalid PnL without mutating state', () => {
  const engine = makeAdvanceRisk();
  engine.setMaxDailyLossPct(100);
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-100);
  const before = {
    dailyPnL: engine._dailyPnL,
    dailyHighWater: engine._dailyHighWater,
    consecutiveLosses: engine._consecutiveLosses,
    lossPauseUntil: engine._lossPauseUntil,
    dailyLossLimitReached: engine._dailyLossLimitReached,
    lastUpdated: engine.lastUpdated,
  };

  for (const value of [NaN, Infinity, -Infinity, '100', null, undefined]) {
    engine.onTradeClosed(value);
    assert.deepEqual({
      dailyPnL: engine._dailyPnL,
      dailyHighWater: engine._dailyHighWater,
      consecutiveLosses: engine._consecutiveLosses,
      lossPauseUntil: engine._lossPauseUntil,
      dailyLossLimitReached: engine._dailyLossLimitReached,
      lastUpdated: engine.lastUpdated,
    }, before, `pnl=${String(value)}`);
  }

  const result = engine.evaluate(riskInput({ regime: 'TRENDING_BULL' }));
  assert.equal(result.tradeAllowed, true);
  assert.equal(Number.isFinite(result.dailyPnL), true);
  assert.equal(Number.isFinite(result.dailyDrawdownPct), true);
});

test('valid calculations and rejection precedence remain unchanged', () => {
  const risk = makeRisk().evaluate(riskInput());
  assertFiniteAllowed(risk, ['entryPrice', 'stopLoss', 'takeProfit', 'riskReward', 'risk', 'reward']);
  assert.deepEqual({ stopLoss: risk.stopLoss, takeProfit: risk.takeProfit, riskReward: risk.riskReward }, {
    stopLoss: 96,
    takeProfit: 108,
    riskReward: 2,
  });

  const advance = makeAdvanceRisk().evaluate(riskInput({ regime: 'TRENDING_BULL' }));
  assertFiniteAllowed(advance, ['entryPrice', 'stopLoss', 'takeProfit', 'riskReward', 'riskPerUnit', 'rewardPerUnit', 'positionSize', 'dollarRisk']);
  assert.deepEqual({ stopLoss: advance.stopLoss, takeProfit: advance.takeProfit, riskReward: advance.riskReward }, {
    stopLoss: 96,
    takeProfit: 112,
    riskReward: 3,
  });

  const precedence = makeAdvanceRisk().evaluate(riskInput({
    atr: { ready: false, atr: null, atrPercentage: NaN },
    confluence: { confidence: 10 },
    regime: 'TRENDING_BULL',
  }));
  assert.equal(precedence.rejectionReason, 'ATR not ready or invalid');
});
