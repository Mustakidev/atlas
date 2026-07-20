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
  API_KEY: '',
  CORS_ORIGIN: 'http://localhost:3000',
  MAX_BODY_SIZE: '16kb',
  RATE_LIMIT_MAX_REQUESTS: 500,
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_EXPENSIVE_MAX: 5,
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

  validate() {
    const errors = [];
    const warnings = [];
    const validLogLevels = ['SYSTEM', 'ERROR', 'WARNING', 'SUCCESS', 'INFO'];

    const port = this.config.PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535, got: ${port}`);
    }

    const apiKey = this.config.API_KEY;
    if (apiKey !== '' && apiKey.length < 32) {
      errors.push(`API_KEY must be empty (disabled) or >= 32 characters, got: ${apiKey.length} characters`);
    }

    const corsOrigin = this.config.CORS_ORIGIN;
    if (!corsOrigin || corsOrigin.length === 0) {
      errors.push('CORS_ORIGIN must not be empty');
    } else if (corsOrigin === '*') {
      warnings.push('CORS_ORIGIN is set to * — all origins allowed. Restrict in production.');
    }

    const maxBodySize = this.config.MAX_BODY_SIZE;
    if (!maxBodySize || typeof maxBodySize !== 'string') {
      errors.push(`MAX_BODY_SIZE must be a valid string (e.g. "16kb"), got: ${maxBodySize}`);
    }

    const rlMax = this.config.RATE_LIMIT_MAX_REQUESTS;
    if (!Number.isInteger(rlMax) || rlMax < 1) {
      errors.push(`RATE_LIMIT_MAX_REQUESTS must be a positive integer, got: ${rlMax}`);
    }

    const rlWindow = this.config.RATE_LIMIT_WINDOW_MS;
    if (!Number.isInteger(rlWindow) || rlWindow < 1000) {
      errors.push(`RATE_LIMIT_WINDOW_MS must be an integer >= 1000, got: ${rlWindow}`);
    }

    const rlExpensive = this.config.RATE_LIMIT_EXPENSIVE_MAX;
    if (!Number.isInteger(rlExpensive) || rlExpensive < 1) {
      errors.push(`RATE_LIMIT_EXPENSIVE_MAX must be a positive integer, got: ${rlExpensive}`);
    }

    const refreshInterval = this.config.REFRESH_INTERVAL;
    if (!Number.isInteger(refreshInterval) || refreshInterval < 500) {
      warnings.push(`REFRESH_INTERVAL < 500ms may cause excessive API calls. Current: ${refreshInterval}`);
    }

    const logLevel = this.config.LOG_LEVEL;
    if (!validLogLevels.includes(logLevel)) {
      errors.push(`LOG_LEVEL must be one of: ${validLogLevels.join(', ')}, got: ${logLevel}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

module.exports = { ConfigManager };
