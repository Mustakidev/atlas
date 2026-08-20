const test = require('node:test');
const assert = require('node:assert/strict');

const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const START = Date.parse('2024-01-01T00:00:00.000Z');
const logger = { info() {}, warn() {}, error() {} };

function makeEngine(maxTrades = 1) {
  let nowMs = START;
  let monotonicMs = 0;
  const engine = new PaperTradingEngine({
    logger,
    symbol: 'BTCUSDT',
    clock: {
      nowMs: () => nowMs,
      monotonicMs: () => monotonicMs++,
    },
  });
  engine._maxTrades = maxTrades;
  return {
    engine,
    setNow(value) { nowMs = value; },
  };
}

function open(engine, price, nowMs, plan = { stopLoss: 90, takeProfit: 200, positionSize: 25, riskReward: 4.4 }) {
  return engine.signal({}, price, '1h', 'BUY', plan, { nowMs });
}

test('OPEN FIFO overflow closes the oldest trade before eviction with full accounting', () => {
  const { engine } = makeEngine(1);
  const first = open(engine, 100, START);

  assert.deepEqual(engine.evaluateTrades(104, { nowMs: START + 3600000 }), []);
  const replacement = open(engine, 105, START + 7200000);
  const history = engine.history();

  assert.equal(replacement.tradeId, 'PT-2');
  assert.equal(replacement.status, 'OPEN');
  assert.equal(engine.open().length, 1);
  assert.equal(engine.open()[0].tradeId, replacement.tradeId);
  assert.equal(engine.all().length, 1);
  assert.equal(engine.getTrade(first.tradeId), null);
  assert.equal(history.length, 1);
  assert.equal(history[0].tradeId, first.tradeId);
  assert.equal(history[0].status, 'CLOSED');
  assert.equal(history[0].exitReason, 'Invalidated');
  assert.equal(history[0].exitPrice, 104);
  assert.equal(history[0].exitTime, '2024-01-01T02:00:00.000Z');
  assert.equal(history[0].duration, 7200000);
  assert.equal(history[0].pnl, 100);
  assert.equal(history[0].pnlPercent, 4);
  assert.equal(engine.getBalance(), 10100);
  assert.equal(engine.stats().closedTrades, 1);
  assert.equal(engine.stats().openTrades, 1);
  assert.equal(engine.stats().totalPnl, 100);
  assert.equal(engine.performance().totalPnl, 100);
  assert.equal(engine.all().length <= engine.getInfo().maxTrades, true);
  assert.equal(Object.hasOwn(replacement, 'closed'), false);
});

test('capacity overflow preserves FIFO selection across multiple retained trades', () => {
  const { engine } = makeEngine(2);
  const first = open(engine, 100, START);
  const second = open(engine, 101, START + 3600000);
  const third = open(engine, 102, START + 7200000);

  assert.deepEqual(engine.open().map(trade => trade.tradeId), [second.tradeId, third.tradeId]);
  assert.deepEqual(engine.history().map(trade => trade.tradeId), [first.tradeId]);
  assert.equal(engine.history()[0].exitReason, 'Invalidated');
});

test('repeated overflow records each logical closure once and reconciles balance', () => {
  const { engine } = makeEngine(1);
  const first = open(engine, 100, START);
  assert.deepEqual(engine.evaluateTrades(104, { nowMs: START + 3600000 }), []);
  const second = open(engine, 105, START + 7200000);
  assert.deepEqual(engine.evaluateTrades(109, { nowMs: START + 10800000 }), []);
  const third = open(engine, 110, START + 14400000);

  assert.deepEqual(engine.history().map(trade => trade.tradeId), [first.tradeId, second.tradeId]);
  assert.equal(new Set(engine.history().map(trade => trade.tradeId)).size, 2);
  assert.equal(engine.history().reduce((sum, trade) => sum + trade.pnl, 0), 200);
  assert.equal(engine.getBalance(), 10200);
  assert.deepEqual(engine.open().map(trade => trade.tradeId), [third.tradeId]);
});

test('already-CLOSED FIFO records age out without duplicate closure or balance updates', () => {
  const { engine } = makeEngine(1);
  const first = open(engine, 100, START);
  const manuallyClosed = engine.close(first.tradeId, 'Manual', { nowMs: START + 3600000 });
  const historyBefore = engine.history();
  const balanceBefore = engine.getBalance();

  const replacement = open(engine, 105, START + 7200000);
  const historyAfter = engine.history();

  assert.equal(manuallyClosed.status, 'CLOSED');
  assert.equal(replacement.status, 'OPEN');
  assert.equal(engine.getTrade(first.tradeId), null);
  assert.equal(engine.open().length, 1);
  assert.deepEqual(historyAfter, historyBefore);
  assert.equal(historyAfter.filter(trade => trade.tradeId === first.tradeId).length, 1);
  assert.equal(engine.getBalance(), balanceBefore);
  assert.equal(engine.stats().closedTrades, 1);
});
