const BASE_TIMESTAMP = Date.UTC(2024, 0, 1, 0, 0, 0);
const CANDLE_INTERVAL_MS = 60 * 60 * 1000;

function cloneFixture(value) {
  return structuredClone(value);
}

function makeCandle(index, close, open = close - 1) {
  const high = Math.max(open, close) + 2;
  const low = Math.min(open, close) - 2;
  const openTime = BASE_TIMESTAMP + index * CANDLE_INTERVAL_MS;

  return {
    open,
    high,
    low,
    close,
    volume: 1000 + index * 10,
    openTime,
    timestamp: new Date(openTime).toISOString(),
  };
}

function makeCandles(closes) {
  return closes.map((close, index) => makeCandle(index, close));
}

function validCandles(count = 10) {
  return makeCandles(Array.from({ length: count }, (_, index) => 100 + index));
}

function bullishCandles(count = 10) {
  return makeCandles(Array.from({ length: count }, (_, index) => 100 + index * 2));
}

function bearishCandles(count = 10) {
  return makeCandles(Array.from({ length: count }, (_, index) => 200 - index * 2));
}

function rangingCandles(count = 10) {
  const closes = Array.from({ length: count }, (_, index) => 100 + (index % 2 === 0 ? 1 : -1));
  return makeCandles(closes);
}

function validMarketSnapshot() {
  return {
    symbol: 'BTCUSDT',
    exchange: 'TestExchange',
    price: 100,
    open: 99,
    high: 102,
    low: 98,
    volume: 1000,
    change24h: 1.25,
    timestamp: new Date(BASE_TIMESTAMP).toISOString(),
  };
}

function invalidMarketSnapshot() {
  return {
    symbol: 'BTCUSDT',
    price: null,
    timestamp: null,
  };
}

module.exports = {
  BASE_TIMESTAMP,
  cloneFixture,
  validCandles,
  bullishCandles,
  bearishCandles,
  rangingCandles,
  validMarketSnapshot,
  invalidMarketSnapshot,
};
