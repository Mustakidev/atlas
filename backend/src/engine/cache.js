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
    if (!this.snapshot) return null;

    const age = Date.now() - this.timestamp;
    if (age > this.ttl) {
      this.logger.warn('CacheEngine', 'Cache expired, returning stale data', {
        ageMs: age,
      });
    }

    return { ...this.snapshot, cached: true };
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
