const test = require('node:test');
const assert = require('node:assert/strict');

const { computeRawAtr } = require('../../src/engine/atrCore');

function candle(high, low, close) {
  return { open: close, high, low, close, nested: { source: 'fixture' } };
}

function rangeCandles(ranges, close = 100) {
  return ranges.map(range => candle(close + range / 2, close - range / 2, close));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('computes true range without a gap', () => {
  const candles = [candle(11, 9, 10), candle(12, 10, 11), candle(13, 11, 12)];

  assert.deepEqual(computeRawAtr(candles, 2), {
    atr: 2,
    atrPercent: 16.666666666666664,
    previousAtr: 2,
  });
});

test('uses the bullish gap in true range', () => {
  const candles = [candle(11, 9, 10), candle(15, 14, 14), candle(16, 15, 15)];

  assert.deepEqual(computeRawAtr(candles, 2), {
    atr: 2.75,
    atrPercent: 18.333333333333332,
    previousAtr: 3.5,
  });
});

test('uses the bearish gap in true range', () => {
  const candles = [candle(11, 9, 10), candle(6, 5, 5), candle(5, 4, 4)];

  assert.deepEqual(computeRawAtr(candles, 2), {
    atr: 2.25,
    atrPercent: 56.25,
    previousAtr: 3.5,
  });
});

test('preserves the exact Wilder seed', () => {
  const result = computeRawAtr(rangeCandles([1, 2, 3]), 2);

  assert.equal(result.previousAtr, 1.5);
  assert.equal(result.atr, 2.25);
});

test('preserves the exact Wilder continuation order', () => {
  const result = computeRawAtr(rangeCandles([1, 2, 3, 4]), 3);

  assert.equal(result.previousAtr, 2);
  assert.equal(result.atr, 8 / 3);
});

test('supports custom periods', () => {
  const result = computeRawAtr(rangeCandles([2, 4, 6, 8, 10, 12]), 5);

  assert.equal(result.previousAtr, 6);
  assert.equal(result.atr, 7.2);
});

test('returns raw ATR and ATR percentage precision', () => {
  const result = computeRawAtr(rangeCandles([1, 2, 3, 4]), 3);
  const roundedAtr = Math.round(result.atr * 100) / 100;
  const roundedAtrPercent = Math.round(result.atrPercent * 100) / 100;

  assert.equal(result.atr, 8 / 3);
  assert.equal(result.atrPercent, (8 / 3) / 100 * 100);
  assert.notEqual(result.atr, roundedAtr);
  assert.notEqual(result.atrPercent, roundedAtrPercent);
});

test('returns the previous ATR from the prefix excluding the latest candle', () => {
  const result = computeRawAtr(rangeCandles([1, 2, 3]), 2);

  assert.equal(result.previousAtr, 1.5);
  assert.equal(result.atr, 2.25);
});

test('rejects insufficient history at the period plus one boundary', () => {
  assert.throws(
    () => computeRawAtr(rangeCandles([1, 2]), 2),
    { name: 'RangeError', message: 'Insufficient candle data (2/3)' },
  );
  assert.equal(computeRawAtr(rangeCandles([1, 2, 3]), 2).atr, 2.25);
});

test('rejects invalid periods deterministically', () => {
  for (const period of [0, -1, 0.5, NaN, Infinity, -Infinity, '5', null, undefined]) {
    assert.throws(
      () => computeRawAtr(rangeCandles([1, 2, 3]), period),
      { name: 'TypeError', message: 'ATR period must be a finite positive integer' },
      String(period),
    );
  }
});

test('rejects non-array input', () => {
  assert.throws(
    () => computeRawAtr(null, 2),
    { name: 'TypeError', message: 'ATR candles must be an array' },
  );
});

test('is deterministic across repeated calls', () => {
  const candles = rangeCandles([1, 2, 3, 4, 5]);

  assert.deepEqual(computeRawAtr(candles, 3), computeRawAtr(candles, 3));
});

test('does not mutate the candle array or nested candle objects', () => {
  const candles = rangeCandles([1, 2, 3, 4]);
  const before = clone(candles);

  computeRawAtr(candles, 3);

  assert.deepEqual(candles, before);
});

test('does not read wall-clock state', () => {
  const candles = rangeCandles([1, 2, 3, 4]);
  const originalNow = Date.now;
  try {
    Date.now = () => 1;
    const first = computeRawAtr(candles, 3);
    Date.now = () => 9999999999999;
    const second = computeRawAtr(candles, 3);
    assert.deepEqual(second, first);
  } finally {
    Date.now = originalNow;
  }
});

test('preserves prefix causality when future candles are appended', () => {
  const prefix = rangeCandles([1, 2, 3, 4]);
  const future = rangeCandles([20, 30]);
  const prefixResult = computeRawAtr(prefix, 3);

  assert.deepEqual(
    computeRawAtr(prefix, 3),
    computeRawAtr(prefix.concat(future).slice(0, prefix.length), 3),
  );
  assert.notEqual(computeRawAtr(prefix.concat(future), 3).atr, prefixResult.atr);
});

test('future suffix mutations cannot change a historical prefix result', () => {
  const prefix = rangeCandles([1, 2, 3, 4]);
  const firstFuture = rangeCandles([5, 6]);
  const secondFuture = rangeCandles([50, 60]);
  const firstHistory = prefix.concat(firstFuture);
  const secondHistory = prefix.concat(secondFuture);

  assert.deepEqual(
    computeRawAtr(firstHistory.slice(0, prefix.length), 3),
    computeRawAtr(secondHistory.slice(0, prefix.length), 3),
  );
});

test('uses the first candle high-low range without a previous close', () => {
  const candles = [candle(15, 5, 10), candle(11, 9, 10), candle(12, 8, 10)];

  assert.equal(computeRawAtr(candles, 2).previousAtr, 6);
});

test('preserves missing later previous-close arithmetic behavior', () => {
  const candles = [candle(11, 9, 10), { high: 12, low: 10 }, candle(13, 11, 12)];

  const result = computeRawAtr(candles, 2);
  assert.equal(Number.isNaN(result.atr), true);
  assert.equal(Number.isNaN(result.atrPercent), true);
  assert.equal(result.previousAtr, 2);
});

test('preserves zero latest-close ATR percentage behavior', () => {
  const candles = [candle(11, 9, 10), candle(2, 0, 0), candle(2, 0, 0)];

  assert.equal(computeRawAtr(candles, 2).atrPercent, 0);
});

test('preserves negative latest-close ATR percentage behavior', () => {
  const candles = [candle(11, 9, 10), candle(1, -1, -1), candle(1, -1, -1)];

  assert.equal(computeRawAtr(candles, 2).atrPercent, 0);
});

test('matches the legacy operation-order golden value', () => {
  const ranges = [...Array(14).fill(1), ...Array(16).fill(2)];
  const result = computeRawAtr(rangeCandles(ranges), 14);

  assert.equal(result.atr, 1.6944761865961422);
  assert.equal(result.previousAtr, 1.6709743547958453);
});
