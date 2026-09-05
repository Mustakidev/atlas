const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  ConfigManager,
  parseBodySize,
  parseStrictFiniteNumber,
  parseStrictInteger,
} = require('../../src/config/config');
const { RetryHandler } = require('../../src/network/retry');

const VALID_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';

const VALID_CONFIG = {
  PORT: 3000,
  API_URL: 'https://provider.test/price?vs_currencies=usd',
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
  API_KEY: 'a'.repeat(32),
  ATLAS_OPERATOR_PASSWORD_HASH: VALID_HASH,
  ATLAS_ORIGIN: 'http://localhost:3000',
  ATLAS_COOKIE_SECURE: false,
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

function validConfig(overrides = {}) {
  const config = new ConfigManager();
  for (const [key, value] of Object.entries({ ...VALID_CONFIG, ...overrides })) {
    config.set(key, value);
  }
  return config;
}

function assertInvalid(overrides, key) {
  const result = validConfig(overrides).validate();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.startsWith(key)), `${key} should be invalid`);
}

function withEnvironment(name, value, callback) {
  const present = Object.hasOwn(process.env, name);
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return callback();
  } finally {
    if (present) process.env[name] = previous;
    else delete process.env[name];
  }
}

function withMissingEnvironment(names, callback) {
  const previous = names.map(name => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }));
  for (const name of names) delete process.env[name];
  try {
    return callback();
  } finally {
    for (const entry of previous) {
      if (entry.present) process.env[entry.name] = entry.value;
      else delete process.env[entry.name];
    }
  }
}

test('strict integer parser accepts only decimal digits and safe integers', () => {
  for (const value of ['0', '1', '500', '3000', '65535']) {
    assert.equal(parseStrictInteger(value), Number(value));
  }
  for (const value of ['', ' ', ' 10', '10 ', '+10', '-1', '10abc', '1e3', '0x10', '1.5', 'Infinity', 'NaN']) {
    assert.throws(() => parseStrictInteger(value));
  }
});

test('strict finite-number parser accepts decimal and exponent notation only', () => {
  for (const value of ['0', '35', '65', '35.5', '1e1', '-1.25']) {
    assert.equal(parseStrictFiniteNumber(value), Number(value));
  }
  for (const value of ['', ' ', ' 10', '10 ', '0x10', 'Infinity', 'NaN', '10abc']) {
    assert.throws(() => parseStrictFiniteNumber(value));
  }
});

test('missing optional configuration uses defaults while explicit empty input remains invalid', () => {
  withMissingEnvironment(['API_URL', 'SYMBOL', 'REFRESH_INTERVAL', 'CACHE_TTL', 'MAX_HISTORY'], () => {
    const config = new ConfigManager();
    assert.equal(config.get('API_URL'), 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true');
    assert.equal(config.get('SYMBOL'), 'BTCUSDT');
    assert.equal(config.get('REFRESH_INTERVAL'), 2000);
    assert.equal(config.get('CACHE_TTL'), 30000);
    assert.equal(config.get('MAX_HISTORY'), 500);
  });

  withEnvironment('API_URL', '', () => {
    const config = new ConfigManager();
    assert.equal(config.get('API_URL'), '');
    assertInvalid({ API_URL: '' }, 'API_URL');
  });

  withEnvironment('REFRESH_INTERVAL', '', () => {
    const config = new ConfigManager();
    assert.equal(config.get('REFRESH_INTERVAL'), '');
    assertInvalid({ REFRESH_INTERVAL: '' }, 'REFRESH_INTERVAL');
  });
});

test('valid baseline configuration remains valid', () => {
  assert.equal(validConfig().validate().valid, true);
});

test('PORT uses strict integer and range validation', () => {
  for (const value of ['3000abc', '3000.0', '3e3', '0xBB8', ' 3000 ', 0, 65536]) {
    assertInvalid({ PORT: value }, 'PORT');
  }
  for (const value of [1, 65535]) {
    assert.equal(validConfig({ PORT: value }).validate().valid, true);
  }
});

test('API_URL requires an absolute HTTP or HTTPS URL without credentials or fragment', () => {
  for (const value of ['', 'not-a-url', 'ftp://provider.test/price', 'https://user@provider.test/price', 'https://provider.test/price#fragment']) {
    assertInvalid({ API_URL: value }, 'API_URL');
  }
  assert.equal(validConfig({ API_URL: 'http://127.0.0.1:1234/custom?x=1' }).validate().valid, true);
});

test('SYMBOL is exactly the supported live symbol', () => {
  for (const value of ['btcUSDT', ' BTCUSDT', 'BTCUSDT ', 'ETHUSDT', '']) {
    assertInvalid({ SYMBOL: value }, 'SYMBOL');
  }
});

test('production numeric ranges are enforced', () => {
  assertInvalid({ REFRESH_INTERVAL: 499 }, 'REFRESH_INTERVAL');
  assertInvalid({ REFRESH_INTERVAL: 2147483648 }, 'REFRESH_INTERVAL');
  assertInvalid({ CACHE_TTL: 0 }, 'CACHE_TTL');
  assertInvalid({ CACHE_TTL: 86400001 }, 'CACHE_TTL');
  assertInvalid({ MAX_HISTORY: 200 }, 'MAX_HISTORY');
  assertInvalid({ MAX_HISTORY: 5001 }, 'MAX_HISTORY');
  assert.equal(validConfig({ MAX_HISTORY: 201 }).validate().valid, true);
  assert.equal(validConfig({ MAX_HISTORY: 5000 }).validate().valid, true);
  assertInvalid({ REQUEST_TIMEOUT: 0 }, 'REQUEST_TIMEOUT');
  assertInvalid({ REQUEST_TIMEOUT: 30001 }, 'REQUEST_TIMEOUT');
  assertInvalid({ MAX_RETRIES: 11 }, 'MAX_RETRIES');
  assertInvalid({ INITIAL_BACKOFF: 5001 }, 'INITIAL_BACKOFF');
  assertInvalid({ MIN_API_INTERVAL: 0 }, 'MIN_API_INTERVAL');
  assertInvalid({ API_THROTTLE_TTL: 0 }, 'API_THROTTLE_TTL');
  assert.equal(validConfig({ MAX_RETRIES: 0, INITIAL_BACKOFF: 0 }).validate().valid, true);
});

test('throttle, retry budget, and confluence cross-constraints are enforced', () => {
  assertInvalid({ CACHE_TTL: 1000, API_THROTTLE_TTL: 1001 }, 'API_THROTTLE_TTL');
  assertInvalid({ REQUEST_TIMEOUT: 30000, MAX_RETRIES: 10, INITIAL_BACKOFF: 5000 }, 'REQUEST_TIMEOUT');
  assertInvalid({ CONFLUENCE_BULLISH_THRESHOLD: 35, CONFLUENCE_BEARISH_THRESHOLD: 35 }, 'CONFLUENCE_BEARISH_THRESHOLD');
  assertInvalid({ CONFLUENCE_BULLISH_THRESHOLD: 60, CONFLUENCE_BEARISH_THRESHOLD: 70 }, 'CONFLUENCE_BEARISH_THRESHOLD');
  assertInvalid({ CONFLUENCE_BULLISH_THRESHOLD: 101 }, 'CONFLUENCE_BULLISH_THRESHOLD');
  assert.equal(validConfig({ CONFLUENCE_BEARISH_THRESHOLD: 0 }).validate().valid, true);
});

test('MAX_BODY_SIZE accepts strict supported formats and enforces one MiB maximum', () => {
  for (const value of ['16kb', '1mb', '1048576', '1.5KB']) {
    assert.doesNotThrow(() => parseBodySize(value));
    assert.equal(validConfig({ MAX_BODY_SIZE: value }).validate().valid, true);
  }
  for (const value of ['', ' ', '0', '-1kb', '16kbjunk', 'Infinity', 'NaN', '1048577', '1.5mb']) {
    assertInvalid({ MAX_BODY_SIZE: value }, 'MAX_BODY_SIZE');
  }
});

test('live-state path is optional but absolute when configured', () => {
  assert.equal(validConfig({ ATLAS_LIVE_STATE_FILE_PATH: path.join('/tmp', 'atlas-state.json') }).validate().valid, true);
  for (const value of ['', ' ', 'relative/state.json']) {
    assertInvalid({ ATLAS_LIVE_STATE_FILE_PATH: value }, 'ATLAS_LIVE_STATE_FILE_PATH');
  }
});

test('CoinGecko key allows disabled mode but rejects whitespace-only values', () => {
  assert.equal(validConfig({ COINGECKO_API_KEY: '' }).validate().valid, true);
  assert.equal(validConfig({ COINGECKO_API_KEY: 'provider-key' }).validate().valid, true);
  assertInvalid({ COINGECKO_API_KEY: '   ' }, 'COINGECKO_API_KEY');
});

test('CORS origins and rate-limit values are strict', () => {
  assert.equal(validConfig({ CORS_ORIGIN: 'http://localhost:3000, https://example.test' }).validate().valid, true);
  assert.equal(validConfig({ CORS_ORIGIN: '*' }).validate().valid, true);
  assertInvalid({ CORS_ORIGIN: 'https://example.test/app' }, 'CORS_ORIGIN');
  assertInvalid({ CORS_ORIGIN: '*,https://example.test' }, 'CORS_ORIGIN');

  for (const key of [
    'RATE_LIMIT_MAX_REQUESTS',
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_EXPENSIVE_MAX',
    'RATE_LIMIT_LOGIN_MAX_REQUESTS',
    'RATE_LIMIT_LOGIN_WINDOW_MS',
  ]) {
    assertInvalid({ [key]: '10abc' }, key);
    assertInvalid({ [key]: '1e3' }, key);
    assertInvalid({ [key]: '0x10' }, key);
    assertInvalid({ [key]: ' 10 ' }, key);
  }
});

test('RetryHandler enforces the per-operation budget without real waits', async () => {
  let now = 0;
  const retry = new RetryHandler({
    get(key) {
      return {
        REQUEST_TIMEOUT: 1000,
        MAX_RETRIES: 1,
        INITIAL_BACKOFF: 100,
      }[key];
    },
  }, { warn() {}, error() {} }, { now: () => now });
  const waits = [];
  retry.sleep = async delay => {
    waits.push(delay);
    now += delay;
  };

  let attempts = 0;
  const originalRandom = Math.random;
  Math.random = () => 0;
  let result;
  try {
    result = await retry.execute(() => {
      attempts++;
      if (attempts === 1) throw new Error('temporary');
      return 'ok';
    });
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [100]);

  now = 0;
  const rateLimited = new RetryHandler({
    get(key) {
      return {
        REQUEST_TIMEOUT: 1000,
        MAX_RETRIES: 1,
        INITIAL_BACKOFF: 0,
      }[key];
    },
  }, { warn() {}, error() {} }, { now: () => now });
  rateLimited.sleep = async delay => { waits.push(delay); };
  attempts = 0;
  await assert.rejects(rateLimited.execute(() => {
    attempts++;
    throw Object.assign(new Error('limited'), { status: 429, headers: { 'retry-after': '2' } });
  }), { message: 'limited' });
  assert.equal(attempts, 1);

  const noRetries = new RetryHandler({
    get(key) {
      return { REQUEST_TIMEOUT: 1000, MAX_RETRIES: 0, INITIAL_BACKOFF: 0 }[key];
    },
  }, { warn() {}, error() {} }, { now: () => 0 });
  attempts = 0;
  await assert.rejects(noRetries.execute(() => {
    attempts++;
    throw new Error('once');
  }), { message: 'once' });
  assert.equal(attempts, 1);
});
