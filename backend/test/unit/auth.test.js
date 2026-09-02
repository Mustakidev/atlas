const assert = require('node:assert/strict');
const test = require('node:test');

const { createAuth, createSessionOriginGuard } = require('../../src/middleware/auth');
const { SingleOperatorSessionStore } = require('../../src/auth/sessionStore');

const API_KEY = 'a'.repeat(32);
const ORIGIN = 'http://127.0.0.1:3000';

function config(apiKey) {
  const values = {
    API_KEY: arguments.length === 0 ? API_KEY : apiKey,
    ATLAS_ORIGIN: ORIGIN,
    ATLAS_COOKIE_SECURE: false,
  };
  return { get: key => values[key] };
}

function invoke(middleware, { path = '/market', method = 'GET', headers = {}, auth } = {}) {
  const logs = [];
  let nextCalled = false;
  let statusCode = 200;
  let body;
  const responseHeaders = {};
  const request = { path, method, headers, ip: '127.0.0.1', auth };
  const result = middleware(
    request,
    {
      set(name, value) {
        responseHeaders[name.toLowerCase()] = value;
        return this;
      },
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

  return { result, logs, nextCalled, statusCode, body, request, responseHeaders };
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

test('missing credentials return a generic browser-safe 401 contract', () => {
  const logs = [];
  const result = invoke(createAuth(config(), logger(logs), { sessionStore: new SingleOperatorSessionStore() }));

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, {
    error: 'Authentication required',
    message: 'Authentication required',
  });
  assert.equal(result.responseHeaders['cache-control'], 'no-store');
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
  assert.equal(result.responseHeaders['cache-control'], 'no-store');
  assert.equal(JSON.stringify(result.body).includes(supplied), false);
  assert.equal(JSON.stringify(logs).includes(supplied), false);
  assert.equal(JSON.stringify(logs).includes(API_KEY), false);
});

test('valid X-API-Key reaches the protected route', () => {
  const result = invoke(createAuth(config(), logger([]), { sessionStore: new SingleOperatorSessionStore() }), {
    headers: { 'x-api-key': API_KEY },
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, undefined);
});

test('valid session cookie reaches the protected route with operator context', () => {
  const sessionStore = new SingleOperatorSessionStore();
  const issued = sessionStore.issue();
  const result = invoke(createAuth(config(), logger([]), { sessionStore }), {
    headers: { cookie: `atlas_session=${issued.token}` },
  });

  assert.equal(result.nextCalled, true);
  assert.deepEqual(result.request.auth, { type: 'session', principal: 'operator' });
});

test('invalid explicit X-API-Key does not fall back to a valid session', () => {
  const sessionStore = new SingleOperatorSessionStore();
  const issued = sessionStore.issue();
  const result = invoke(createAuth(config(), logger([]), { sessionStore }), {
    headers: {
      'x-api-key': 'invalid-api-key',
      cookie: `atlas_session=${issued.token}`,
    },
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.message, 'Invalid API key');
  assert.equal(result.responseHeaders['cache-control'], 'no-store');
  assert.equal(result.responseHeaders['set-cookie'], undefined);
});

test('valid API key takes precedence over an invalid session cookie', () => {
  const result = invoke(createAuth(config(), logger([]), { sessionStore: new SingleOperatorSessionStore() }), {
    headers: { 'x-api-key': API_KEY, cookie: 'atlas_session=invalid' },
  });

  assert.equal(result.nextCalled, true);
});

test('/status is no longer an authentication bypass', () => {
  const result = invoke(createAuth(config(), logger([]), { sessionStore: new SingleOperatorSessionStore() }), { path: '/status' });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.message, 'Authentication required');
});

test('session-origin guard allows same-origin unsafe requests', () => {
  const result = invoke(createSessionOriginGuard(config()), {
    method: 'POST',
    headers: { origin: ORIGIN },
    auth: { type: 'session', principal: 'operator' },
  });
  assert.equal(result.nextCalled, true);
});

test('session-origin guard rejects missing and wrong origins', () => {
  for (const origin of [undefined, 'null', 'https://attacker.test']) {
    let nextCalled = false;
    let statusCode = 200;
    const middleware = createSessionOriginGuard(config());
    middleware(
      { method: 'POST', headers: origin === undefined ? {} : { origin }, auth: { type: 'session' } },
      { status(code) { statusCode = code; return this; }, json() { return this; } },
      () => { nextCalled = true; },
    );
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  }
});

test('API-key unsafe requests do not require browser Origin', () => {
  let nextCalled = false;
  createSessionOriginGuard(config())(
    { method: 'POST', headers: {}, auth: { type: 'apiKey' } },
    { status() { return this; }, json() { return this; } },
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
});

test('session authentication failure clears the cookie with configured Secure behavior', () => {
  for (const secure of [false, true]) {
    const sessionStore = { lookup: () => null };
    const result = invoke(createAuth({
      get(key) {
        return key === 'ATLAS_COOKIE_SECURE' ? secure : config().get(key);
      },
    }, logger([]), { sessionStore }), {
      headers: { cookie: `atlas_session=${'a'.repeat(43)}` },
    });

    assert.equal(result.statusCode, 401);
    assert.match(result.responseHeaders['set-cookie'], /^atlas_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict(?:; Secure)?; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/);
    assert.equal(result.responseHeaders['set-cookie'].includes('; Secure'), secure);
  }
});
