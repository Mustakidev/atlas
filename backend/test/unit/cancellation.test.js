const assert = require('node:assert/strict');
const test = require('node:test');

const {
  throwIfAborted,
  isCancellation,
  createAbortError,
} = require('../../src/core/cancellation');
const { RetryHandler } = require('../../src/network/retry');
const { ApiManager } = require('../../src/network/apiManager');
const { CacheEngine } = require('../../src/engine/cache');

function config(values = {}) {
  const defaults = {
    SYMBOL: 'BTCUSDT',
    API_URL: 'https://provider.test/price',
    REQUEST_TIMEOUT: 1000,
    MIN_API_INTERVAL: 1,
    API_THROTTLE_TTL: 30000,
    CACHE_TTL: 30000,
    MAX_RETRIES: 2,
    INITIAL_BACKOFF: 100,
  };
  return { get(key) { return values[key] ?? defaults[key]; } };
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function trackingSignal() {
  const controller = new AbortController();
  const counts = { added: 0, removed: 0 };
  const signal = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener(...args) {
      counts.added++;
      return controller.signal.addEventListener(...args);
    },
    removeEventListener(...args) {
      counts.removed++;
      return controller.signal.removeEventListener(...args);
    },
  };
  return { controller, signal, counts };
}

function validResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { bitcoin: { usd: 100, usd_24h_vol: 10, usd_24h_change: 1 } };
    },
  };
}

test('cancellation primitive is narrow, deterministic, and authoritative', () => {
  const { controller, signal } = trackingSignal();
  const providerError = new Error('provider failed');

  assert.equal(isCancellation(providerError), false);
  assert.equal(isCancellation({ name: 'AbortError' }), true);
  assert.equal(isCancellation({ code: 'ABORT_ERR' }), true);
  assert.equal(isCancellation({ type: 'aborted' }), true);

  controller.abort(providerError);
  assert.equal(isCancellation(providerError, signal), true);
  assert.throws(() => throwIfAborted(signal), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    return true;
  });

  const abortError = createAbortError(providerError);
  assert.equal(abortError.name, 'AbortError');
  assert.equal(abortError.code, 'ABORT_ERR');
  assert.equal(providerError.name, 'Error');
  assert.equal(providerError.code, undefined);
});

test('RetryHandler performs zero attempts for an already-aborted signal', async () => {
  const retry = new RetryHandler(config(), logger());
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;

  await assert.rejects(
    retry.execute(async () => {
      attempts++;
      return 'unexpected';
    }, { signal: controller.signal }),
    { name: 'AbortError', code: 'ABORT_ERR' },
  );
  assert.equal(attempts, 0);
});

test('RetryHandler does not retry an active-fetch cancellation', async () => {
  const warnings = [];
  const retry = new RetryHandler(config(), {
    warn(module, message) { warnings.push({ module, message }); },
    error() {},
  });
  const controller = new AbortController();
  let attempts = 0;
  let rejectFetch;
  const pending = retry.execute(() => {
    attempts++;
    return new Promise((resolve, reject) => { rejectFetch = reject; });
  }, { signal: controller.signal });

  controller.abort();
  rejectFetch(new Error('provider aborted'));

  await assert.rejects(pending, { message: 'provider aborted' });
  assert.equal(attempts, 1);
  assert.deepEqual(warnings, []);
});

test('RetryHandler aborts backoff and cleans its timer and listener', async () => {
  const { controller, signal, counts } = trackingSignal();
  const retry = new RetryHandler(config(), logger());
  const waiting = retry.sleep(10000, signal);

  controller.abort();

  await assert.rejects(waiting, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});

test('RetryHandler removes the abort listener after normal sleep completion', async () => {
  const { signal, counts } = trackingSignal();
  const retry = new RetryHandler(config(), logger());

  await retry.sleep(0, signal);

  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});

test('ApiManager propagates cancellation without failure state or fallback', async () => {
  const controller = new AbortController();
  let fetchOptions;
  let fetchReject;
  const errors = [];
  const retry = new RetryHandler(config(), {
    warn() {},
    error(module, message, data) { errors.push({ module, message, data }); },
  });
  const cache = new CacheEngine(config(), logger(), 'BTCUSDT');
  const manager = new ApiManager(config(), retry, cache, {
    info() {},
    warn() {},
    error(...args) { errors.push(args); },
  }, async (url, options) => {
    fetchOptions = options;
    return new Promise((resolve, reject) => {
      fetchReject = reject;
      options.signal.addEventListener('abort', () => reject(createAbortError()));
    });
  });

  const pending = manager.fetchMarketData({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  fetchReject(createAbortError());

  await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(fetchOptions.signal, controller.signal);
  assert.equal(cache.has(), false);
  assert.equal(manager.getHealth().consecutiveFailures, 0);
  assert.equal(errors.length, 0);
});

test('ApiManager forwards the lifecycle signal to RetryHandler', async () => {
  const controller = new AbortController();
  let executeOptions;
  let fetchOptions;
  const retry = {
    execute(fn, options) {
      executeOptions = options;
      return fn();
    },
    sleep() { return Promise.resolve(); },
  };
  const manager = new ApiManager(
    config(),
    retry,
    new CacheEngine(config(), logger(), 'BTCUSDT'),
    logger(),
    async (url, options) => {
      fetchOptions = options;
      return validResponse();
    },
  );

  await manager.fetchMarketData({ signal: controller.signal });

  assert.equal(executeOptions.signal, controller.signal);
  assert.equal(fetchOptions.signal, controller.signal);
});

test('ApiManager does not store a result when cancellation races response acquisition', async () => {
  const controller = new AbortController();
  let stores = 0;
  const cache = new CacheEngine(config(), logger(), 'BTCUSDT');
  const originalStore = cache.store.bind(cache);
  cache.store = value => {
    stores++;
    return originalStore(value);
  };
  const manager = new ApiManager(
    config(),
    new RetryHandler(config(), logger()),
    cache,
    logger(),
    async () => {
      controller.abort();
      return validResponse();
    },
  );

  await assert.rejects(
    manager.fetchMarketData({ signal: controller.signal }),
    { name: 'AbortError', code: 'ABORT_ERR' },
  );
  assert.equal(stores, 0);
  assert.equal(manager.getHealth().consecutiveFailures, 0);
});

test('ApiManager minimum-interval wait is cancellable before provider attempt', async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  const manager = new ApiManager(
    config({ MIN_API_INTERVAL: 10000 }),
    new RetryHandler(config({ MIN_API_INTERVAL: 10000 }), logger()),
    new CacheEngine(config(), logger(), 'BTCUSDT'),
    logger(),
    async () => {
      fetchCalls++;
      return validResponse();
    },
  );
  manager._lastExternalCall = Date.now();

  const pending = manager.fetchMarketData({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(fetchCalls, 0);
  assert.equal(manager.getHealth().consecutiveFailures, 0);
});
