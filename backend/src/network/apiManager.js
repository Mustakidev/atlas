const fetch = require('node-fetch');

const DEFAULT_MIN_INTERVAL = 5000;
const DEFAULT_THROTTLE_TTL = 30000;

class ApiManager {
  constructor(config, retryHandler, cache, logger) {
    this.logger = logger;
    this.retry = retryHandler;
    this.cache = cache;
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
      const cached = this.cache.get();
      if (cached) {
        const throttledSnapshot = {
          ...cached,
          timestamp: new Date().toISOString(),
        };
        this.logger.info('ApiManager', 'Throttle: using cached data', {
          cacheAgeMs: cacheAge,
          throttleTtl: this._throttleTtl,
        });
        return throttledSnapshot;
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

    const result = await this.retry.execute(async () => {
      const response = await fetch(this.url, { timeout: this.timeout });

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

    const snapshot = this.buildSnapshot(result);
    this.connected = true;
    this.lastFetchTime = new Date();
    this.consecutiveFailures = 0;
    this.cache.store(snapshot);

    return snapshot;
  }

  buildSnapshot(raw) {
    const btc = raw.bitcoin || {};
    return {
      symbol: this.symbol,
      exchange: 'CoinGecko',
      price: btc.usd || 0,
      open: 0,
      high: btc.usd_24h_high || 0,
      low: btc.usd_24h_low || 0,
      volume: btc.usd_24h_vol || 0,
      change24h: btc.usd_24h_change || 0,
      timestamp: new Date().toISOString(),
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

module.exports = { ApiManager };
