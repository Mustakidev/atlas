class HistoryEngine {
  constructor(config, logger, symbol) {
    this.logger = logger;
    this.maxSize = config.get('MAX_HISTORY');
    this.symbol = symbol || 'BTCUSDT';
    this.snapshots = [];
  }

  add(snapshot) {
    this.snapshots.push(Object.freeze({ ...snapshot }));
    if (this.snapshots.length > this.maxSize) {
      this.snapshots.shift();
    }
  }

  latest() {
    return this.snapshots[this.snapshots.length - 1] || null;
  }

  last(n) {
    if (n <= 0) return [];
    return this.snapshots.slice(-Math.min(n, this.maxSize));
  }

  all() {
    return [...this.snapshots];
  }

  size() {
    return this.snapshots.length;
  }

  clear() {
    this.snapshots = [];
  }
}

module.exports = { HistoryEngine };
