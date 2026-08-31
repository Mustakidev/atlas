const fetch = require('node-fetch');

const DEFAULT_MIN_INTERVAL = 5000;
const DEFAULT_THROTTLE_TTL = 30000;

const ACQUISITION_STATUSES = Object.freeze({
  FRESH: 'FRESH',
  CACHE_HIT: 'CACHE_HIT',
  STALE_CACHE: 'STALE_CACHE',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INVALID_PROVIDER_DATA: 'INVALID_PROVIDER_DATA',
});

class ApiManager {
  constructor(config, retryHandler, cache, logger, fetchClient = fetch) {
    this.logger = logger;
    this.retry = retryHandler;
    this.cache = cache;
    this.fetch = fetchClient;
    this.symbol = config.get('SYMBOL') || 'BTCUSDT';
    this.url = config.get('API_URL');
    this.timeout = config.get('REQUEST_TIMEOUT');
    this.connected = false;
    this.lastFetchTime = null;
    this.consecutiveFailures = 0;

    this._minInterval = config.get('MIN_API_INTERVAL') || DEFAULT_MIN_INTERVAL;
    this._throttleTtl = config.get('API_THROTTLE_TTL') || DEFAULT_THROTTLE_TTL;
    this._lastExternalCall = 0;
  }

  async fetchMarketData() {
    const now = Date.now();

    // Proactive throttle: if cache is fresh enough, skip the external call
    const cacheAge = this.cache.getAge();
    if (cacheAge !== null && cacheAge < this._throttleTtl) {
      const cached = this.cache.getWithMetadata(now);
      if (cached) {
        this.logger.info('ApiManager', 'Throttle: using cached data', {
          cacheAgeMs: cacheAge,
          throttleTtl: this._throttleTtl,
        });
        return this._cacheResult(cached, now);
      }
    }

    // Minimum interval enforcement: prevent rapid-fire external calls
    const elapsed = now - this._lastExternalCall;
    if (elapsed < this._minInterval) {
      const waitMs = this._minInterval - elapsed;
      this.logger.info('ApiManager', 'Throttle: waiting for minimum interval', {
        waitMs,
        minInterval: this._minInterval,
      });
      await this.retry.sleep(waitMs);
    }

    this._lastExternalCall = Date.now();

    try {
      const result = await this.retry.execute(async () => {
        const response = await this.fetch(this.url, { timeout: this.timeout });

        if (response.status === 429) {
          const err = new Error('Rate limited');
          err.status = 429;
          err.headers = { 'retry-after': response.headers.get('retry-after') };
          throw err;
        }

        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}`);
          err.status = response.status;
          throw err;
        }

        return response.json();
      });

      const observedAtMs = Date.now();
      let snapshot;
      try {
        snapshot = this.buildSnapshot(result, observedAtMs);
      } catch (err) {
        this.fail();
        const fallbackNowMs = Date.now();
        const cached = this.cache.getWithMetadata(fallbackNowMs);
        if (cached) {
          return this._cacheResult(cached, fallbackNowMs, ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
        }
        return this._unavailableResult(ACQUISITION_STATUSES.INVALID_PROVIDER_DATA);
      }

      this.connected = true;
      this.lastFetchTime = new Date(observedAtMs);
      this.consecutiveFailures = 0;
      this.cache.store(snapshot);

      return {
        status: ACQUISITION_STATUSES.FRESH,
        snapshot,
        provenance: this._provenance(snapshot.timestamp, observedAtMs, null, null, null),
      };
    } catch (err) {
      this.fail();
      const fallbackNowMs = Date.now();
      const cached = this.cache.getWithMetadata(fallbackNowMs);
      if (cached) {
        return this._cacheResult(cached, fallbackNowMs, ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE);
      }
      return this._unavailableResult(ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE);
    }
  }

  buildSnapshot(raw, observedAtMs = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !raw.bitcoin || typeof raw.bitcoin !== 'object' || Array.isArray(raw.bitcoin)) {
      throw new TypeError('Provider response must contain a bitcoin object');
    }

    const btc = raw.bitcoin;
    if (typeof btc.usd !== 'number' || !Number.isFinite(btc.usd) || btc.usd <= 0) {
      throw new TypeError('Provider response must contain a positive finite bitcoin.usd price');
    }

    const volume = btc.usd_24h_vol == null ? 0 : btc.usd_24h_vol;
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) {
      throw new TypeError('Provider response volume must be finite and non-negative');
    }

    const change24h = btc.usd_24h_change == null ? 0 : btc.usd_24h_change;
    if (typeof change24h !== 'number' || !Number.isFinite(change24h)) {
      throw new TypeError('Provider response change24h must be finite');
    }

    const high = btc.usd_24h_high == null ? 0 : btc.usd_24h_high;
    const low = btc.usd_24h_low == null ? 0 : btc.usd_24h_low;
    if (![high, low].every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new TypeError('Provider response high and low values must be finite');
    }

    return {
      symbol: this.symbol,
      exchange: 'CoinGecko',
      price: btc.usd,
      open: 0,
      high,
      low,
      volume,
      change24h,
      timestamp: new Date(observedAtMs).toISOString(),
    };
  }

  _cacheResult(entry, nowMs, fallbackReason = null) {
    const status = entry.expired
      ? ACQUISITION_STATUSES.STALE_CACHE
      : ACQUISITION_STATUSES.CACHE_HIT;
    const observedAtMs = Date.parse(entry.snapshot.timestamp);

    return {
      status,
      snapshot: entry.snapshot,
      provenance: this._provenance(
        entry.snapshot.timestamp,
        nowMs,
        entry.cacheAgeMs,
        Number.isFinite(observedAtMs) ? Math.max(0, nowMs - observedAtMs) : null,
        fallbackReason,
      ),
    };
  }

  _unavailableResult(status) {
    return {
      status,
      snapshot: null,
      provenance: {
        source: 'CoinGecko',
        observedAt: null,
        sourceTimestamp: null,
        effectiveAgeMs: null,
        cacheAgeMs: null,
        fallbackReason: status === ACQUISITION_STATUSES.INVALID_PROVIDER_DATA
          ? ACQUISITION_STATUSES.INVALID_PROVIDER_DATA
          : ACQUISITION_STATUSES.PROVIDER_UNAVAILABLE,
      },
    };
  }

  _provenance(timestamp, nowMs, cacheAgeMs, effectiveAgeMs, fallbackReason) {
    return {
      source: 'CoinGecko',
      observedAt: timestamp,
      sourceTimestamp: null,
      effectiveAgeMs: effectiveAgeMs ?? (Number.isFinite(Date.parse(timestamp))
        ? Math.max(0, nowMs - Date.parse(timestamp))
        : null),
      cacheAgeMs,
      fallbackReason,
    };
  }

  isConnected() {
    return this.connected;
  }

  getLastFetchTime() {
    return this.lastFetchTime;
  }

  fail() {
    this.connected = false;
    this.consecutiveFailures++;
    this.logger.error('ApiManager', 'Fetch failed', {
      consecutiveFailures: this.consecutiveFailures,
    });
  }

  getHealth() {
    return {
      connected: this.connected,
      lastFetch: this.lastFetchTime,
      consecutiveFailures: this.consecutiveFailures,
      cacheAvailable: this.cache.has(),
    };
  }
}

module.exports = { ApiManager, ACQUISITION_STATUSES };
