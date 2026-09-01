const assert = require('node:assert/strict');
const test = require('node:test');

const { createAuth } = require('../../src/middleware/auth');

const API_KEY = 'a'.repeat(32);

function config(apiKey) {
  return { get: () => apiKey };
}

function invoke(middleware, { path = '/market', headers = {} } = {}) {
  const logs = [];
  let nextCalled = false;
  let statusCode = 200;
  let body;
  const result = middleware(
    { path, headers, ip: '127.0.0.1' },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        body = value;
        return this;
      },
    },
    () => { nextCalled = true; },
  );

  return { result, logs, nextCalled, statusCode, body };
}

function logger(logs) {
  return {
    warn(module, message, data) {
      logs.push({ module, message, data });
    },
  };
}

test('missing, empty, and whitespace-only API_KEY cannot create pass-through auth', () => {
  for (const value of [undefined, '', ' '.repeat(32)]) {
    assert.throws(
      () => createAuth(config(value), logger([])),
      {
        name: 'TypeError',
        message: 'API_KEY must be configured before authentication middleware creation',
      },
    );
  }
});

test('missing X-API-Key returns the existing 401 contract', () => {
  const logs = [];
  const result = invoke(createAuth(config(API_KEY), logger(logs)));

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, {
    error: 'Authentication required',
    message: 'Missing X-API-Key header',
  });
  assert.equal(JSON.stringify(logs).includes(API_KEY), false);
});

test('invalid X-API-Key returns 401 without logging supplied credentials', () => {
  const supplied = 'recognizable-invalid-credential-123456';
  const logs = [];
  const result = invoke(createAuth(config(API_KEY), logger(logs)), {
    headers: { 'x-api-key': supplied },
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, {
    error: 'Authentication required',
    message: 'Invalid API key',
  });
  assert.equal(JSON.stringify(result.body).includes(supplied), false);
  assert.equal(JSON.stringify(logs).includes(supplied), false);
  assert.equal(JSON.stringify(logs).includes(API_KEY), false);
});

test('valid X-API-Key reaches the protected route', () => {
  const result = invoke(createAuth(config(API_KEY), logger([])), {
    headers: { 'x-api-key': API_KEY },
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, undefined);
});

test('/status is no longer an authentication bypass', () => {
  const result = invoke(createAuth(config(API_KEY), logger([])), { path: '/status' });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.message, 'Missing X-API-Key header');
});
