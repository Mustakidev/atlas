const test = require('node:test');
const assert = require('node:assert/strict');

const { RSIIndicator } = require('../../src/engine/indicators/rsi');
const { EMAIndicator } = require('../../src/engine/indicators/ema');
const { ATREngine, MIN_CANDLES: ATR_MIN_CANDLES } = require('../../src/engine/atr');
const { MACDEngine, MIN_CANDLES: MACD_MIN_CANDLES } = require('../../src/engine/macd');
const { BollingerEngine, MIN_CANDLES: BOLLINGER_MIN_CANDLES } = require('../../src/engine/bollinger');
const {
  bearishCandles,
  bullishCandles,
  validCandles,
} = require('../fixtures/market');
const { fresh } = require('../helpers/fixtures');

function logger() {
  return { info() {}, warn() {}, error() {}, system() {} };
}

function candleEngine(candles) {
  return {
    getCandles() { return fresh(() => candles); },
    getActive() { return null; },
    getAllTimeframes() { return ['1h']; },
  };
}

test('RSI returns valid bullish and bearish values', () => {
  const rsi = new RSIIndicator('BTCUSDT');
  const bullish = rsi.calculate(fresh(bullishCandles, 40), 'bullish');
  const bearish = rsi.calculate(fresh(bearishCandles, 40), 'bearish');

  assert.equal(bullish.ready, true, 'bullish RSI should be ready');
  assert.equal(bearish.ready, true, 'bearish RSI should be ready');
  assert.ok(Number.isFinite(bullish.value), 'bullish RSI must be finite');
  assert.ok(Number.isFinite(bearish.value), 'bearish RSI must be finite');
  assert.ok(bullish.value > bearish.value, 'bullish RSI should exceed bearish RSI');
});

test('RSI preserves its insufficient-data contract', () => {
  const result = new RSIIndicator('BTCUSDT').calculate(fresh(validCandles, 10), 'short');

  assert.equal(result.ready, false);
  assert.equal(result.value, null);
  assert.equal(result.implemented, true);
  assert.match(result.reason, /Insufficient candle history/);
});

test('EMA calculates supported periods and bullish ordering', () => {
  const ema = new EMAIndicator('BTCUSDT');
  const candles = fresh(bullishCandles, 250);
  const results = ema.calculateAll(candles, '1h');

  for (const period of ema.getPeriods()) {
    assert.equal(results[period].ready, true, `EMA-${period} should be ready`);
    assert.ok(Number.isFinite(results[period].value), `EMA-${period} must be finite`);
  }
  assert.ok(results[9].value > results[20].value, 'fast EMA should lead slow EMA on rising data');
});

test('EMA preserves its insufficient-data contract', () => {
  const result = new EMAIndicator('BTCUSDT').calculate(fresh(validCandles, 10), '1h', 20);

  assert.equal(result.ready, false);
  assert.equal(result.value, null);
  assert.match(result.reason, /Insufficient candle data/);
});

test('ATR returns a finite positive value and not-ready shape', () => {
  const candles = fresh(validCandles, 40);
  const atr = new ATREngine({ candleEngine: candleEngine(candles), logger: logger(), symbol: 'BTCUSDT' });
  const result = atr.calculate('1h', 40);
  const notReady = new ATREngine({ candleEngine: candleEngine(fresh(validCandles, 5)), logger: logger(), symbol: 'BTCUSDT' })
    .calculate('1h', 5);

  assert.equal(result.ready, true);
  assert.ok(Number.isFinite(result.atr) && result.atr > 0, 'ATR must be finite and positive');
  assert.equal(notReady.ready, false);
  assert.equal(notReady.atr, null);
  assert.match(notReady.reason, new RegExp(`${ATR_MIN_CANDLES}`));
});

test('MACD returns finite lines and preserves insufficient-data shape', () => {
  const macd = new MACDEngine({ candleEngine: candleEngine(fresh(bullishCandles, 60)), logger: logger(), symbol: 'BTCUSDT' });
  const result = macd.calculate('1h', 60);
  const notReady = new MACDEngine({ candleEngine: candleEngine(fresh(validCandles, 10)), logger: logger(), symbol: 'BTCUSDT' })
    .calculate('1h', 10);

  assert.equal(result.ready, true);
  assert.ok(Number.isFinite(result.macd));
  assert.ok(Number.isFinite(result.signal));
  assert.ok(Number.isFinite(result.histogram));
  assert.equal(notReady.ready, false);
  assert.equal(notReady.macd, null);
  assert.equal(notReady.signal, null);
  assert.equal(notReady.histogram, null);
  assert.match(notReady.reason, new RegExp(`${MACD_MIN_CANDLES}`));
});

test('Bollinger bands are ordered and insufficient data is explicit', () => {
  const bollinger = new BollingerEngine({ candleEngine: candleEngine(fresh(validCandles, 60)), logger: logger(), symbol: 'BTCUSDT' });
  const result = bollinger.calculate('1h', 60);
  const notReady = new BollingerEngine({ candleEngine: candleEngine(fresh(validCandles, 5)), logger: logger(), symbol: 'BTCUSDT' })
    .calculate('1h', 5);

  assert.equal(result.ready, true);
  assert.ok(result.upperBand >= result.middleBand);
  assert.ok(result.middleBand >= result.lowerBand);
  assert.ok(Number.isFinite(result.bandwidth));
  assert.ok(Number.isFinite(result.lastClose));
  assert.equal(notReady.ready, false);
  assert.equal(notReady.upperBand, null);
  assert.equal(notReady.middleBand, null);
  assert.equal(notReady.lowerBand, null);
  assert.match(notReady.reason, new RegExp(`${BOLLINGER_MIN_CANDLES}`));
});
