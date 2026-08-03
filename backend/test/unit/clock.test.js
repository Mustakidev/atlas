const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertTimestamp,
  captureCycleTime,
  elapsedMs,
  resolveClock,
  resolveCycleNowMs,
  utcDateKey,
} = require('../../src/core/clock');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const logger = { info() {}, warn() {}, error() {} };
const START = Date.parse('2024-01-01T00:00:00.000Z');
const NEXT_DAY = START + 86400000;

function modernClock(nowMs = START, monotonicValues = [100, 101]) {
  let monotonicIndex = 0;
  return {
    nowMs: () => nowMs,
    monotonicMs: () => monotonicValues[Math.min(monotonicIndex++, monotonicValues.length - 1)],
  };
}

function riskInput() {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 100,
    direction: 'BUY',
    atr: { ready: true, atr: 1, atrPercentage: 1 },
    trend: null,
    structure: null,
    confluence: { confidence: 80 },
    regime: 'TRENDING_BULL',
  };
}

test('null and undefined clocks resolve to safe system clocks', () => {
  assert.doesNotThrow(() => resolveClock(null).nowMs());
  assert.doesNotThrow(() => resolveClock(undefined).nowMs());
  assert.equal(typeof resolveClock(null).monotonicMs(), 'number');
});

test('invalid clock objects are rejected', () => {
  assert.throws(() => resolveClock({}), /clock\.nowMs/);
  assert.throws(() => resolveClock({ nowMs: () => START }), /clock\.monotonicMs/);
  assert.throws(() => resolveClock({ nowMs: () => START, monotonicMs: 'invalid' }), /clock\.monotonicMs/);
});

test('invalid explicit timestamps are rejected without fallback', () => {
  const clock = resolveClock({ nowMs: () => NaN, monotonicMs: () => 1 });

  assert.equal(assertTimestamp(0), 0);
  assert.equal(assertTimestamp(START), START);
  assert.equal(assertTimestamp(8640000000000000), 8640000000000000);
  assert.throws(() => assertTimestamp(-1), /finite integer/);
  assert.throws(() => assertTimestamp(-0.5), /finite integer/);
  assert.throws(() => clock.nowMs(), /finite integer/);
  assert.throws(() => resolveCycleNowMs(clock, NaN), /finite integer/);
  assert.throws(() => resolveCycleNowMs(clock, START + 0.5), /finite integer/);
  assert.throws(() => resolveCycleNowMs(clock, 8640000000000001), /finite integer/);
});

test('cycle capture reads wall time once and derives display values from it', () => {
  let nowCalls = 0;
  const clock = resolveClock({
    nowMs: () => {
      nowCalls++;
      return START;
    },
    monotonicMs: () => 10,
  });

  const cycle = captureCycleTime(clock);

  assert.equal(nowCalls, 1);
  assert.deepEqual({ nowMs: cycle.nowMs, isoNow: cycle.isoNow }, {
    nowMs: START,
    isoNow: '2024-01-01T00:00:00.000Z',
  });
  assert.equal(Object.isFrozen(cycle), true);
});

test('AdvanceRisk uses injected UTC session time', () => {
  const engine = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: {},
    clock: modernClock(),
  });

  assert.equal(engine.evaluate({ ...riskInput(), nowMs: START }).session, 'ASIAN');
  assert.equal(engine.evaluate({ ...riskInput(), nowMs: START + 8 * 3600000 }).session, 'LONDON');
  assert.equal(engine.evaluate({ ...riskInput(), nowMs: START + 16 * 3600000 }).session, 'NEW_YORK');
});

test('AdvanceRisk uses injected UTC date for rollover and reset', () => {
  const engine = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: {},
    clock: modernClock(),
  });
  engine.onTradeClosed(100, { nowMs: START });

  const result = engine.evaluate({ ...riskInput(), nowMs: NEXT_DAY });

  assert.equal(result.dailyPnL, 0);
  assert.equal(engine._lastResetDay, utcDateKey(NEXT_DAY));
  engine.resetDaily(NEXT_DAY + 86400000);
  assert.equal(engine._lastResetDay, utcDateKey(NEXT_DAY + 86400000));
});

test('AdvanceRisk daily rollover uses UTC dates across positive local offsets', () => {
  const firstUtc = Date.parse('2024-01-01T23:30:00.000Z');
  const secondUtc = Date.parse('2024-01-02T00:30:00.000Z');
  const positiveOffsetMs = 2 * 3600000;

  assert.equal(new Date(firstUtc + positiveOffsetMs).toISOString().slice(0, 10), '2024-01-02');
  assert.equal(new Date(secondUtc + positiveOffsetMs).toISOString().slice(0, 10), '2024-01-02');
  assert.notEqual(utcDateKey(firstUtc), utcDateKey(secondUtc));

  const engine = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: {},
    clock: modernClock(firstUtc),
  });
  engine.onTradeClosed(-100, { nowMs: firstUtc });

  const result = engine.evaluate({ ...riskInput(), nowMs: secondUtc });

  assert.equal(result.dailyPnL, 0);
  assert.equal(engine._lastResetDay, utcDateKey(secondUtc));
});

test('AdvanceRisk uses injected time for consecutive-loss pause and expiry', () => {
  const engine = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: {},
    clock: modernClock(),
  });
  engine.setMaxDailyLossPct(100);
  engine.setMaxConsecutiveLosses(3);

  for (let index = 0; index < 3; index++) {
    engine.onTradeClosed(-1, { nowMs: START });
  }

  assert.equal(engine.evaluate({ ...riskInput(), nowMs: START + 3599999 }).tradeAllowed, false);
  assert.equal(engine.evaluate({ ...riskInput(), nowMs: START + 3600000 }).tradeAllowed, true);
});

test('PaperTrading uses injected entry and exit timestamps for duration', () => {
  const engine = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock: modernClock() });
  const opened = engine.signal({}, 100, '1h', 'BUY', {
    stopLoss: 96,
    takeProfit: 106,
    positionSize: 1,
    riskReward: 2.5,
  }, { nowMs: START });

  const closed = engine.evaluateTrades(106, { nowMs: START + 3600000 });

  assert.equal(opened.entryTime, '2024-01-01T00:00:00.000Z');
  assert.equal(closed[0].exitTime, '2024-01-01T01:00:00.000Z');
  assert.equal(closed[0].duration, 3600000);
  assert.equal(engine.lastUpdated, '2024-01-01T00:00:00.000Z');
});

test('PaperTrading onCandle uses injected closure time', () => {
  const engine = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock: modernClock() });
  engine.signal({}, 100, '1h', 'BUY', {
    stopLoss: 96,
    takeProfit: 106,
    positionSize: 1,
    riskReward: 2.5,
  }, { nowMs: START });

  const result = engine.onCandle({ open: 100, high: 106, low: 99, close: 106 }, { nowMs: START + 3600000 });

  assert.equal(result.closed[0].exitTime, '2024-01-01T01:00:00.000Z');
  assert.equal(result.closed[0].duration, 3600000);
});

test('PaperTrading close and invalidate use injected closure time', () => {
  const closeEngine = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock: modernClock() });
  const invalidateEngine = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock: modernClock() });
  const plan = { stopLoss: 96, takeProfit: 106, positionSize: 1, riskReward: 2.5 };
  const closeTrade = closeEngine.signal({}, 100, '1h', 'BUY', plan, { nowMs: START });
  const invalidateTrade = invalidateEngine.signal({}, 100, '1h', 'BUY', plan, { nowMs: START });

  const closed = closeEngine.close(closeTrade.tradeId, 'Manual', { nowMs: START + 7200000 });
  const invalidated = invalidateEngine.invalidate(invalidateTrade.tradeId, { nowMs: START + 10800000 });

  assert.equal(closed.exitTime, '2024-01-01T02:00:00.000Z');
  assert.equal(closed.duration, 7200000);
  assert.equal(invalidated.exitTime, '2024-01-01T03:00:00.000Z');
  assert.equal(invalidated.duration, 10800000);
});

test('monotonic timing is separate from wall time and non-negative', () => {
  const clock = resolveClock(modernClock(START, [103]));

  assert.equal(elapsedMs(clock, 100), 3);
  assert.equal(resolveCycleNowMs(clock, START), START);
  assert.throws(() => elapsedMs(resolveClock({ nowMs: () => START, monotonicMs: () => 100 }), 103), /must not move backwards/);
});

test('engines remain constructible without an explicit clock', () => {
  const risk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: null, config: {} });
  const paper = new PaperTradingEngine({ logger, symbol: 'BTCUSDT' });

  assert.doesNotThrow(() => risk.evaluate(riskInput()));
  assert.ok(paper.signal({}, 100, '1h', 'BUY', {
    stopLoss: 96,
    takeProfit: 106,
    positionSize: 1,
    riskReward: 2.5,
  }));
});
