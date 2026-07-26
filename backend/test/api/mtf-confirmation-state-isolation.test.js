const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter } = require('../../src/routes/routes');
const { MTFConfirmationEngine } = require('../../src/engine/mtfConfirmation');

const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = { get() { return undefined; } };
const candles = Array.from({ length: 20 }, (_, index) => ({
  openTime: index,
  timestamp: new Date(index).toISOString(),
  open: 100,
  high: 101,
  low: 99,
  close: 100,
}));

function createRoute(engine) {
  return createRouter({
    candleEngine: {
      getCandles: () => candles,
      getActive: () => null,
      getAllTimeframes: () => ['1m', '5m', '15m', '1h'],
    },
    confluenceEngine: {
      calculate: (_candles, timeframe) => ({
        score: timeframe === '1m' ? 30 : 70,
        bias: timeframe === '1m' ? 'Bearish' : 'Bullish',
        confidence: 70,
      }),
    },
    atrEngine: { calculate: () => ({ volatilityLevel: 'NORMAL' }) },
    mtfConfirmationEngine: engine,
    logger,
    config,
  });
}

function dispatch(router, query) {
  return new Promise((resolve, reject) => {
    const request = {
      method: 'GET',
      url: '/mtf-confirmation',
      originalUrl: '/mtf-confirmation',
      path: '/mtf-confirmation',
      query,
      body: {},
      headers: {},
      ip: '127.0.0.1',
    };
    const response = {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    router.handle(request, response, reject);
  });
}

test('API false -> true -> false requests remain isolated on one engine', async () => {
  const router = createRoute(new MTFConfirmationEngine({ logger, symbol: 'BTCUSDT', config }));

  const firstNormal = await dispatch(router, { direction: 'BUY', aggressive: 'false' });
  const aggressive = await dispatch(router, { direction: 'BUY', aggressive: 'true' });
  const finalNormal = await dispatch(router, { direction: 'BUY', aggressive: 'false' });

  assert.equal(firstNormal.statusCode, 200);
  assert.equal(aggressive.statusCode, 200);
  assert.equal(finalNormal.statusCode, 200);
  assert.equal(firstNormal.body.aggressive, false);
  assert.equal(firstNormal.body.mtfAllowed, false);
  assert.equal(aggressive.body.aggressive, true);
  assert.equal(aggressive.body.mtfAllowed, true);
  assert.equal(finalNormal.body.aggressive, false);
  assert.equal(finalNormal.body.mtfAllowed, false);
  assert.equal(finalNormal.body.alignmentScore, firstNormal.body.alignmentScore);
  assert.deepEqual(finalNormal.body.blockedBy, firstNormal.body.blockedBy);
  assert.equal(finalNormal.body.rejectionReason, firstNormal.body.rejectionReason);
  assert.equal(finalNormal.body.confidence, firstNormal.body.confidence);
});
