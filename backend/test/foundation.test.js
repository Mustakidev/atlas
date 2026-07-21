const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASE_TIMESTAMP,
  bullishCandles,
  cloneFixture,
  invalidMarketSnapshot,
  validCandles,
  validMarketSnapshot,
} = require('./fixtures/market');
const { fresh } = require('./helpers/fixtures');

test('fixtures are deterministic and use fixed timestamps', () => {
  assert.deepEqual(validCandles(3), validCandles(3));
  assert.deepEqual(validMarketSnapshot(), validMarketSnapshot());
  assert.equal(validCandles(1)[0].openTime, BASE_TIMESTAMP);
  assert.equal(validMarketSnapshot().timestamp, new Date(BASE_TIMESTAMP).toISOString());
});

test('fixture calls return independent deep-cloned objects', () => {
  const first = fresh(bullishCandles, 3);
  const second = fresh(bullishCandles, 3);

  first[0].close = 9999;
  first.push({ close: 10000 });

  assert.notEqual(first[0].close, second[0].close);
  assert.equal(second.length, 3);
});

test('cloneFixture deep-clones nested fixture data', () => {
  const original = { snapshot: validMarketSnapshot(), candles: validCandles(2) };
  const copy = cloneFixture(original);

  copy.snapshot.price = 9999;
  copy.candles[0].close = 9999;

  assert.equal(original.snapshot.price, 100);
  assert.equal(original.candles[0].close, 100);
});

test('required valid and invalid fixture shapes are available', () => {
  const candles = validCandles(2);
  const snapshot = validMarketSnapshot();
  const invalid = invalidMarketSnapshot();

  assert.equal(candles.length, 2);
  assert.ok(candles.every(candle => candle.openTime && candle.timestamp));
  assert.equal(snapshot.symbol, 'BTCUSDT');
  assert.equal(invalid.price, null);
  assert.equal(invalid.timestamp, null);
});
