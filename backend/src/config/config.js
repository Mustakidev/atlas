const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { isLoopbackOrigin, normalizeOrigin } = require('../auth/origin');
const { isValidPasswordVerifier } = require('../auth/password');

const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_CACHE_TTL_MS = 86_400_000;
const MAX_HISTORY = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RETRY_BUDGET_MS = 180000;

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
  ATLAS_LIVE_STATE_FILE_PATH: undefined,
};

const INTEGER_KEYS = new Set([
  'PORT',
  'REFRESH_INTERVAL',
  'CACHE_TTL',
  'MAX_HISTORY',
  'REQUEST_TIMEOUT',
  'MAX_RETRIES',
  'INITIAL_BACKOFF',
  'MIN_API_INTERVAL',
  'API_THROTTLE_TTL',
  'RATE_LIMIT_MAX_REQUESTS',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_EXPENSIVE_MAX',
  'RATE_LIMIT_LOGIN_MAX_REQUESTS',
  'RATE_LIMIT_LOGIN_WINDOW_MS',
]);

const FINITE_NUMBER_KEYS = new Set([
  'CONFLUENCE_BULLISH_THRESHOLD',
  'CONFLUENCE_BEARISH_THRESHOLD',
]);

const BODY_SIZE_PATTERN = /^(?:\d+|\d+(?:\.\d+)?[ \t]*(?:kb|mb|gb|tb|pb))$/i;
const FINITE_NUMBER_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function parseStrictInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('value must be a safe integer');
    return value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new TypeError('value must contain decimal digits only');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('value must be a safe integer');
  return parsed;
}

function parseStrictFiniteNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('value must be finite');
    return value;
  }
  if (typeof value !== 'string' || !FINITE_NUMBER_PATTERN.test(value)) {
    throw new TypeError('value must be a strict decimal number');
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError('value must be finite');
  return parsed;
}

function parseBodySize(value) {
  if (typeof value !== 'string' || !BODY_SIZE_PATTERN.test(value)) {
    throw new TypeError('value must be a strict byte size');
  }

  const match = /^(\d+(?:\.\d+)?)[ \t]*(kb|mb|gb|tb|pb)$/i.exec(value);
  const multiplier = match
    ? { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 }[match[2].toLowerCase()]
    : 1;
  const bytes = Math.floor(Number(match ? match[1] : value) * multiplier);
  if (!Number.isSafeInteger(bytes)) throw new TypeError('value must produce a safe byte count');
  return bytes;
}

function parseEnvironmentValue(key, rawValue) {
  if (rawValue === '') return rawValue;
  if (INTEGER_KEYS.has(key)) {
    try {
      return parseStrictInteger(rawValue);
    } catch {
      return rawValue;
    }
  }
  if (FINITE_NUMBER_KEYS.has(key)) {
    try {
      return parseStrictFiniteNumber(rawValue);
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

class ConfigManager {
  constructor() {
    this.config = {};
    this.load();
  }

  load() {
    for (const [key, fallback] of Object.entries(defaults)) {
      const hasEnvValue = Object.hasOwn(process.env, key);
      const envVal = process.env[key];
      if (key === 'ATLAS_COOKIE_SECURE') {
        this.config[key] = !hasEnvValue
          ? fallback
          : envVal === 'true' ? true : envVal === 'false' ? false : envVal;
        continue;
      }
      if (!hasEnvValue) {
        this.config[key] = fallback;
      } else {
        this.config[key] = parseEnvironmentValue(key, envVal);
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

    const integer = (key, min, max) => {
      try {
        const value = parseStrictInteger(this.config[key]);
        if (value < min || value > max) throw new TypeError('out of range');
        this.config[key] = value;
        return value;
      } catch {
        errors.push(`${key} must be an integer between ${min} and ${max}`);
        return null;
      }
    };

    const finiteNumber = (key, min, max) => {
      try {
        const value = parseStrictFiniteNumber(this.config[key]);
        if (value < min || value > max) throw new TypeError('out of range');
        this.config[key] = value;
        return value;
      } catch {
        errors.push(`${key} must be a finite number between ${min} and ${max}`);
        return null;
      }
    };

    integer('PORT', 1, 65535);

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
    if (typeof corsOrigin !== 'string' || corsOrigin.length === 0) {
      errors.push('CORS_ORIGIN must not be empty');
    } else if (corsOrigin === '*') {
      warnings.push('CORS_ORIGIN is set to * — all origins allowed. Restrict in production.');
    } else {
      const origins = corsOrigin.split(',');
      if (origins.some(value => value.trim() === '')) {
        errors.push('CORS_ORIGIN must contain only canonical HTTP or HTTPS origins');
      } else {
        for (const value of origins) {
          try {
            normalizeOrigin(value.trim());
          } catch {
            errors.push('CORS_ORIGIN must contain only canonical HTTP or HTTPS origins');
            break;
          }
        }
      }
      if (origins.includes('*')) {
        errors.push('CORS_ORIGIN wildcard must be the only configured origin');
      }
    }

    const maxBodySize = this.config.MAX_BODY_SIZE;
    try {
      const bodyBytes = parseBodySize(maxBodySize);
      if (bodyBytes < 1 || bodyBytes > MAX_BODY_BYTES) throw new TypeError('out of range');
    } catch {
      errors.push('MAX_BODY_SIZE must be between 1 and 1048576 bytes');
    }

    integer('RATE_LIMIT_MAX_REQUESTS', 1, Number.MAX_SAFE_INTEGER);
    integer('RATE_LIMIT_WINDOW_MS', 1000, MAX_TIMER_MS);
    integer('RATE_LIMIT_EXPENSIVE_MAX', 1, Number.MAX_SAFE_INTEGER);
    integer('RATE_LIMIT_LOGIN_MAX_REQUESTS', 1, Number.MAX_SAFE_INTEGER);
    integer('RATE_LIMIT_LOGIN_WINDOW_MS', 1000, MAX_TIMER_MS);

    const apiUrl = this.config.API_URL;
    if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
      errors.push('API_URL must be an absolute HTTP or HTTPS URL without credentials or fragment');
    } else {
      try {
        const parsed = new URL(apiUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)
          || parsed.username || parsed.password || parsed.hash || !parsed.hostname) {
          throw new TypeError('invalid URL policy');
        }
      } catch {
        errors.push('API_URL must be an absolute HTTP or HTTPS URL without credentials or fragment');
      }
    }

    const symbol = this.config.SYMBOL;
    if (symbol !== 'BTCUSDT') errors.push('SYMBOL must be exactly BTCUSDT');

    const coinGeckoApiKey = this.config.COINGECKO_API_KEY;
    if (typeof coinGeckoApiKey !== 'string'
      || (coinGeckoApiKey.length > 0 && coinGeckoApiKey.trim() === '')) {
      errors.push('COINGECKO_API_KEY must be empty or a nonblank string');
    }

    const refreshInterval = integer('REFRESH_INTERVAL', 500, MAX_TIMER_MS);
    const cacheTtl = integer('CACHE_TTL', 1, MAX_CACHE_TTL_MS);
    const maxHistory = integer('MAX_HISTORY', 201, MAX_HISTORY);
    const requestTimeout = integer('REQUEST_TIMEOUT', 1, 30000);
    const maxRetries = integer('MAX_RETRIES', 0, 10);
    const initialBackoff = integer('INITIAL_BACKOFF', 0, 5000);
    const minApiInterval = integer('MIN_API_INTERVAL', 1, MAX_TIMER_MS);
    const throttleTtl = integer('API_THROTTLE_TTL', 1, MAX_CACHE_TTL_MS);

    const bullishThreshold = finiteNumber('CONFLUENCE_BULLISH_THRESHOLD', 0, 100);
    const bearishThreshold = finiteNumber('CONFLUENCE_BEARISH_THRESHOLD', 0, 100);
    if (bullishThreshold !== null && bearishThreshold !== null && bearishThreshold >= bullishThreshold) {
      errors.push('CONFLUENCE_BEARISH_THRESHOLD must be less than CONFLUENCE_BULLISH_THRESHOLD');
    }

    if (cacheTtl !== null && throttleTtl !== null && throttleTtl > cacheTtl) {
      errors.push('API_THROTTLE_TTL must be less than or equal to CACHE_TTL');
    }

    if (requestTimeout !== null && maxRetries !== null && initialBackoff !== null) {
      const retryBudget = (maxRetries + 1) * requestTimeout
        + 2.4 * initialBackoff * (2 ** maxRetries - 1);
      if (!Number.isSafeInteger(Math.ceil(retryBudget)) || retryBudget > MAX_RETRY_BUDGET_MS) {
        errors.push('REQUEST_TIMEOUT, MAX_RETRIES, and INITIAL_BACKOFF exceed the 180000ms retry budget');
      }
    }

    const statePath = this.config.ATLAS_LIVE_STATE_FILE_PATH;
    if (statePath !== undefined
      && (typeof statePath !== 'string' || statePath.trim() === '' || !path.isAbsolute(statePath))) {
      errors.push('ATLAS_LIVE_STATE_FILE_PATH must be a nonblank absolute path when set');
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

module.exports = {
  ConfigManager,
  parseBodySize,
  parseStrictFiniteNumber,
  parseStrictInteger,
};
