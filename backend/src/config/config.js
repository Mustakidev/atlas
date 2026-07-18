const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const defaults = {
  PORT: 3000,
  API_URL: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true',
  SYMBOL: 'BTCUSDT',
  REFRESH_INTERVAL: 2000,
  CACHE_TTL: 30000,
  MAX_HISTORY: 500,
  LOG_LEVEL: 'INFO',
  REQUEST_TIMEOUT: 10000,
  MAX_RETRIES: 5,
  INITIAL_BACKOFF: 1000,
  CONFLUENCE_BULLISH_THRESHOLD: 65,
  CONFLUENCE_BEARISH_THRESHOLD: 35,
  MIN_API_INTERVAL: 5000,
  API_THROTTLE_TTL: 30000,
};

class ConfigManager {
  constructor() {
    this.config = {};
    this.load();
  }

  load() {
    for (const [key, fallback] of Object.entries(defaults)) {
      const envVal = process.env[key];
      if (envVal === undefined || envVal === '') {
        this.config[key] = fallback;
      } else if (typeof fallback === 'number') {
        this.config[key] = Number(envVal);
      } else {
        this.config[key] = envVal;
      }
    }
  }

  get(key) {
    return this.config[key];
  }

  getAll() {
    return { ...this.config };
  }

  set(key, value) {
    this.config[key] = value;
  }
}

module.exports = { ConfigManager };
