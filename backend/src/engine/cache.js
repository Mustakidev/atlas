class CacheEngine {
  constructor(config, logger, symbol) {
    this.logger = logger;
    this.ttl = config.get('CACHE_TTL');
    this.symbol = symbol || 'BTCUSDT';
    this.snapshot = null;
    this.timestamp = 0;
  }

  store(snapshot) {
    this.snapshot = Object.freeze({ ...snapshot });
    this.timestamp = Date.now();
    this.logger.info('CacheEngine', 'Snapshot cached', {
      price: snapshot.price,
    });
  }

  get() {
    return this.getWithMetadata()?.snapshot || null;
  }

  getWithMetadata(nowMs = Date.now()) {
    if (!this.snapshot) return null;

    const ageMs = nowMs - this.timestamp;
    const expired = ageMs > this.ttl;
    if (expired) {
      this.logger.warn('CacheEngine', 'Cache expired, returning stale data', {
        ageMs,
      });
    }

    return {
      snapshot: { ...this.snapshot, cached: true },
      cacheAgeMs: ageMs,
      expired,
    };
  }

  has() {
    return this.snapshot !== null;
  }

  clear() {
    this.snapshot = null;
    this.timestamp = 0;
  }

  getAge() {
    if (!this.snapshot) return null;
    return Date.now() - this.timestamp;
  }
}

module.exports = { CacheEngine };
