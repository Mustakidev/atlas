const test = require('node:test');
const assert = require('node:assert/strict');

const { EventBus } = require('../../src/core/eventBus');
const { CacheEngine } = require('../../src/engine/cache');
const { CandleEngine } = require('../../src/engine/candles');
const { getFinalizedCandles } = require('../../src/engine/candleUtils');
const { HistoryEngine } = require('../../src/engine/history');
const { RetryHandler } = require('../../src/network/retry');

const BASE_TIME = Date.UTC(2024, 0, 1, 0, 0, 0);

function config(values = {}) {
  return { get(key) { return values[key]; } };
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function snapshot(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    price: 100,
    volume: 10,
    timestamp: new Date(BASE_TIME).toISOString(),
    ...overrides,
  };
}

function withNow(value, fn) {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function withRandom(value, fn) {
  const originalRandom = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
}

async function withRandomAsync(value, fn) {
  const originalRandom = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = originalRandom;
  }
}

test('HistoryEngine stores snapshots, returns bounded views, and clears state', () => {
  const history = new HistoryEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');
  const first = snapshot({ price: 100 });
  const second = snapshot({ price: 101 });
  const third = snapshot({ price: 102 });

  history.add(first);
  history.add(second);
  history.add(third);

  assert.equal(history.size(), 2);
  assert.equal(history.latest().price, 102);
  assert.deepEqual(history.last(0), []);
  assert.deepEqual(history.last(-1), []);
  assert.deepEqual(history.last(100).map(item => item.price), [101, 102]);
  assert.deepEqual(history.all().map(item => item.price), [101, 102]);
  assert.notEqual(history.all(), history.all());
  assert.ok(Object.isFrozen(history.latest()));

  history.clear();
  assert.equal(history.size(), 0);
  assert.equal(history.latest(), null);
  assert.deepEqual(history.all(), []);
});

test('HistoryEngine isolates stored snapshots from later input mutation', () => {
  const history = new HistoryEngine(config({ MAX_HISTORY: 3 }), logger());
  const input = snapshot({ price: 100 });

  history.add(input);
  input.price = 999;

  assert.equal(history.latest().price, 100);
});

test('CacheEngine stores, reports age, returns cached data, and clears state', () => {
  const cache = new CacheEngine(config({ CACHE_TTL: 1000 }), logger(), 'BTCUSDT');

  assert.equal(cache.has(), false);
  assert.equal(cache.get(), null);
  assert.equal(cache.getAge(), null);

  withNow(BASE_TIME, () => cache.store(snapshot()));
  assert.equal(cache.has(), true);
  assert.deepEqual(withNow(BASE_TIME + 100, () => cache.get()), {
    ...snapshot(),
    cached: true,
  });
  assert.equal(withNow(BASE_TIME + 100, () => cache.getAge()), 100);

  cache.clear();
  assert.equal(cache.has(), false);
  assert.equal(cache.get(), null);
  assert.equal(cache.getAge(), null);
});

test('CacheEngine returns stale data after TTL without losing the snapshot', () => {
  const warnings = [];
  const cache = new CacheEngine(config({ CACHE_TTL: 1000 }), {
    info() {},
    warn(module, message, data) { warnings.push({ module, message, data }); },
  });

  withNow(BASE_TIME, () => cache.store(snapshot({ price: 105 })));
  const stale = withNow(BASE_TIME + 1001, () => cache.get());

  assert.equal(stale.price, 105);
  assert.equal(stale.cached, true);
  assert.equal(cache.has(), true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].module, 'CacheEngine');
});

test('CacheEngine replaces duplicate stores and isolates input mutation', () => {
  const cache = new CacheEngine(config({ CACHE_TTL: 1000 }), logger());
  const first = snapshot({ price: 100 });
  const second = snapshot({ price: 200 });

  withNow(BASE_TIME, () => cache.store(first));
  withNow(BASE_TIME + 1, () => cache.store(second));
  second.price = 999;

  assert.equal(cache.get().price, 200);
  assert.equal(withNow(BASE_TIME + 1, () => cache.getAge()), 0);
});

test('EventBus delivers events, supports duplicate listeners, and removes listeners', () => {
  const bus = new EventBus();
  const received = [];
  const listener = data => received.push(data);

  bus.on('market', listener);
  bus.on('market', listener);
  bus.emit('market', { price: 100 });
  assert.equal(received.length, 2);

  bus.off('market', listener);
  bus.emit('market', { price: 101 });
  assert.equal(received.length, 2);

  bus.off('missing', listener);
  bus.emit('missing', { price: 102 });
  assert.equal(received.length, 2);
});

test('EventBus isolates listener failures and continues delivery', () => {
  const bus = new EventBus();
  const received = [];
  const originalError = console.error;
  console.error = () => {};

  try {
    bus.on('market', () => { throw new Error('listener failure'); });
    bus.on('market', data => received.push(data.price));
    bus.emit('market', { price: 123 });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(received, [123]);
});

test('CandleEngine aggregates active candles and exposes timeframe boundaries', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');
  const firstTime = BASE_TIME + 5 * 60 * 1000;

  candles.ingest(snapshot({ timestamp: new Date(firstTime).toISOString(), price: 100, volume: 10 }));
  candles.ingest(snapshot({ timestamp: new Date(firstTime + 30 * 1000).toISOString(), price: 105, volume: 4 }));

  const active = candles.getActive('1m');
  assert.equal(active.open, 100);
  assert.equal(active.high, 105);
  assert.equal(active.low, 100);
  assert.equal(active.close, 105);
  assert.equal(active.volume, 14);
  assert.equal(candles.getTotalCandles(), 8);
  assert.equal(candles.getAllTimeframes().length, 8);
});

test('CandleEngine finalizes candles, freezes them, and enforces retention limits', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 1 }), logger(), 'BTCUSDT');
  const firstTime = BASE_TIME;
  const nextMinute = BASE_TIME + 60 * 1000;

  candles.ingest(snapshot({ timestamp: new Date(firstTime).toISOString(), price: 100 }));
  candles.ingest(snapshot({ timestamp: new Date(nextMinute).toISOString(), price: 110 }));

  const finalized = candles.getCandles('1m');
  assert.equal(finalized.length, 2);
  assert.equal(finalized[0].close, 100);
  assert.ok(Object.isFrozen(finalized[0]));

  candles.ingest(snapshot({ timestamp: new Date(nextMinute + 60 * 1000).toISOString(), price: 120 }));
  assert.deepEqual(candles.getCandles('1m').map(candle => candle.close), [110, 120]);
  assert.equal(candles.getCandles('unknown').length, 0);
  assert.equal(candles.getActive('unknown'), null);
});

test('getFinalizedCandles excludes the active candle and handles empty or unrelated data', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 2 }), logger());
  candles.ingest(snapshot({ timestamp: new Date(BASE_TIME).toISOString(), price: 100 }));

  assert.deepEqual(getFinalizedCandles(candles, '1h'), []);
  assert.deepEqual(getFinalizedCandles({
    getCandles: () => [{ openTime: 1, close: 10 }],
    getActive: () => ({ openTime: 2 }),
  }, '1h'), [{ openTime: 1, close: 10 }]);
  assert.deepEqual(getFinalizedCandles({
    getCandles: () => [{ openTime: 1 }, { openTime: 2 }],
    getActive: () => ({ openTime: 2 }),
  }, '1h'), [{ openTime: 1 }]);
});

test('RetryHandler returns immediately on success without waiting', async () => {
  const retry = new RetryHandler(config({ MAX_RETRIES: 2, INITIAL_BACKOFF: 100 }), logger());
  const waits = [];
  retry.sleep = async delay => waits.push(delay);

  const result = await retry.execute(() => 'ok');

  assert.equal(result, 'ok');
  assert.deepEqual(waits, []);
});

test('RetryHandler retries transient failures with mocked waits', async () => {
  const retry = new RetryHandler(config({ MAX_RETRIES: 2, INITIAL_BACKOFF: 100 }), logger());
  const waits = [];
  let attempts = 0;
  retry.sleep = async delay => waits.push(delay);

  const result = await withRandomAsync(0, () => retry.execute(() => {
    attempts++;
    if (attempts < 2) throw new Error('temporary');
    return 'recovered';
  }));

  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [100]);
});

test('RetryHandler stops at the retry boundary and rethrows the final error', async () => {
  const errors = [];
  const retry = new RetryHandler(config({ MAX_RETRIES: 2, INITIAL_BACKOFF: 100 }), {
    info() {},
    warn() {},
    error(module, message, data) { errors.push({ module, message, data }); },
  });
  const waits = [];
  let attempts = 0;
  retry.sleep = async delay => waits.push(delay);

  await assert.rejects(
    withRandomAsync(0, () => retry.execute(() => {
      attempts++;
      throw new Error('permanent');
    })),
    { message: 'permanent' },
  );

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [100, 200]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].data.attempts, 3);
});

test('RetryHandler calculates deterministic rate-limit delays and honors retry-after', () => {
  const retry = new RetryHandler(config({ MAX_RETRIES: 0, INITIAL_BACKOFF: 100 }), logger());
  const rateLimited = { status: 429, headers: { 'retry-after': '3' } };
  const rateLimitedWithoutHeader = { status: 429, headers: {} };

  withRandom(0, () => {
    assert.equal(retry.calculateDelay(1, rateLimited), 3000);
    assert.equal(retry.calculateDelay(1, rateLimitedWithoutHeader), 400);
    assert.equal(retry.calculateDelay(2, new Error('ordinary')), 400);
  });
});
