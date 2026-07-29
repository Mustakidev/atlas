const test = require('node:test');
const assert = require('node:assert/strict');

const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');

const logger = { info() {}, warn() {}, error() {} };

const validParams = {
  symbol: 'BTCUSDT',
  timeframe: '1h',
  entryPrice: 100,
  atr: { ready: true, atr: 1, atrPercentage: 1 },
  direction: 'BUY',
  trend: null,
  structure: null,
  confluence: { confidence: 80 },
  regime: 'TRENDING_BULL',
};

function createEngine({ maxDailyLossPct = 100, maxDailyDrawdownPct = 10, maxConsecutiveLosses = 100 } = {}) {
  const engine = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: null,
  });
  engine.setMaxDailyLossPct(maxDailyLossPct);
  engine.setMaxDailyDrawdownPct(maxDailyDrawdownPct);
  engine.setMaxConsecutiveLosses(maxConsecutiveLosses);
  return engine;
}

function evaluate(engine, overrides = {}) {
  return engine.evaluate({ ...validParams, ...overrides });
}

test('baseline drawdown is zero', () => {
  const engine = createEngine();
  const result = evaluate(engine);

  assert.equal(engine._calculateDailyDrawdownPct(), 0);
  assert.equal(result.dailyDrawdownPct, 0);
  assert.equal(engine.getDailyDrawdownPct(), 0);
  assert.equal(result.tradeAllowed, true);
});

test('profit raises the high-water mark and drawdown remains zero', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  const result = evaluate(engine);

  assert.equal(engine._dailyHighWater, 11000);
  assert.equal(engine._dailyPnL, 1000);
  assert.equal(result.dailyDrawdownPct, 0);
  assert.equal(engine.getDailyDrawdownPct(), 0);
  assert.equal(result.tradeAllowed, true);
});

test('loss after a new high is calculated from that high-water mark', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-100);
  const result = evaluate(engine);

  assert.equal(engine._dailyHighWater, 11000);
  assert.equal(engine._dailyPnL, 900);
  assert.equal(result.dailyDrawdownPct, 1);
  assert.equal(engine.getDailyDrawdownPct(), 1);
});

test('sequential losses create positive drawdown', () => {
  const engine = createEngine();
  engine.onTradeClosed(-100);
  engine.onTradeClosed(-100);
  engine.onTradeClosed(-100);
  const result = evaluate(engine);

  assert.equal(engine._dailyPnL, -300);
  assert.equal(result.dailyDrawdownPct, 3);
  assert.equal(engine.getDailyDrawdownPct(), 3);
  assert.equal(result.tradeAllowed, true);
});

test('drawdown immediately below the limit is allowed', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-999);
  const result = evaluate(engine);

  assert.equal(result.dailyDrawdownPct, 9.99);
  assert.equal(engine.getDailyDrawdownPct(), 9.99);
  assert.equal(result.tradeAllowed, true);
});

test('drawdown exactly at the limit is rejected', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-1000);
  const result = evaluate(engine);

  assert.equal(result.dailyDrawdownPct, 10);
  assert.equal(result.tradeAllowed, false);
  assert.match(result.rejectionReason, /10\.00% >= 10% max/);
});

test('drawdown immediately above the limit is rejected', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-1001);
  const result = evaluate(engine);

  assert.equal(result.dailyDrawdownPct, 10.01);
  assert.equal(result.tradeAllowed, false);
  assert.match(result.rejectionReason, /10\.01% >= 10% max/);
});

test('positive daily PnL does not create false drawdown', () => {
  const engine = createEngine();
  engine.onTradeClosed(500);
  const result = evaluate(engine);

  assert.equal(engine._calculateDailyDrawdownPct(), 0);
  assert.equal(result.dailyDrawdownPct, 0);
  assert.equal(result.tradeAllowed, true);
});

test('negative daily PnL does not create negative drawdown', () => {
  const engine = createEngine();
  engine.onTradeClosed(-500);
  const result = evaluate(engine);

  assert.equal(engine._calculateDailyDrawdownPct(), 5);
  assert.equal(result.dailyDrawdownPct, 5);
  assert.equal(engine.getDailyDrawdownPct(), 5);
});

test('evaluation and accessor values match for allowed results', () => {
  const engine = createEngine();
  engine.onTradeClosed(-500);
  const result = evaluate(engine);

  assert.equal(result.tradeAllowed, true);
  assert.equal(result.dailyDrawdownPct, engine.getDailyDrawdownPct());
});

test('evaluation and accessor values match for rejected results', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-1001);
  const result = evaluate(engine);

  assert.equal(result.tradeAllowed, false);
  assert.equal(result.dailyDrawdownPct, engine.getDailyDrawdownPct());
});

test('rejection reason and returned drawdown use the same value', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-1001);
  const result = evaluate(engine);

  assert.equal(result.dailyDrawdownPct, 10.01);
  assert.match(result.rejectionReason, new RegExp(`${result.dailyDrawdownPct.toFixed(2)}%`));
});

test('explicit reset clears daily drawdown state', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-100);
  engine.resetDaily();

  assert.equal(engine._dailyHighWater, 10000);
  assert.equal(engine._dailyPnL, 0);
  assert.equal(engine.getDailyDrawdownPct(), 0);
});

test('automatic rollover preserves existing reset behavior', () => {
  const engine = createEngine();
  engine.onTradeClosed(1000);
  engine.onTradeClosed(-100);
  engine._consecutiveLosses = 3;
  engine._lastResetDay = new Date(Date.now() - 86400000 - 1000).toDateString();

  const result = evaluate(engine);
  const state = engine.getState();

  assert.equal(result.tradeAllowed, true);
  assert.equal(state.dailyPnL, 0);
  assert.equal(state.dailyDrawdownPct, 0);
  assert.equal(state.consecutiveLosses, 0);
});

test('daily-loss precedence remains unchanged', () => {
  const engine = createEngine({ maxDailyLossPct: 5, maxConsecutiveLosses: 100 });
  for (let i = 0; i < 5; i++) engine.onTradeClosed(-100);

  const result = evaluate(engine);

  assert.equal(result.tradeAllowed, false);
  assert.match(result.rejectionReason, /^Daily loss limit reached/);
});

test('consecutive-loss precedence remains unchanged', () => {
  const engine = createEngine({ maxDailyLossPct: 100, maxConsecutiveLosses: 3 });
  for (let i = 0; i < 3; i++) engine.onTradeClosed(-100);

  const result = evaluate(engine);

  assert.equal(result.tradeAllowed, false);
  assert.match(result.rejectionReason, /^Consecutive loss pause active/);
});

test('non-drawdown decisions remain unchanged', () => {
  const engine = createEngine();

  const invalidAtr = evaluate(engine, { atr: { ready: false, atr: null, atrPercentage: 0 } });
  const lowConfidence = evaluate(engine, { confluence: { confidence: 10 } });

  assert.equal(invalidAtr.tradeAllowed, false);
  assert.equal(invalidAtr.rejectionReason, 'ATR not ready or invalid');
  assert.equal(lowConfidence.tradeAllowed, false);
  assert.equal(lowConfidence.rejectionReason, 'Confluence confidence 10 below minimum 30');
});
