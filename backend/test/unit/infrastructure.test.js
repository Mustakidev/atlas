const test = require('node:test');
const assert = require('node:assert/strict');

const { EventBus } = require('../../src/core/eventBus');
const { CacheEngine } = require('../../src/engine/cache');
const { CandleEngine } = require('../../src/engine/candles');
const { getFinalizedCandles } = require('../../src/engine/candleUtils');
const { HistoryEngine } = require('../../src/engine/history');
const { RetryHandler } = require('../../src/network/retry');

const BASE_TIME = Date.UTC(2024, 0, 1, 0, 0, 0);
const HOUR = 3600000;

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

test('CacheEngine metadata observes age without refreshing the snapshot timestamp', () => {
  const cache = new CacheEngine(config({ CACHE_TTL: 1000 }), logger(), 'BTCUSDT');
  const stored = snapshot({ timestamp: new Date(BASE_TIME).toISOString() });

  withNow(BASE_TIME, () => cache.store(stored));
  const observed = withNow(BASE_TIME + 1001, () => cache.getWithMetadata());

  assert.equal(observed.cacheAgeMs, 1001);
  assert.equal(observed.expired, true);
  assert.equal(observed.snapshot.timestamp, stored.timestamp);
  assert.equal(cache.get().timestamp, stored.timestamp);
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

test('EventBus invokes zero-payload listeners without synthesizing an argument', () => {
  const bus = new EventBus();
  let received;

  bus.on('event', (...args) => { received = args; });
  bus.emit('event');

  assert.deepEqual(received, []);
});

test('EventBus preserves one-payload compatibility and identity', () => {
  const bus = new EventBus();
  const payload = {};
  let received;

  bus.on('event', (...args) => { received = args; });
  bus.emit('event', payload);

  assert.equal(received.length, 1);
  assert.strictEqual(received[0], payload);
});

test('EventBus forwards multiple payloads in order without transforming them', () => {
  const bus = new EventBus();
  const first = {};
  const second = {};
  const third = 123;
  let received;

  bus.on('event', (...args) => { received = args; });
  bus.emit('event', first, second, third);

  assert.equal(received.length, 3);
  assert.strictEqual(received[0], first);
  assert.strictEqual(received[1], second);
  assert.strictEqual(received[2], third);
});

test('EventBus preserves listener order and gives every listener the same arguments', () => {
  const bus = new EventBus();
  const first = {};
  const second = {};
  const calls = [];

  bus.on('event', (...args) => { calls.push(['A', args]); });
  bus.on('event', (...args) => { calls.push(['B', args]); });
  bus.on('event', (...args) => { calls.push(['C', args]); });
  bus.emit('event', first, second);

  assert.deepEqual(calls.map(([name]) => name), ['A', 'B', 'C']);
  for (const [, args] of calls) {
    assert.equal(args.length, 2);
    assert.strictEqual(args[0], first);
    assert.strictEqual(args[1], second);
  }
});

test('EventBus isolates listener failures and continues delivery', () => {
  const bus = new EventBus();
  const calls = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };

  try {
    bus.on('market', () => { calls.push('first'); });
    bus.on('market', () => {
      throw new Error('listener failure');
    });
    bus.on('market', () => { calls.push('third'); });

    assert.doesNotThrow(() => bus.emit('market', { price: 123 }));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(calls, ['first', 'third']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'EventBus: listener error on "market":');
  assert.equal(errors[0][1], 'listener failure');
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

test('CandleEngine ingest returns frozen null transition metadata on first ingest', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');

  const transition = candles.ingest(snapshot());

  assert.ok(Object.isFrozen(transition));
  assert.ok(Object.isFrozen(transition.finalized));
  assert.deepEqual(Object.keys(transition.finalized), candles.getAllTimeframes());
  for (const tf of candles.getAllTimeframes()) {
    assert.equal(transition.finalized[tf], null);
  }
  assert.deepEqual(getFinalizedCandles(candles, '1h'), []);
  assert.ok(!Object.values(transition.finalized).some(Array.isArray));
  assert.throws(() => Object.defineProperty(transition, 'extra', { value: true }), TypeError);
  assert.throws(() => Object.defineProperty(transition.finalized, 'extra', { value: true }), TypeError);
});

test('CandleEngine same-bucket ingest preserves state and reports no finalization', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');

  candles.ingest(snapshot({ price: 100, volume: 10 }));
  const transition = candles.ingest(snapshot({
    price: 105,
    volume: 4,
    timestamp: new Date(BASE_TIME + 30 * 1000).toISOString(),
  }));

  for (const tf of candles.getAllTimeframes()) {
    assert.equal(transition.finalized[tf], null);
  }
  assert.deepEqual(candles.getActive('1m'), {
    open: 100,
    high: 105,
    low: 100,
    close: 105,
    volume: 14,
    openTime: BASE_TIME,
    timestamp: new Date(BASE_TIME).toISOString(),
  });
  assert.deepEqual(getFinalizedCandles(candles, '1h'), []);
});

test('CandleEngine exact boundary returns the stored frozen finalized candle', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');

  candles.ingest(snapshot({ price: 100, volume: 10 }));
  const previousActive = candles.getActive('1h');
  const transition = candles.ingest(snapshot({
    price: 110,
    volume: 4,
    timestamp: new Date(BASE_TIME + HOUR).toISOString(),
  }));
  const finalizedHistory = candles.getCandles('1h');
  const active = candles.getActive('1h');

  assert.strictEqual(transition.finalized['1h'], previousActive);
  assert.strictEqual(transition.finalized['1h'], finalizedHistory[0]);
  assert.ok(Object.isFrozen(transition.finalized['1h']));
  assert.notStrictEqual(active, transition.finalized['1h']);
  assert.equal(active.openTime, BASE_TIME + HOUR);
  assert.deepEqual(getFinalizedCandles(candles, '1h'), [previousActive]);
  assert.throws(() => Object.defineProperty(transition.finalized['1h'], 'close', { value: 999 }), TypeError);
  assert.equal(transition.finalized['1h'].close, 100);
});

test('CandleEngine skipped buckets finalize only the actual prior active candle', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 5 }), logger(), 'BTCUSDT');

  candles.ingest(snapshot({ price: 100, timestamp: new Date(BASE_TIME + 10 * HOUR).toISOString() }));
  const previousActive = candles.getActive('1h');
  const transition = candles.ingest(snapshot({
    price: 130,
    timestamp: new Date(BASE_TIME + 13 * HOUR + 5 * 60 * 1000).toISOString(),
  }));
  const finalized = getFinalizedCandles(candles, '1h');

  assert.strictEqual(transition.finalized['1h'], previousActive);
  assert.deepEqual(finalized, [previousActive]);
  assert.equal(candles.getActive('1h').openTime, BASE_TIME + 13 * HOUR);
  assert.deepEqual(finalized.map(candle => candle.openTime), [BASE_TIME + 10 * HOUR]);
});

test('CandleEngine reports independent transitions for all finalized timeframes', () => {
  const candles = new CandleEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');
  const finalizedTimeframes = ['1m', '5m', '15m', '30m', '1h'];
  const nonFinalizedTimeframes = ['4h', '12h', '24h'];

  candles.ingest(snapshot());
  const transition = candles.ingest(snapshot({
    price: 110,
    timestamp: new Date(BASE_TIME + HOUR).toISOString(),
  }));

  for (const tf of finalizedTimeframes) {
    assert.ok(transition.finalized[tf]);
    assert.ok(Object.isFrozen(transition.finalized[tf]));
  }
  for (const tf of nonFinalizedTimeframes) {
    assert.equal(transition.finalized[tf], null);
  }
  assert.deepEqual(Object.keys(transition.finalized), candles.getAllTimeframes());
});

test('CandleEngine state is unchanged when callers ignore ingest transition metadata', () => {
  const withReturn = new CandleEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');
  const withoutReturn = new CandleEngine(config({ MAX_HISTORY: 2 }), logger(), 'BTCUSDT');
  const snapshots = [
    snapshot(),
    snapshot({ price: 105, volume: 4, timestamp: new Date(BASE_TIME + 30 * 1000).toISOString() }),
    snapshot({ price: 110, volume: 2, timestamp: new Date(BASE_TIME + HOUR).toISOString() }),
  ];

  for (const current of snapshots) {
    withReturn.ingest(current);
    withoutReturn.ingest(current);
  }

  assert.deepEqual(withReturn.getCandles('1h'), withoutReturn.getCandles('1h'));
  assert.deepEqual(withReturn.getActive('1h'), withoutReturn.getActive('1h'));
  assert.deepEqual(withReturn.getCandles('1m'), withoutReturn.getCandles('1m'));
  assert.deepEqual(withReturn.getActive('1m'), withoutReturn.getActive('1m'));
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
