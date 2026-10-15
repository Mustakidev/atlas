'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulate, summarize } = require('../../research/engine');
const { createContext } = require('../../research/strategies');
const ind = require('../../research/indicators');
const { computeRawRsiFromCloses } = require('../../src/engine/rsiCore');
const { computeRawAtr } = require('../../src/engine/atrCore');

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);
const NO_COSTS = { feePct: 0, slippagePct: 0 };
const RISK = { riskPct: 2, maxLeverage: 100, initialEquity: 10_000 };

function bars(rows) {
  return rows.map(([open, high, low, close], i) => ({ openTime: T0 + i * HOUR, open, high, low, close, volume: 1 }));
}

function once(index, signal, manage) {
  return { signal: i => (i === index ? signal : null), manage };
}

test('entry fills at the open of the bar after the signal, never the signal bar', () => {
  const h1 = bars([[100, 101, 99, 100], [105, 106, 104, 105], [105, 106, 104, 105]]);
  const { trades } = simulate({ h1, strategy: once(0, { dir: 1, stop: 90 }), costs: NO_COSTS, risk: RISK });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entry, 105);
  assert.equal(trades[0].entryTime, T0 + HOUR);
});

test('stop exit risks exactly riskPct of equity before costs', () => {
  const h1 = bars([[100, 100, 100, 100], [100, 101, 99, 100], [100, 100, 89, 95], [95, 95, 95, 95]]);
  const { trades, curve } = simulate({ h1, strategy: once(0, { dir: 1, stop: 90 }), costs: NO_COSTS, risk: RISK });
  assert.equal(trades[0].reason, 'STOP');
  assert.equal(trades[0].exit, 90);
  assert.equal(trades[0].qty, 20); // $200 risk / $10 stop distance
  assert.ok(Math.abs(trades[0].net + 200) < 1e-9);
  assert.ok(Math.abs(trades[0].r + 1) < 1e-9);
  assert.ok(Math.abs(curve.at(-1).equity - 9800) < 1e-9);
});

test('a bar touching both stop and target is resolved as the stop', () => {
  const h1 = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 125, 85, 100], [100, 100, 100, 100]]);
  const { trades } = simulate({ h1, strategy: once(0, { dir: 1, stop: 90, target: 120 }), costs: NO_COSTS, risk: RISK });
  assert.equal(trades[0].reason, 'STOP');
});

test('short target exits at the target price without slippage', () => {
  const h1 = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 101, 79, 80], [80, 80, 80, 80]]);
  const costs = { feePct: 0, slippagePct: 0.1 };
  const { trades } = simulate({ h1, strategy: once(0, { dir: -1, stop: 110, target: 80 }), costs, risk: RISK });
  assert.equal(trades[0].reason, 'TARGET');
  assert.equal(trades[0].exit, 80);
  assert.ok(Math.abs(trades[0].entry - 99.9) < 1e-9); // short entry slips down
});

test('a gap through the stop fills at the open, not the stop', () => {
  const h1 = bars([[100, 100, 100, 100], [100, 101, 99, 100], [80, 82, 78, 81], [81, 81, 81, 81]]);
  const { trades } = simulate({ h1, strategy: once(0, { dir: 1, stop: 90 }), costs: NO_COSTS, risk: RISK });
  assert.equal(trades[0].exit, 80);
  assert.ok(trades[0].r < -1);
});

test('fees are charged on both fills and position notional is capped by leverage', () => {
  const h1 = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
  const risk = { riskPct: 2, maxLeverage: 1, initialEquity: 10_000 };
  const strategy = once(0, { dir: 1, stop: 99 }, () => ({ exit: true }));
  const { trades } = simulate({ h1, strategy, costs: { feePct: 0.1, slippagePct: 0 }, risk });
  assert.equal(trades[0].qty, 100); // uncapped would be 200 units = 2x equity
  assert.ok(Math.abs(trades[0].fees - 20) < 1e-9);
  assert.ok(Math.abs(trades[0].net + 20) < 1e-9);
});

test('funding: longs pay a positive rate, shorts receive it', () => {
  const h1 = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
  const funding = [{ time: T0 + 2 * HOUR, rate: 0.001 }];
  const run = dir => simulate({ h1, funding, strategy: once(0, { dir, stop: 100 - dir * 10 }), costs: NO_COSTS, risk: RISK }).trades[0];
  assert.ok(Math.abs(run(1).funding - 2) < 1e-9); // 20 units * $100 * 0.1%
  assert.ok(Math.abs(run(-1).funding + 2) < 1e-9);
});

test('stops only tighten; a looser stop from manage() is ignored', () => {
  const h1 = bars([[100, 100, 100, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 94, 95], [95, 95, 95, 95]]);
  let call = 0;
  const strategy = once(0, { dir: 1, stop: 90 }, () => (++call === 1 ? { stop: 95 } : { stop: 80 }));
  const { trades } = simulate({ h1, strategy, costs: NO_COSTS, risk: RISK });
  assert.equal(trades[0].exit, 95);
});

test('summarize reports win rate, profit factor and drawdown', () => {
  const s = summarize({
    initialEquity: 100,
    trades: [{ net: 30, r: 1.5, dir: 1, bars: 2, fees: 0, funding: 0 }, { net: -10, r: -0.5, dir: -1, bars: 1, fees: 0, funding: 0 }],
    curve: [{ time: T0 + HOUR, equity: 100, close: 1 }, { time: T0 + 2 * HOUR, equity: 80, close: 1 }, { time: T0 + 3 * HOUR, equity: 120, close: 2 }],
  });
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 3);
  assert.equal(s.maxDrawdownPct, 20);
  assert.equal(s.totalReturnPct, 20);
  assert.equal(s.buyHoldPct, 100);
});

test('createContext maps each 1h bar to the last CLOSED 4h bar only', () => {
  const h1 = Array.from({ length: 9 }, (_, i) => ({ openTime: T0 + i * HOUR, open: 1, high: 1, low: 1, close: 1 }));
  const h4 = [0, 1, 2].map(k => ({ openTime: T0 + k * 4 * HOUR, open: 1, high: 1, low: 1, close: 1 }));
  const ctx = createContext(h1, h4);
  assert.deepEqual([...ctx.h4Idx], [-1, -1, -1, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual([...ctx.isH4Close], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('indicators agree with the production RSI and ATR cores', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.1);
  const candles = closes.map((c, i) => ({ open: c, high: c + 1 + (i % 3), low: c - 1 - (i % 2), close: c }));
  assert.ok(Math.abs(ind.rsi(closes, 14).at(-1) - computeRawRsiFromCloses(closes, 14)) < 1e-9);
  // Seeding differs (production includes bar 0's range); the gap decays to noise.
  const prodAtr = computeRawAtr(candles, 14).atr;
  assert.ok(Math.abs(ind.atr(candles, 14).at(-1) - prodAtr) / prodAtr < 1e-4);
});

test('priorHighest and priorLowest exclude the current bar', () => {
  const v = [1, 5, 3, 9, 2];
  assert.deepEqual(ind.priorHighest(v, 2).slice(2), [5, 5, 9]);
  assert.deepEqual(ind.priorLowest(v, 2).slice(2), [1, 3, 3]);
});
