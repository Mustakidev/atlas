'use strict';

// Whole-series indicators. Output arrays match input length; values are NaN
// until enough history exists. Value at index i uses data up to and including i.

function sma(values, n) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(values, n) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function wilder(values, n, startIndex) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < startIndex + n) return out;
  let avg = 0;
  for (let i = startIndex; i < startIndex + n; i++) avg += values[i];
  avg /= n;
  out[startIndex + n - 1] = avg;
  for (let i = startIndex + n; i < values.length; i++) {
    avg = (avg * (n - 1) + values[i]) / n;
    out[i] = avg;
  }
  return out;
}

function trueRange(bars) {
  return bars.map((b, i) => (i === 0
    ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
}

function atr(bars, n) {
  return wilder(trueRange(bars), n, 1);
}

function rsi(closes, n) {
  const gains = closes.map((c, i) => (i === 0 ? 0 : Math.max(c - closes[i - 1], 0)));
  const losses = closes.map((c, i) => (i === 0 ? 0 : Math.max(closes[i - 1] - c, 0)));
  const g = wilder(gains, n, 1);
  const l = wilder(losses, n, 1);
  return closes.map((_, i) => {
    if (Number.isNaN(g[i])) return NaN;
    if (l[i] === 0) return g[i] === 0 ? 50 : 100;
    return 100 - 100 / (1 + g[i] / l[i]);
  });
}

function adx(bars, n) {
  const plusDm = bars.map((b, i) => {
    if (i === 0) return 0;
    const up = b.high - bars[i - 1].high;
    const down = bars[i - 1].low - b.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = bars.map((b, i) => {
    if (i === 0) return 0;
    const up = b.high - bars[i - 1].high;
    const down = bars[i - 1].low - b.low;
    return down > up && down > 0 ? down : 0;
  });
  const tr = wilder(trueRange(bars), n, 1);
  const pdm = wilder(plusDm, n, 1);
  const mdm = wilder(minusDm, n, 1);
  const dx = bars.map((_, i) => {
    if (Number.isNaN(tr[i]) || tr[i] === 0) return NaN;
    const pdi = (100 * pdm[i]) / tr[i];
    const mdi = (100 * mdm[i]) / tr[i];
    return pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  });
  const firstDx = dx.findIndex(v => !Number.isNaN(v));
  return firstDx < 0 ? dx.map(() => NaN) : wilder(dx.map(v => (Number.isNaN(v) ? 0 : v)), n, firstDx);
}

// Highest high / lowest low of the n bars BEFORE i (excludes bar i itself).
function priorHighest(values, n) {
  return values.map((_, i) => (i < n ? NaN : Math.max(...values.slice(i - n, i))));
}

function priorLowest(values, n) {
  return values.map((_, i) => (i < n ? NaN : Math.min(...values.slice(i - n, i))));
}

function stdev(values, n) {
  const mean = sma(values, n);
  return values.map((_, i) => {
    if (Number.isNaN(mean[i])) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - mean[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

module.exports = { sma, ema, atr, rsi, adx, priorHighest, priorLowest, stdev, trueRange };
