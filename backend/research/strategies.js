'use strict';

// Candidate strategies. Each `build(ctx, params)` returns { signal(i), manage?(i, pos) }
// where i indexes ctx.h1 and only data up to the close of h1[i] may be used.
// Higher-timeframe values come from the last 4h bar CLOSED at that moment.
const ind = require('./indicators');

const HOUR = 3_600_000;
const H4 = 4 * HOUR;

function createContext(h1, h4) {
  // h4Idx[i]: index of the last 4h bar closed at the close of h1[i] (-1 if none).
  const h4Idx = new Int32Array(h1.length).fill(-1);
  const isH4Close = new Uint8Array(h1.length);
  let j = -1;
  for (let i = 0; i < h1.length; i++) {
    const closeTime = h1[i].openTime + HOUR;
    while (j + 1 < h4.length && h4[j + 1].openTime + H4 <= closeTime) j++;
    h4Idx[i] = j;
    isH4Close[i] = j >= 0 && h4[j].openTime + H4 === closeTime ? 1 : 0;
  }
  const memo = new Map();
  const cache = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };
  const closes = bars => bars.map(b => b.close);
  return { h1, h4, h4Idx, isH4Close, cache, closes };
}

const donchianTrend = {
  name: 'donchian-4h',
  summary: '4h channel breakout in the trend direction; ATR stop; exit on opposite shorter channel',
  defaults: { entryN: 20, exitN: 10, atrMult: 2, trendEma: 200 },
  grid: { entryN: [20, 55], exitN: [10, 20], atrMult: [2, 3], trendEma: [0, 200] },
  build(ctx, p) {
    const { h4, h4Idx, isH4Close, cache } = ctx;
    const highs = cache('h4.high', () => h4.map(b => b.high));
    const lows = cache('h4.low', () => h4.map(b => b.low));
    const upper = cache(`h4.ph${p.entryN}`, () => ind.priorHighest(highs, p.entryN));
    const lower = cache(`h4.pl${p.entryN}`, () => ind.priorLowest(lows, p.entryN));
    const exitUpper = cache(`h4.ph${p.exitN}`, () => ind.priorHighest(highs, p.exitN));
    const exitLower = cache(`h4.pl${p.exitN}`, () => ind.priorLowest(lows, p.exitN));
    const atr = cache('h4.atr20', () => ind.atr(h4, 20));
    const trend = p.trendEma ? cache(`h4.ema${p.trendEma}`, () => ind.ema(ctx.closes(h4), p.trendEma)) : null;
    return {
      signal(i) {
        if (!isH4Close[i]) return null;
        const j = h4Idx[i];
        const c = h4[j].close;
        if (!(atr[j] > 0) || Number.isNaN(upper[j])) return null;
        if (trend && Number.isNaN(trend[j])) return null;
        if (c > upper[j] && (!trend || c > trend[j])) return { dir: 1, stop: c - p.atrMult * atr[j] };
        if (c < lower[j] && (!trend || c < trend[j])) return { dir: -1, stop: c + p.atrMult * atr[j] };
        return null;
      },
      manage(i, pos) {
        if (!isH4Close[i]) return null;
        const j = h4Idx[i];
        const c = h4[j].close;
        return { exit: pos.dir === 1 ? c < exitLower[j] : c > exitUpper[j] };
      },
    };
  },
};

const emaCross = {
  name: 'ema-cross-4h',
  summary: '4h fast/slow EMA crossover, always in the market; ATR safety stop',
  defaults: { fast: 20, slow: 100, atrMult: 3 },
  grid: { fast: [20, 50], slow: [100, 200], atrMult: [2, 4] },
  build(ctx, p) {
    const { h4, h4Idx, isH4Close, cache } = ctx;
    const fast = cache(`h4.ema${p.fast}`, () => ind.ema(ctx.closes(h4), p.fast));
    const slow = cache(`h4.ema${p.slow}`, () => ind.ema(ctx.closes(h4), p.slow));
    const atr = cache('h4.atr20', () => ind.atr(h4, 20));
    const side = j => (fast[j] > slow[j] ? 1 : -1);
    return {
      signal(i) {
        if (!isH4Close[i]) return null;
        const j = h4Idx[i];
        if (j < 1 || Number.isNaN(slow[j - 1]) || !(atr[j] > 0)) return null;
        if (side(j) === side(j - 1)) return null;
        const c = h4[j].close;
        return { dir: side(j), stop: c - side(j) * p.atrMult * atr[j] };
      },
      manage(i, pos) {
        if (!isH4Close[i]) return null;
        return { exit: side(h4Idx[i]) !== pos.dir };
      },
    };
  },
};

const trendPullback = {
  name: 'pullback-1h',
  summary: '4h EMA50/200 trend; 1h RSI pullback recovers; ATR stop; fixed R target',
  defaults: { rsiLevel: 40, atrMult: 2, rr: 2 },
  grid: { rsiLevel: [35, 40, 45], atrMult: [1.5, 2.5], rr: [1.5, 2, 3] },
  build(ctx, p) {
    const { h1, h4, h4Idx, cache } = ctx;
    const e50 = cache('h4.ema50', () => ind.ema(ctx.closes(h4), 50));
    const e200 = cache('h4.ema200', () => ind.ema(ctx.closes(h4), 200));
    const rsi = cache('h1.rsi14', () => ind.rsi(ctx.closes(h1), 14));
    const atr = cache('h1.atr14', () => ind.atr(h1, 14));
    return {
      signal(i) {
        const j = h4Idx[i];
        if (j < 0 || i < 1 || Number.isNaN(e200[j]) || !(atr[i] > 0)) return null;
        const c = h1[i].close;
        const up = e50[j] > e200[j] && h4[j].close > e50[j];
        const down = e50[j] < e200[j] && h4[j].close < e50[j];
        const lo = p.rsiLevel;
        const hi = 100 - p.rsiLevel;
        const risk = p.atrMult * atr[i];
        if (up && rsi[i - 1] < lo && rsi[i] >= lo) return { dir: 1, stop: c - risk, target: c + p.rr * risk };
        if (down && rsi[i - 1] > hi && rsi[i] <= hi) return { dir: -1, stop: c + risk, target: c - p.rr * risk };
        return null;
      },
    };
  },
};

const rangeReversion = {
  name: 'range-revert-1h',
  summary: 'Fade 1h Bollinger extremes only while 4h ADX says no trend; target the mean',
  defaults: { adxMax: 20, atrMult: 2, rsiEdge: 30 },
  grid: { adxMax: [20, 25], atrMult: [1.5, 2.5], rsiEdge: [25, 30] },
  build(ctx, p) {
    const { h1, h4, h4Idx, cache } = ctx;
    const closes = cache('h1.close', () => ctx.closes(h1));
    const mid = cache('h1.sma20', () => ind.sma(closes, 20));
    const sd = cache('h1.sd20', () => ind.stdev(closes, 20));
    const rsi = cache('h1.rsi14', () => ind.rsi(closes, 14));
    const atr = cache('h1.atr14', () => ind.atr(h1, 14));
    const adx = cache('h4.adx14', () => ind.adx(h4, 14));
    const MAX_BARS = 48;
    return {
      signal(i) {
        const j = h4Idx[i];
        if (j < 0 || Number.isNaN(adx[j]) || adx[j] >= p.adxMax || Number.isNaN(sd[i]) || !(atr[i] > 0)) return null;
        const c = closes[i];
        if (c < mid[i] - 2 * sd[i] && rsi[i] < p.rsiEdge) return { dir: 1, stop: c - p.atrMult * atr[i], target: mid[i] };
        if (c > mid[i] + 2 * sd[i] && rsi[i] > 100 - p.rsiEdge) return { dir: -1, stop: c + p.atrMult * atr[i], target: mid[i] };
        return null;
      },
      manage(i, pos) {
        return { exit: i - pos.signalIndex >= MAX_BARS };
      },
    };
  },
};

const STRATEGIES = [donchianTrend, emaCross, trendPullback, rangeReversion];

function gridOf(strategy) {
  return Object.entries(strategy.grid).reduce(
    (combos, [key, values]) => combos.flatMap(c => values.map(v => ({ ...c, [key]: v }))),
    [{}],
  );
}

module.exports = { STRATEGIES, createContext, gridOf };
