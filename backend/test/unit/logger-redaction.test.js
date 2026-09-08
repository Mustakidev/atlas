const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_MAX_DEPTH,
  REDACTED,
  redact,
  redactString,
} = require('../../src/logger/redaction');

test('redacts root secret keys and omits arbitrary nested objects', () => {
  const secret = 'do-not-retain';
  const result = redact({
    Password: secret,
    nested: {
      API_KEY: secret,
      safe: 'visible',
    },
    values: [{ token: secret }, 'safe'],
  });

  assert.equal(result.Password, REDACTED);
  assert.equal(result.nested, REDACTED);
  assert.equal(result.values[0], REDACTED);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('redacts embedded credentials, authorization values, and secret query values', () => {
  const value = 'https://user:password@example.test/path?token=abc&safe=ok';
  const result = redactString(`${value} Bearer bearer-secret Basic basic-secret Authorization: header-secret`);

  assert.equal(result.includes('user:password@'), false);
  assert.equal(result.includes('token=abc'), false);
  assert.equal(result.includes('Bearer bearer-secret'), false);
  assert.equal(result.includes('Basic basic-secret'), false);
  assert.equal(result.includes('Authorization: header-secret'), false);
  assert.equal(result.includes('safe=ok'), true);
});

test('redacts configured secret values embedded in ordinary strings', () => {
  const result = redactString('provider message contains private-value', ['private-value']);
  assert.equal(result, 'provider message contains [REDACTED]');
});

test('bounds recursive depth and object/array members', () => {
  const deep = { value: 'secret-at-depth' };
  for (let index = 0; index < DEFAULT_MAX_DEPTH + 2; index += 1) {
    deep.value = { value: deep.value };
  }

  const result = redact({ deep, array: Array.from({ length: 100 }, (_, index) => index) });
  assert.equal(JSON.stringify(result.deep).includes(REDACTED), true);
  assert.equal(result.array.length, 65);
  assert.equal(result.array[64], REDACTED);
});

test('normalizes errors without stack, cause, or nested internals', () => {
  const error = new Error('Bearer error-secret');
  error.code = 'E_TEST';
  error.cause = { password: 'secret' };
  const result = redact({ error });

  assert.deepEqual(result.error, {
    name: 'Error',
    code: 'E_TEST',
    message: 'Bearer [REDACTED]',
  });
  assert.equal(Object.hasOwn(result.error, 'stack'), false);
  assert.equal(Object.hasOwn(result.error, 'cause'), false);
});
