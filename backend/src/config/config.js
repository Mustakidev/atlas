const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { isLoopbackOrigin, normalizeOrigin } = require('../auth/origin');
const { isValidPasswordVerifier } = require('../auth/password');

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
  ATLAS_OPERATOR_PASSWORD_HASH: '',
  ATLAS_ORIGIN: '',
  ATLAS_COOKIE_SECURE: undefined,
  COINGECKO_API_KEY: '',
  CORS_ORIGIN: 'http://localhost:3000',
  MAX_BODY_SIZE: '16kb',
  RATE_LIMIT_MAX_REQUESTS: 500,
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_EXPENSIVE_MAX: 5,
  RATE_LIMIT_LOGIN_MAX_REQUESTS: 10,
  RATE_LIMIT_LOGIN_WINDOW_MS: 900000,
};

class ConfigManager {
  constructor() {
    this.config = {};
    this.load();
  }

  load() {
    for (const [key, fallback] of Object.entries(defaults)) {
      const envVal = process.env[key];
      if (key === 'ATLAS_COOKIE_SECURE') {
        this.config[key] = envVal === 'true' ? true : envVal === 'false' ? false : envVal;
        continue;
      }
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
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.trim().length === 0) {
      errors.push('API_KEY must be a non-empty, non-whitespace string');
    } else if (apiKey.length < 32) {
      errors.push(`API_KEY must be at least 32 characters, got: ${apiKey.length} characters`);
    }

    const passwordHash = this.config.ATLAS_OPERATOR_PASSWORD_HASH;
    if (typeof passwordHash !== 'string' || passwordHash.trim().length === 0 || !isValidPasswordVerifier(passwordHash)) {
      errors.push('ATLAS_OPERATOR_PASSWORD_HASH must be a valid PH-2B scrypt verifier');
    }

    const configuredOrigin = this.config.ATLAS_ORIGIN;
    let origin = null;
    if (typeof configuredOrigin !== 'string' || configuredOrigin.length === 0) {
      errors.push('ATLAS_ORIGIN must be configured');
    } else {
      try {
        origin = normalizeOrigin(configuredOrigin);
      } catch {
        errors.push('ATLAS_ORIGIN must be a canonical HTTP or HTTPS origin');
      }
    }

    const cookieSecure = this.config.ATLAS_COOKIE_SECURE;
    if (typeof cookieSecure !== 'boolean') {
      errors.push('ATLAS_COOKIE_SECURE must be exactly true or false');
    } else if (origin) {
      const local = isLoopbackOrigin(origin);
      const protocol = new URL(origin).protocol;
      if (!local && protocol !== 'https:') {
        errors.push('ATLAS_ORIGIN must use HTTPS for non-loopback hosts');
      }
      if (!cookieSecure && !local) {
        errors.push('ATLAS_COOKIE_SECURE=false is allowed only for loopback origins');
      }
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

    const loginMax = this.config.RATE_LIMIT_LOGIN_MAX_REQUESTS;
    if (!Number.isInteger(loginMax) || loginMax < 1) {
      errors.push(`RATE_LIMIT_LOGIN_MAX_REQUESTS must be a positive integer, got: ${loginMax}`);
    }

    const loginWindow = this.config.RATE_LIMIT_LOGIN_WINDOW_MS;
    if (!Number.isInteger(loginWindow) || loginWindow < 1000) {
      errors.push(`RATE_LIMIT_LOGIN_WINDOW_MS must be an integer >= 1000, got: ${loginWindow}`);
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
