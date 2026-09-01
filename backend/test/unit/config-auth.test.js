const assert = require('node:assert/strict');
const test = require('node:test');

const { ConfigManager } = require('../../src/config/config');

const VALID_KEY = 'a'.repeat(32);
const VALID_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';

function validationFor(apiKey) {
  const config = new ConfigManager();
  config.set('API_KEY', apiKey);
  config.set('ATLAS_OPERATOR_PASSWORD_HASH', VALID_HASH);
  config.set('ATLAS_ORIGIN', 'http://localhost:3000');
  config.set('ATLAS_COOKIE_SECURE', false);
  return { config, result: config.validate() };
}

function assertInvalid(apiKey, message) {
  const { result } = validationFor(apiKey);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.startsWith('API_KEY ')), message);
}

test('missing API_KEY is invalid', () => {
  assertInvalid(undefined, 'missing API_KEY must fail validation');
});

test('empty API_KEY is invalid', () => {
  assertInvalid('', 'empty API_KEY must fail validation');
});

test('whitespace-only API_KEY is invalid', () => {
  assertInvalid(' '.repeat(32), 'whitespace-only API_KEY must fail validation');
});

test('short API_KEY is invalid', () => {
  const { result } = validationFor('short-key');
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.filter(error => error.startsWith('API_KEY ')), [
    'API_KEY must be at least 32 characters, got: 9 characters',
  ]);
});

test('32-character API_KEY is accepted', () => {
  const { result } = validationFor(VALID_KEY);
  assert.equal(result.valid, true);
  assert.equal(result.errors.some(error => error.startsWith('API_KEY ')), false);
});

test('valid API_KEY whitespace is preserved and not silently trimmed', () => {
  const apiKey = ` ${VALID_KEY} `;
  const { config, result } = validationFor(apiKey);

  assert.equal(result.valid, true);
  assert.equal(config.get('API_KEY'), apiKey);
});

test('missing or malformed operator verifier is invalid', () => {
  for (const value of [undefined, '', 'scrypt$N=1$r=1$p=1$bad$bad']) {
    const config = new ConfigManager();
    config.set('API_KEY', VALID_KEY);
    config.set('ATLAS_OPERATOR_PASSWORD_HASH', value);
    config.set('ATLAS_ORIGIN', 'http://localhost:3000');
    config.set('ATLAS_COOKIE_SECURE', false);
    const result = config.validate();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.startsWith('ATLAS_OPERATOR_PASSWORD_HASH ')));
  }
});

test('origin validation rejects paths, queries, fragments, credentials, and unsupported schemes', () => {
  for (const origin of [undefined, '', 'ftp://localhost:3000', 'http://localhost:3000/app', 'http://localhost:3000/?x=1', 'http://localhost:3000/#x', 'http://user@localhost:3000', 'http://localhost:3000/']) {
    const config = new ConfigManager();
    config.set('API_KEY', VALID_KEY);
    config.set('ATLAS_OPERATOR_PASSWORD_HASH', VALID_HASH);
    config.set('ATLAS_ORIGIN', origin);
    config.set('ATLAS_COOKIE_SECURE', false);
    const result = config.validate();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.startsWith('ATLAS_ORIGIN ')));
  }
});

test('remote origins require HTTPS and Secure cookies', () => {
  for (const values of [
    { origin: 'http://atlas.example.com', secure: false },
    { origin: 'http://atlas.example.com', secure: true },
    { origin: 'https://atlas.example.com', secure: false },
  ]) {
    const config = new ConfigManager();
    config.set('API_KEY', VALID_KEY);
    config.set('ATLAS_OPERATOR_PASSWORD_HASH', VALID_HASH);
    config.set('ATLAS_ORIGIN', values.origin);
    config.set('ATLAS_COOKIE_SECURE', values.secure);
    assert.equal(config.validate().valid, false);
  }
});

test('local HTTP origin may use an insecure cookie only explicitly', () => {
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    const config = new ConfigManager();
    config.set('API_KEY', VALID_KEY);
    config.set('ATLAS_OPERATOR_PASSWORD_HASH', VALID_HASH);
    config.set('ATLAS_ORIGIN', origin);
    config.set('ATLAS_COOKIE_SECURE', false);
    assert.equal(config.validate().valid, true);
  }
});

test('cookie secure configuration accepts only booleans', () => {
  for (const value of [undefined, '', 'true', 'false', 'TRUE', 'yes', 1]) {
    const config = new ConfigManager();
    config.set('API_KEY', VALID_KEY);
    config.set('ATLAS_OPERATOR_PASSWORD_HASH', VALID_HASH);
    config.set('ATLAS_ORIGIN', 'http://localhost:3000');
    config.set('ATLAS_COOKIE_SECURE', value);
    const result = config.validate();
    assert.equal(result.valid, value === false || value === true);
  }
});
