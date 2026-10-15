'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEmaCrossTrend, EMA_CROSS_DEFAULTS } = require('../../src/strategy/emaCrossTrend');
const { simulate } = require('../../research/engine');
const { STRATEGIES, createContext } = require('../../research/strategies');

const HOUR = 3_600_000;
const H4 = 4 * HOUR;
const T0 = Date.UTC(2024, 0, 1);
const PARAMS = { ...EMA_CROSS_DEFAULTS, fast: 3, slow: 8, atrPeriod: 3, atrMult: 2 };

function candlesFromCloses(closes, spread = 1) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { openTime: T0 + i * H4, open, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread, close };
  });
}

const flat = n => Array.from({ length: n }, () => 100);
const ramp = (from, step, n) => Array.from({ length: n }, (_, i) => from + step * (i + 1));

test('reports not ready until there are enough closed candles', () => {
  const result = evaluateEmaCrossTrend(candlesFromCloses(flat(5)), { params: PARAMS });
  assert.equal(result.ready, false);
  assert.match(result.reason, /Insufficient 4h candles \(5\/10\)/);
});

test('rejects invalid candle data instead of producing a signal', () => {
  const candles = candlesFromCloses(flat(20));
  candles[3] = { ...candles[3], close: Number.NaN };
  assert.equal(evaluateEmaCrossTrend(candles, { params: PARAMS }).ready, false);
});

test('a flip on the last closed candle is a fresh entry with a stop and no fill yet', () => {
  const closes = [...ramp(130, -2, 20)];
  closes.push(closes.at(-1) + 25);
  const result = evaluateEmaCrossTrend(candlesFromCloses(closes), { params: PARAMS });
  assert.equal(result.ready, true);
  assert.equal(result.trend, 'UP');
  assert.equal(result.action, 'ENTER_LONG');
  assert.equal(result.signal.barsAgo, 0);
  assert.equal(result.signal.entryPrice, null);
  assert.ok(result.signal.stop < result.signal.price);
  assert.equal(result.nextCheckAt, result.asOf + H4);
});

test('an open trend trade is held with its original entry and stop', () => {
  const closes = [...ramp(130, -2, 20), ...ramp(92, 3, 6)];
  const result = evaluateEmaCrossTrend(candlesFromCloses(closes), { params: PARAMS });
  assert.equal(result.action, 'HOLD_LONG');
  assert.ok(result.signal.barsAgo > 0);
  assert.ok(Number.isFinite(result.signal.entryPrice));
  assert.ok(result.signal.stop < result.signal.entryPrice);
});

test('the opposite flip reverses, and the closed trade is recorded at the next open', () => {
  const closes = [...ramp(130, -2, 20), ...ramp(92, 3, 10)];
  closes.push(closes.at(-1) - 60);
  const params = { ...PARAMS, atrMult: 50 };
  const flipped = evaluateEmaCrossTrend(candlesFromCloses(closes, 0.5), { params });
  assert.equal(flipped.action, 'REVERSE_TO_SHORT');
  assert.equal(flipped.history.length, 0);

  closes.push(closes.at(-1) - 1);
  const filled = evaluateEmaCrossTrend(candlesFromCloses(closes, 0.5), { params });
  assert.equal(filled.action, 'HOLD_SHORT');
  assert.equal(filled.history[0].direction, 'LONG');
  assert.equal(filled.history[0].exitReason, 'REVERSE');
  assert.equal(filled.history[0].exitPrice, closes.at(-2));
  assert.equal(filled.signal.entryPrice, closes.at(-2));
});

test('after a stop-out the strategy waits for the next flip', () => {
  const closes = [...ramp(130, -2, 20), ...ramp(92, 3, 6)];
  closes.push(closes.at(-1) - 6, closes.at(-1) - 4); // shallow dip: trend stays UP
  const candles = candlesFromCloses(closes);
  const held = evaluateEmaCrossTrend(candles.slice(0, 26), { params: PARAMS });
  const last = candles.length - 2;
  candles[last] = { ...candles[last], low: held.signal.stop - 1 }; // wick through the stop
  const result = evaluateEmaCrossTrend(candles, { params: PARAMS });
  assert.equal(result.trend, 'UP');
  assert.equal(result.action, 'WAIT');
  assert.equal(result.direction, null);
  assert.equal(result.history[0].exitReason, 'STOP');
  assert.equal(result.history[0].exitPrice, held.signal.stop);
});

test('live evaluation reproduces the research backtest trade-for-trade', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const h1 = [];
  let price = 20_000;
  for (let i = 0; i < 4 * 900; i++) {
    const open = price;
    price *= 1 + (rnd() - 0.5) * 0.02;
    h1.push({ openTime: T0 + i * HOUR, open, high: Math.max(open, price) * (1 + rnd() * 0.004), low: Math.min(open, price) * (1 - rnd() * 0.004), close: price });
  }
  const h4 = [];
  for (let i = 0; i < h1.length; i += 4) {
    const g = h1.slice(i, i + 4);
    h4.push({ openTime: g[0].openTime, open: g[0].open, high: Math.max(...g.map(b => b.high)), low: Math.min(...g.map(b => b.low)), close: g[3].close });
  }

  const strategy = STRATEGIES.find(s => s.name === 'ema-cross-4h');
  const params = { fast: 3, slow: 10, atrMult: 1 };
  const sim = simulate({
    h1,
    strategy: strategy.build(createContext(h1, h4), params),
    costs: { feePct: 0, slippagePct: 0 },
    risk: { riskPct: 1, maxLeverage: 1e9, initialEquity: 10_000 },
  }).trades.filter(t => t.reason !== 'END');
  const live = [...evaluateEmaCrossTrend(h4, { params: { ...EMA_CROSS_DEFAULTS, ...params }, historyLimit: Infinity }).history].reverse();

  assert.ok(sim.length >= 30, `expected a meaningful sample, got ${sim.length}`);
  assert.ok(sim.some(t => t.reason === 'STOP') && sim.some(t => t.reason === 'SIGNAL'), 'sample must cover stops and reversals');
  assert.equal(live.length, sim.length);
  sim.forEach((t, k) => {
    assert.equal(live[k].direction, t.dir === 1 ? 'LONG' : 'SHORT');
    assert.equal(live[k].entryTime, t.entryTime);
    assert.equal(live[k].exitReason, t.reason === 'SIGNAL' ? 'REVERSE' : t.reason);
    assert.ok(Math.abs(live[k].exitPrice - t.exit) < 0.01);
  });
});
