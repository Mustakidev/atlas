const assert = require('node:assert/strict');
const test = require('node:test');

const { ApiManager, ACQUISITION_STATUSES } = require('../../src/network/apiManager');
const { CacheEngine } = require('../../src/engine/cache');

const BASE_TIME = Date.UTC(2024, 0, 1, 0, 0, 0);

function config(values = {}) {
  const defaults = {
    SYMBOL: 'BTCUSDT',
    API_URL: 'https://provider.test/price',
    REQUEST_TIMEOUT: 1000,
    MIN_API_INTERVAL: 1,
    API_THROTTLE_TTL: 30000,
    CACHE_TTL: 30000,
  };
  return { get(key) { return values[key] ?? defaults[key]; } };
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function retry() {
  return {
    execute(fn) { return fn(); },
    sleep() { return Promise.resolve(); },
  };
}

function response(payload) {
  return {
    ok: true,
    status: 200,
    async json() { return payload; },
  };
}

function validPayload(price = 100) {
  return {
    bitcoin: {
      usd: price,
      usd_24h_vol: 10,
      usd_24h_change: -1.5,
    },
  };
}

function makeManager({ fetchClient, values = {}, cache } = {}) {
  const actualCache = cache || new CacheEngine(config(values), logger(), 'BTCUSDT');
  const manager = new ApiManager(
    config(values),
    retry(),
    actualCache,
    logger(),
    fetchClient || (async () => response(validPayload())),
  );
  return { manager, cache: actualCache };
}

async function withNow(value, fn) {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

function storeSnapshot(cache, timestamp = new Date(BASE_TIME).toISOString()) {
  const originalNow = Date.now;
  Date.now = () => BASE_TIME;
  try {
    cache.store({
      symbol: 'BTCUSDT',
      price: 100,
      volume: 10,
      timestamp,
    });
  } finally {
    Date.now = originalNow;
  }
}

test('valid provider data becomes FRESH with one truthful observation timestamp', async () => {
  const { manager, cache } = makeManager();
  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.FRESH);
  assert.equal(result.snapshot.timestamp, new Date(BASE_TIME + 1000).toISOString());
  assert.deepEqual(result.provenance, {
    source: 'CoinGecko',
    observedAt: result.snapshot.timestamp,
    sourceTimestamp: null,
    effectiveAgeMs: 0,
    cacheAgeMs: null,
    fallbackReason: null,
  });
  assert.equal(cache.get().timestamp, result.snapshot.timestamp);
});

test('throttle reuse is CACHE_HIT and preserves the original timestamp', async () => {
  const { manager, cache } = makeManager();
  storeSnapshot(cache);

  let fetchCalls = 0;
  manager.fetch = async () => {
    fetchCalls++;
    return response(validPayload(200));
  };

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(fetchCalls, 0);
  assert.equal(result.status, ACQUISITION_STATUSES.CACHE_HIT);
  assert.equal(result.snapshot.timestamp, new Date(BASE_TIME).toISOString());
  assert.equal(result.provenance.cacheAgeMs, 1000);
  assert.equal(result.provenance.effectiveAgeMs, 1000);
  assert.equal(result.provenance.fallbackReason, null);
});

test('cache age equal to CACHE_TTL remains CACHE_HIT', async () => {
  const cache = new CacheEngine(config({ API_THROTTLE_TTL: 60000 }), logger(), 'BTCUSDT');
  storeSnapshot(cache);
  const { manager } = makeManager({ cache, values: { API_THROTTLE_TTL: 60000 } });

  const result = await withNow(BASE_TIME + 30000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.CACHE_HIT);
  assert.equal(result.provenance.cacheAgeMs, 30000);
});

test('provider failure classifies non-expired cache without admitting it', async () => {
  const cache = new CacheEngine(config({ API_THROTTLE_TTL: 1 }), logger(), 'BTCUSDT');
  storeSnapshot(cache);
  const { manager } = makeManager({
    cache,
    values: { API_THROTTLE_TTL: 1 },
    fetchClient: async () => { throw new Error('provider unavailable'); },
  });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.CACHE_HIT);
  assert.equal(result.snapshot.timestamp, new Date(BASE_TIME).toISOString());
  assert.equal(result.provenance.fallbackReason, ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE);
  assert.equal(result.provenance.cacheAgeMs, 1000);
});

test('expired cache is STALE_CACHE and retains its original timestamp', async () => {
  const cache = new CacheEngine(config({ API_THROTTLE_TTL: 1 }), logger(), 'BTCUSDT');
  storeSnapshot(cache);
  const { manager } = makeManager({
    cache,
    values: { API_THROTTLE_TTL: 1 },
    fetchClient: async () => { throw new Error('provider unavailable'); },
  });

  const result = await withNow(BASE_TIME + 30001, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.STALE_CACHE);
  assert.equal(result.snapshot.timestamp, new Date(BASE_TIME).toISOString());
  assert.equal(result.provenance.fallbackReason, ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE);
  assert.equal(result.provenance.cacheAgeMs, 30001);
  assert.equal(result.provenance.effectiveAgeMs, 30001);
});

test('provider failure without cache is PROVIDER_UNAVAILABLE with no snapshot', async () => {
  const { manager } = makeManager({ fetchClient: async () => { throw new Error('timeout'); } });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE);
  assert.equal(result.snapshot, null);
  assert.deepEqual(result.provenance, {
    source: 'CoinGecko',
    observedAt: null,
    sourceTimestamp: null,
    effectiveAgeMs: null,
    cacheAgeMs: null,
    fallbackReason: ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE,
  });
});

test('invalid provider data does not replace valid cache', async () => {
  const cache = new CacheEngine(config({ API_THROTTLE_TTL: 1 }), logger(), 'BTCUSDT');
  storeSnapshot(cache);
  const { manager } = makeManager({
    cache,
    values: { API_THROTTLE_TTL: 1 },
    fetchClient: async () => response({ bitcoin: { usd: NaN } }),
  });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.CACHE_HIT);
  assert.equal(result.provenance.fallbackReason, ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
  assert.equal(result.snapshot.timestamp, new Date(BASE_TIME).toISOString());
  assert.equal(cache.get().price, 100);
});

test('invalid provider data without cache is INVALID_PROVIDER_DATA', async () => {
  const { manager } = makeManager({ fetchClient: async () => response({ bitcoin: { usd: 0 } }) });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
  assert.equal(result.snapshot, null);
  assert.equal(result.provenance.fallbackReason, ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
});

for (const [name, usd] of [
  ['missing price', undefined],
  ['non-finite price', NaN],
  ['zero price', 0],
  ['negative price', -1],
]) {
  test(`provider ${name} cannot become FRESH`, async () => {
    const { manager } = makeManager({ fetchClient: async () => response({ bitcoin: { usd } }) });
    const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

    assert.equal(result.status, ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
    assert.equal(result.snapshot, null);
  });
}
