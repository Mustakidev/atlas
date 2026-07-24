const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter } = require('../../src/routes/routes');
const { IndicatorRegistry } = require('../../src/engine/indicators/registry');
const { RSIIndicator } = require('../../src/engine/indicators/rsi');

function makeCandles(closeAt, count = 30) {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    const openTime = index * 3600000;
    return {
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1000,
      openTime,
      timestamp: new Date(openTime).toISOString(),
    };
  });
}

function dispatch(router, path, query) {
  return new Promise((resolve, reject) => {
    const request = {
      method: 'GET',
      url: path,
      originalUrl: path,
      path,
      query,
      body: {},
      headers: {},
      ip: '127.0.0.1',
    };
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      getHeader(name) { return this.headers[name]; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
      end(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    router.handle(request, response, reject);
  });
}

test('RSI route confidence is response-local and does not mutate the engine result', async () => {
  let candles = makeCandles(index => 100 + index);
  const registry = new IndicatorRegistry().register(new RSIIndicator('BTCUSDT'));
  const router = createRouter({
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: (_timeframe, limit) => candles.slice(-limit),
      getActive: () => null,
    },
    indicatorRegistry: registry,
    logger: { info() {}, warn() {}, error() {}, system() {} },
  });

  const first = await dispatch(router, '/indicators/rsi', { timeframe: '1h', limit: '30' });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(Object.keys(first.body), ['timeframe', 'candleCount', 'rsi']);
  assert.equal(first.body.rsi.confidence, 55);

  const directAfterRoute = registry.get('RSI').calculate(candles, '1h');
  assert.equal(directAfterRoute.confidence, 50);
  assert.equal(directAfterRoute.value, first.body.rsi.value);

  candles = makeCandles(index => 200 - index);
  const second = await dispatch(router, '/indicators/rsi', { timeframe: '1h', limit: '15' });
  const expected = new RSIIndicator('BTCUSDT').calculate(candles, '1h');

  assert.equal(second.statusCode, 200);
  assert.equal(second.body.candleCount, 15);
  assert.equal(second.body.rsi.value, expected.value);
  assert.equal(second.body.rsi.confidence, 50);
  assert.equal(registry.get('RSI').calculate(candles, '1h').confidence, 50);
});
