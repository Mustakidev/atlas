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

function storeSnapshot(cache, timestamp = new Date(BASE_TIME).toISOString(), symbol = 'BTCUSDT') {
  const originalNow = Date.now;
  Date.now = () => BASE_TIME;
  try {
    cache.store({
      symbol,
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
  assert.equal(result.snapshot.symbol, 'BTCUSDT');
  assert.equal(result.snapshot.price, 100);
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

test('BTCUSDT owns the bitcoin provider asset and request identity', async () => {
  let requestedUrl;
  const { manager } = makeManager({
    values: {
      API_URL: 'https://provider.test/price?ids=ethereum&ids=solana&vs_currencies=usd&include_24hr_vol=true',
    },
    fetchClient: async url => {
      requestedUrl = url;
      return response({
        bitcoin: {
          usd: 123,
          usd_24h_vol: 456,
          usd_24h_change: -7.5,
          usd_24h_high: 130,
          usd_24h_low: 110,
        },
        ethereum: {
          usd: 999,
          usd_24h_vol: 888,
          usd_24h_change: 77,
          usd_24h_high: 1000,
          usd_24h_low: 900,
        },
      });
    },
  });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());
  const parsed = new URL(requestedUrl);

  assert.equal(manager.providerAssetId, 'bitcoin');
  assert.equal(parsed.searchParams.get('ids'), 'bitcoin');
  assert.deepEqual(parsed.searchParams.getAll('ids'), ['bitcoin']);
  assert.equal(parsed.searchParams.getAll('ids').includes('ethereum'), false);
  assert.equal(parsed.searchParams.getAll('ids').includes('solana'), false);
  assert.equal(parsed.searchParams.get('vs_currencies'), 'usd');
  assert.equal(parsed.searchParams.get('include_24hr_vol'), 'true');
  assert.equal(result.status, ACQUISITION_STATUSES.FRESH);
  assert.equal(result.snapshot.symbol, 'BTCUSDT');
  assert.equal(result.snapshot.price, 123);
  assert.equal(result.snapshot.volume, 456);
  assert.equal(result.snapshot.change24h, -7.5);
  assert.equal(result.snapshot.high, 130);
  assert.equal(result.snapshot.low, 110);
  assert.notEqual(result.snapshot.price, 999);
  assert.notEqual(result.snapshot.volume, 888);
  assert.notEqual(result.snapshot.change24h, 77);
  assert.notEqual(result.snapshot.high, 1000);
  assert.notEqual(result.snapshot.low, 900);
});

test('invalid live provider URLs fail during ApiManager construction', () => {
  assert.throws(
    () => makeManager({ values: { API_URL: 'not-a-url' } }),
    error => error.code === 'INVALID_LIVE_PROVIDER_URL',
  );
});

test('non-HTTP live provider URLs fail before fetch, retry, or cache use', () => {
  let fetchCalls = 0;
  let retryCalls = 0;
  let cacheReads = 0;
  let cacheMutations = 0;
  const cache = {
    getAge() {
      cacheReads++;
      throw new Error('cache must not be read');
    },
    get() {
      cacheReads++;
      throw new Error('cache must not be read');
    },
    getWithMetadata() {
      cacheReads++;
      throw new Error('cache must not be read');
    },
    store() {
      cacheMutations++;
      throw new Error('cache must not be mutated');
    },
    has() {
      cacheReads++;
      throw new Error('cache must not be read');
    },
  };
  const retryHandler = {
    execute() {
      retryCalls++;
      throw new Error('retry must not execute');
    },
    sleep() {
      retryCalls++;
      throw new Error('retry must not execute');
    },
  };

  assert.throws(
    () => new ApiManager(
      config({ API_URL: 'ftp://provider.test/price?ids=bitcoin' }),
      retryHandler,
      cache,
      logger(),
      async () => {
        fetchCalls++;
        return response(validPayload());
      },
    ),
    error => error.code === 'INVALID_LIVE_PROVIDER_URL',
  );
  assert.equal(fetchCalls, 0);
  assert.equal(retryCalls, 0);
  assert.equal(cacheReads, 0);
  assert.equal(cacheMutations, 0);
});

test('unsupported live symbols fail before provider or cache access', () => {
  let fetchCalls = 0;
  const cache = {
    getAge() {
      throw new Error('cache must not be read');
    },
  };

  assert.throws(
    () => makeManager({
      values: { SYMBOL: 'ETHUSDT' },
      cache,
      fetchClient: async () => {
        fetchCalls++;
        return response(validPayload());
      },
    }),
    error => error.code === 'UNSUPPORTED_LIVE_SYMBOL'
      && error.message === 'Unsupported live symbol: ETHUSDT',
  );
  assert.equal(fetchCalls, 0);
});

test('missing bitcoin provider data is INVALID_PROVIDER_DATA', async () => {
  const { manager } = makeManager({
    fetchClient: async () => response({ ethereum: { usd: 200 } }),
  });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
  assert.equal(result.snapshot, null);
});

test('wrong-symbol cache cannot suppress provider acquisition', async () => {
  const cache = new CacheEngine(config(), logger(), 'ETHUSDT');
  storeSnapshot(cache, new Date(BASE_TIME).toISOString(), 'ETHUSDT');
  const originalCachedSnapshot = { ...cache.snapshot };
  const originalCacheTimestamp = cache.timestamp;
  let fetchCalls = 0;
  const { manager } = makeManager({
    cache,
    fetchClient: async () => {
      fetchCalls++;
      assert.deepEqual(cache.snapshot, originalCachedSnapshot);
      assert.equal(cache.timestamp, originalCacheTimestamp);
      return response(validPayload(200));
    },
  });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(fetchCalls, 1);
  assert.equal(result.status, ACQUISITION_STATUSES.FRESH);
  assert.equal(result.snapshot.symbol, 'BTCUSDT');
  assert.equal(cache.get().symbol, 'BTCUSDT');
  assert.equal(cache.get().price, 200);
  assert.equal(cache.timestamp, BASE_TIME + 1000);
});

test('wrong-symbol cache is not a provider-failure fallback', async () => {
  const cache = new CacheEngine(config({ API_THROTTLE_TTL: 1 }), logger(), 'ETHUSDT');
  storeSnapshot(cache, new Date(BASE_TIME).toISOString(), 'ETHUSDT');
  const { manager } = makeManager({
    cache,
    values: { API_THROTTLE_TTL: 1 },
    fetchClient: async () => {
      throw new Error('provider unavailable');
    },
  });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE);
  assert.equal(result.snapshot, null);
  assert.equal(cache.get().symbol, 'ETHUSDT');
  assert.equal(cache.timestamp, BASE_TIME);
});

test('wrong-symbol cache is not an invalid-data fallback', async () => {
  const cache = new CacheEngine(config({ API_THROTTLE_TTL: 1 }), logger(), 'ETHUSDT');
  storeSnapshot(cache, new Date(BASE_TIME).toISOString(), 'ETHUSDT');
  const { manager } = makeManager({
    cache,
    values: { API_THROTTLE_TTL: 1 },
    fetchClient: async () => response({ bitcoin: { usd: 0 } }),
  });

  const result = await withNow(BASE_TIME + 1000, () => manager.fetchMarketData());

  assert.equal(result.status, ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
  assert.equal(result.snapshot, null);
  assert.equal(cache.get().symbol, 'ETHUSDT');
  assert.equal(cache.timestamp, BASE_TIME);
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
