const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createApp, createErrorHandler } = require('../../src/app');
const { createLifecycleController } = require('../../src/core/lifecycleController');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { cloneFixture, validMarketSnapshot } = require('../fixtures/market');

const API_KEY = 'integration-test-api-key-32-characters';
const ALLOWED_ORIGIN = 'http://allowed.test';
const ATLAS_ORIGIN = 'http://127.0.0.1';
const OPERATOR_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';
const OPERATOR_PASSWORD = 'correct horse battery staple';

function config(state = {}) {
  const values = {
    API_KEY,
    ATLAS_OPERATOR_PASSWORD_HASH: OPERATOR_HASH,
    ATLAS_ORIGIN,
    ATLAS_COOKIE_SECURE: false,
    CORS_ORIGIN: ALLOWED_ORIGIN,
    MAX_BODY_SIZE: '1mb',
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX_REQUESTS: 1000,
    RATE_LIMIT_EXPENSIVE_MAX: 1000,
    RATE_LIMIT_LOGIN_MAX_REQUESTS: 10,
    RATE_LIMIT_LOGIN_WINDOW_MS: 15 * 60 * 1000,
    PORT: 3000,
    REFRESH_INTERVAL: 2000,
    CACHE_TTL: 30000,
    MAX_HISTORY: 500,
    LOG_LEVEL: 'INFO',
    REQUEST_TIMEOUT: 10000,
    MAX_RETRIES: 5,
    INITIAL_BACKOFF: 1000,
    ...state.configValues,
  };

  return {
    get(key) { return values[key]; },
    getAll() { return values; },
  };
}

function logger(state) {
  return {
    info() {},
    warn() {},
    error(module, message, data) {
      state.errors = state.errors || [];
      state.errors.push({ module, message, data });
    },
    system() {},
    getHealth() { return state.auditHealth; },
    getLogs(limit) { return (state.auditEvents || []).slice(-limit); },
    record(event) {
      state.auditEvents = state.auditEvents || [];
      state.auditEvents.push(event);
      if (state.auditFailure && (event.durability === 'DURABLE_CRITICAL' || state.auditFailure === 'all')) {
        return Promise.reject(new Error('controlled audit failure'));
      }
      return Promise.resolve({ status: event.durability === 'DURABLE_CRITICAL' ? 'DURABLE_CRITICAL_CERTIFIED' : 'DURABLE_ASYNC_ACCEPTED' });
    },
  };
}

function createTestApp(state) {
  const snapshot = cloneFixture(validMarketSnapshot());
  const testLogger = logger(state);
  const testConfig = config(state);
  const advanceRiskEngine = state.disableAdvanceRisk ? null : new AdvanceRiskEngine({
    logger: testLogger,
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: testConfig,
    clock: {
      nowMs: () => Date.parse('2024-01-01T00:00:00.000Z'),
      monotonicMs: () => 0,
    },
  });
  if (advanceRiskEngine) {
    state.advanceRiskEngine = advanceRiskEngine;
    const onTradeClosed = advanceRiskEngine.onTradeClosed.bind(advanceRiskEngine);
    advanceRiskEngine.onTradeClosed = (pnl, context) => {
      state.riskClosures = state.riskClosures || [];
      state.riskClosures.push({ pnl, context });
      if (state.throwRisk) throw new Error('controlled risk synchronization failure');
      return onTradeClosed(pnl, context);
    };
  }
  const deps = {
    apiManager: {
      isConnected: () => true,
      getHealth: () => {
        if (state.throwHealth) throw new Error(state.errorMessage);
        return { connected: true, consecutiveFailures: 0 };
      },
    },
    history: {
      latest: () => {
        if (state.throwHistory) throw new Error(state.errorMessage);
        return cloneFixture(snapshot);
      },
      last: () => [cloneFixture(snapshot)],
      size: () => 1,
    },
    analyzer: { getAnalysis: () => null },
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => [],
      getActive: () => null,
    },
    logger: testLogger,
    config: testConfig,
    eventBus: {},
    cache: { getAge: () => 100 },
    indicatorRegistry: {
      has: () => false,
      getNames: () => [],
      calculateAll: () => ({}),
    },
    structureEngine: null,
    confluenceEngine: null,
    validationEngine: null,
    mtfEngine: null,
    macdEngine: null,
    atrEngine: null,
    bollingerEngine: null,
    signalHistoryEngine: null,
    backtestEngine: null,
    analyticsEngine: null,
    paperTradeEngine: state.disablePaperTrade ? null : {
      open: () => [],
      history: () => [],
      stats: () => ({ totalTrades: 0, openTrades: 0, closedTrades: 0 }),
      performance: () => ({ profitFactor: 0 }),
      getBalance: () => 10000,
      close: (tradeId, reason) => {
        state.closeRequest = { tradeId, reason };
        state.closeCalls = state.closeCalls || [];
        state.closeCalls.push({ tradeId, reason });
        const result = Array.isArray(state.closeResults)
          ? state.closeResults.shift()
          : Object.hasOwn(state, 'closeResult')
            ? state.closeResult
            : {
              tradeId,
              reason,
              status: 'CLOSED',
              pnl: 25,
              exitTime: '2024-01-01T00:00:00.000Z',
            };
        if (result) state.paperClosed = true;
        return result;
      },
    },
    regimeEngine: null,
    regimeDecisionEngine: null,
    advanceRiskEngine,
    mtfConfirmationEngine: null,
    symbol: 'BTCUSDT',
  };

  return createApp({
    config: deps.config,
    logger: deps.logger,
    routes: deps,
    getLastDecision: () => null,
    getPipelineHealth: () => ({ pipelineCycleCount: 0, pipelineErrors: 0 }),
    lifecycle: state.lifecycle,
    liveRuntime: state.liveRuntime,
  });
}

function request(server, { method = 'GET', path, headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined
      ? rawBody
      : body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path,
      headers: {
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
        ...headers,
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: data,
        json: () => JSON.parse(data),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startApp(state) {
  const server = http.createServer(createTestApp(state));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function stopApp(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function sessionCookie(result) {
  return result.headers['set-cookie'][0].split(';', 1)[0];
}

test('real Express app serves the public health endpoint without authentication', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, { path: '/healthz' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { status: 'ok' });
  } finally {
    await stopApp(server);
  }
});

test('entity-too-large JSON bodies use the stable 413 contract', async () => {
  const server = await startApp({ configValues: { MAX_BODY_SIZE: '1kb' } });
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/auth/login',
      rawBody: 'x'.repeat(2048),
      headers: { origin: ATLAS_ORIGIN },
    });

    assert.equal(result.statusCode, 413);
    assert.deepEqual(result.json(), {
      error: 'Request body too large',
      code: 'REQUEST_BODY_TOO_LARGE',
    });
  } finally {
    await stopApp(server);
  }
});

test('lifecycle gate rejects new unsafe work after shutdown while exposing health state', async () => {
  const exits = [];
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
    forceExit: code => exits.push(code),
  });
  lifecycle.markRunning();
  const server = await startApp({ lifecycle });

  try {
    await lifecycle.shutdown('test');

    const close = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'PT-1' },
    });
    assert.equal(close.statusCode, 503);
    assert.deepEqual(close.json(), { error: 'Server shutting down' });

    const health = await request(server, { path: '/healthz' });
    assert.equal(health.statusCode, 503);
    assert.deepEqual(health.json(), { status: 'stopped', lifecycle: 'STOPPED' });
    assert.deepEqual(exits, []);
  } finally {
    await stopApp(server);
  }
});

test('/readyz becomes unavailable when lifecycle shutdown begins', async () => {
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
  });
  lifecycle.markRunning();
  const liveRuntime = {
    getStatus: () => ({ effectiveState: 'READY', durabilityHealthy: true }),
  };
  const server = await startApp({ lifecycle, liveRuntime });

  try {
    assert.equal((await request(server, { path: '/readyz' })).statusCode, 200);
    await lifecycle.shutdown('test');
    const ready = await request(server, { path: '/readyz' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { status: 'not_ready', liveState: 'READY' });
  } finally {
    await stopApp(server);
  }
});

test('/readyz separates audit health from live-state durability', async () => {
  const lifecycle = createLifecycleController({
    logger: { info() {}, warn() {}, error() {}, system() {} },
  });
  lifecycle.markRunning();
  const server = await startApp({
    auditHealth: 'UNSAFE',
    lifecycle,
    liveRuntime: {
      getStatus: () => ({ effectiveState: 'READY', durabilityHealthy: true }),
    },
  });
  try {
    const ready = await request(server, { path: '/readyz' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), {
      status: 'not_ready',
      liveState: 'READY',
      auditState: 'UNSAFE',
      auditStateHealthy: false,
    });
  } finally {
    await stopApp(server);
  }
});

test('root HTML contains no browser API-key bootstrap', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, { path: '/' });

    assert.equal(result.statusCode, 200);
    assert.equal(result.text.includes(API_KEY), false);
    assert.equal(result.text.includes('window.__ATLAS_API_KEY'), false);
  } finally {
    await stopApp(server);
  }
});

test('session status is public, generic, and never API-key based', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, { path: '/api/auth/session', headers: { 'x-api-key': API_KEY } });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { authenticated: false });
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['set-cookie'][0], /^atlas_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/);
  } finally {
    await stopApp(server);
  }
});

test('session status clears a stale cookie after session-store reconstruction', async () => {
  const firstServer = await startApp({});
  let secondServer;
  let firstStopped = false;
  try {
    const login = await request(firstServer, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: ATLAS_ORIGIN },
      body: { password: OPERATOR_PASSWORD },
    });
    const oldCookie = sessionCookie(login);
    await stopApp(firstServer);
    firstStopped = true;

    secondServer = await startApp({});
    const result = await request(secondServer, {
      path: '/api/auth/session',
      headers: { cookie: oldCookie },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { authenticated: false });
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['set-cookie'][0], /^atlas_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/);
  } finally {
    if (secondServer) await stopApp(secondServer);
    if (!firstStopped) await stopApp(firstServer);
  }
});

test('malformed login JSON keeps the parser error and no-store policy', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: ATLAS_ORIGIN, 'content-type': 'application/json' },
      rawBody: '{invalid}',
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.json(), { error: 'Invalid JSON payload' });
    assert.equal(result.headers['cache-control'], 'no-store');
  } finally {
    await stopApp(server);
  }
});

test('global rate-limit rejection for auth routes keeps no-store policy', async () => {
  const server = await startApp({ configValues: { RATE_LIMIT_MAX_REQUESTS: 1 } });
  try {
    const first = await request(server, { path: '/api/auth/session' });
    const second = await request(server, { path: '/api/auth/session' });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 429);
    assert.equal(second.headers['cache-control'], 'no-store');
  } finally {
    await stopApp(server);
  }
});

test('login rejects wrong origin before validation or password verification', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: 'https://attacker.test' },
      body: {},
    });

    assert.equal(result.statusCode, 403);
    assert.deepEqual(result.json(), { error: 'Forbidden', message: 'Origin not allowed' });
  } finally {
    await stopApp(server);
  }
});

test('login validates password shape and rejects incorrect credentials generically', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    for (const body of [{}, { password: '' }, { password: ' '.repeat(3) }, { password: 42 }]) {
      const result = await request(server, {
        method: 'POST',
        path: '/api/auth/login',
        headers: { origin: ATLAS_ORIGIN },
        body,
      });
      assert.equal(result.statusCode, 400);
      assert.deepEqual(result.json(), { error: 'Invalid login request', message: 'Invalid password' });
    }

    const wrong = await request(server, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: ATLAS_ORIGIN },
      body: { password: 'wrong password' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), { error: 'Authentication failed', message: 'Invalid credentials' });
    assert.equal(wrong.headers['set-cookie'], undefined);
    assert.equal(JSON.stringify(wrong).includes(OPERATOR_PASSWORD), false);
    assert.ok(state.auditEvents?.some(event => event.event === 'AUTH_LOGIN_FAILED'));
  } finally {
    await stopApp(server);
  }
});

test('valid login creates an HttpOnly session and protected APIs accept it', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const login = await request(server, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: ATLAS_ORIGIN },
      body: { password: OPERATOR_PASSWORD },
    });
    assert.equal(login.statusCode, 204);
    assert.equal(login.headers['cache-control'], 'no-store');
    assert.match(login.headers['set-cookie'][0], /^atlas_session=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=\/; HttpOnly; SameSite=Strict$/);

    const cookie = sessionCookie(login);
    const session = await request(server, { path: '/api/auth/session', headers: { cookie } });
    assert.deepEqual(session.json(), { authenticated: true });
    assert.equal(session.headers['set-cookie'], undefined);

    const status = await request(server, { path: '/api/status', headers: { cookie } });
    assert.equal(status.statusCode, 200);
    assert.equal(typeof status.json().uptime, 'number');
    assert.equal(state.auditEvents.filter(event => event.event === 'AUTH_LOGIN_SUCCEEDED').length, 1);
  } finally {
    await stopApp(server);
  }
});

test('successful login fails closed when critical audit certification fails', async () => {
  const server = await startApp({ auditFailure: 'all' });
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: ATLAS_ORIGIN },
      body: { password: OPERATOR_PASSWORD },
    });
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.json(), { error: 'Audit durability unavailable', code: 'AUDIT_UNSAFE' });
    assert.equal(result.headers['set-cookie'], undefined);
  } finally {
    await stopApp(server);
  }
});

test('invalid credentials remain 401 when audit logging fails', async () => {
  const server = await startApp({ auditFailure: 'all' });
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: ATLAS_ORIGIN },
      body: { password: 'wrong password' },
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['set-cookie'], undefined);
  } finally {
    await stopApp(server);
  }
});

test('missing, malformed, and invalid session cookies fail protected APIs generically', async () => {
  const server = await startApp({});
  try {
    for (const cookie of [undefined, 'atlas_session=bad', 'atlas_session=' + 'a'.repeat(42)]) {
      const headers = cookie ? { cookie } : {};
      const result = await request(server, { path: '/api/status', headers });
      assert.equal(result.statusCode, 401);
      assert.deepEqual(result.json(), { error: 'Authentication required', message: 'Authentication required' });
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.match(result.headers['set-cookie'][0], /^atlas_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/);
    }
  } finally {
    await stopApp(server);
  }
});

test('credential precedence rejects invalid explicit API keys without session fallback', async () => {
  const server = await startApp({});
  try {
    const login = await request(server, {
      method: 'POST', path: '/api/auth/login', headers: { origin: ATLAS_ORIGIN }, body: { password: OPERATOR_PASSWORD },
    });
    const cookie = sessionCookie(login);
    const invalidKey = await request(server, {
      path: '/api/status', headers: { cookie, 'x-api-key': 'invalid-api-key' },
    });
    assert.equal(invalidKey.statusCode, 401);
    assert.equal(invalidKey.json().message, 'Invalid API key');
    assert.equal(invalidKey.headers['cache-control'], 'no-store');
    assert.equal(invalidKey.headers['set-cookie'], undefined);

    const validKey = await request(server, {
      path: '/api/status', headers: { cookie: 'atlas_session=invalid', 'x-api-key': API_KEY },
    });
    assert.equal(validKey.statusCode, 200);
  } finally {
    await stopApp(server);
  }
});

test('session-authenticated mutation requires exact Origin before state mutation', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const login = await request(server, {
      method: 'POST', path: '/api/auth/login', headers: { origin: ATLAS_ORIGIN }, body: { password: OPERATOR_PASSWORD },
    });
    const cookie = sessionCookie(login);
    for (const origin of [undefined, 'null', 'https://attacker.test']) {
      const result = await request(server, {
        method: 'POST',
        path: '/api/paper-trades/close',
        headers: { cookie, ...(origin === undefined ? {} : { origin }) },
        body: { tradeId: 'T-1' },
      });
      assert.equal(result.statusCode, 403);
    }
    assert.equal(state.closeCalls?.length || 0, 0);
    assert.equal(state.riskClosures?.length || 0, 0);
  } finally {
    await stopApp(server);
  }
});

test('logout is idempotent, clears the session cookie, and invalidates access', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const login = await request(server, {
      method: 'POST', path: '/api/auth/login', headers: { origin: ATLAS_ORIGIN }, body: { password: OPERATOR_PASSWORD },
    });
    const cookie = sessionCookie(login);
    const logout = await request(server, { method: 'POST', path: '/api/auth/logout', headers: { origin: ATLAS_ORIGIN, cookie } });
    assert.equal(logout.statusCode, 204);
    assert.equal(logout.headers['cache-control'], 'no-store');
    assert.match(logout.headers['set-cookie'][0], /^atlas_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/);

    const status = await request(server, { path: '/api/status', headers: { cookie } });
    assert.equal(status.statusCode, 401);

    const noSessionLogout = await request(server, { method: 'POST', path: '/api/auth/logout', headers: { origin: ATLAS_ORIGIN } });
    assert.equal(noSessionLogout.statusCode, 204);
    assert.ok(state.auditEvents.some(event => event.event === 'AUTH_LOGOUT'));
  } finally {
    await stopApp(server);
  }
});

test('logout remains effective when audit logging fails', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const login = await request(server, {
      method: 'POST', path: '/api/auth/login', headers: { origin: ATLAS_ORIGIN }, body: { password: OPERATOR_PASSWORD },
    });
    const cookie = sessionCookie(login);
    state.auditFailure = 'all';
    const logout = await request(server, { method: 'POST', path: '/api/auth/logout', headers: { origin: ATLAS_ORIGIN, cookie } });
    assert.equal(logout.statusCode, 204);
    assert.equal((await request(server, { path: '/api/status', headers: { cookie } })).statusCode, 401);
  } finally {
    await stopApp(server);
  }
});

test('/api/logs uses bounded redacted memory records', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const result = await request(server, { path: '/api/logs?limit=999999', headers: { 'x-api-key': API_KEY } });
    assert.equal(result.statusCode, 200);
    assert.ok(result.json().count <= 100);
    assert.ok(Array.isArray(result.json().logs));
  } finally {
    await stopApp(server);
  }
});

test('login rate limiting is dedicated and IP-based', async () => {
  const server = await startApp({ configValues: { RATE_LIMIT_LOGIN_MAX_REQUESTS: 1 } });
  try {
    const first = await request(server, {
      method: 'POST', path: '/api/auth/login', headers: { origin: ATLAS_ORIGIN }, body: { password: 'wrong password' },
    });
    const second = await request(server, {
      method: 'POST', path: '/api/auth/login', headers: { origin: ATLAS_ORIGIN }, body: { password: 'wrong password' },
    });
    assert.equal(first.statusCode, 401);
    assert.equal(second.statusCode, 429);
  } finally {
    await stopApp(server);
  }
});

test('real Express app protects the operational status endpoint', async () => {
  const server = await startApp({});
  try {
    const missing = await request(server, { path: '/api/status' });
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(missing.json(), {
      error: 'Authentication required',
      message: 'Authentication required',
    });

    const valid = await request(server, {
      path: '/api/status',
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(valid.statusCode, 200);
    assert.equal(typeof valid.json().uptime, 'number');
  } finally {
    await stopApp(server);
  }
});

test('real Express app rejects protected endpoints without an API key', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, { path: '/api/market' });

    assert.equal(result.statusCode, 401);
    assert.equal(result.json().error, 'Authentication required');
  } finally {
    await stopApp(server);
  }
});

test('real Express app accepts a valid API key and returns the market contract', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.json().symbol, 'BTCUSDT');
    assert.equal(result.json().connected, true);
  } finally {
    await stopApp(server);
  }
});

test('CORS runs before authentication for allowed origins', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { origin: ALLOWED_ORIGIN },
    });

    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  } finally {
    await stopApp(server);
  }
});

test('CORS with a disallowed origin does not grant an allow-origin header', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/healthz',
      headers: { origin: 'http://blocked.test' },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  } finally {
    await stopApp(server);
  }
});

test('JSON parsing occurs before protected route authentication', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      rawBody: '{invalid}',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(result.statusCode, 400);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Invalid JSON payload' });
  } finally {
    await stopApp(server);
  }
});

test('JSON parsing reaches a protected endpoint after authentication', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'T-1', reason: 'Integration test' },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(state.closeRequest, { tradeId: 'T-1', reason: 'Integration test' });
    assert.equal(state.advanceRiskEngine.getDailyPnL(), 25);
    assert.equal(state.advanceRiskEngine.getConsecutiveLosses(), 0);
    assert.deepEqual(state.riskClosures, [{
      pnl: 25,
      context: { nowMs: Date.parse('2024-01-01T00:00:00.000Z') },
    }]);
    assert.deepEqual(result.json(), {
      tradeId: 'T-1',
      reason: 'Integration test',
      status: 'CLOSED',
      pnl: 25,
      exitTime: '2024-01-01T00:00:00.000Z',
    });
  } finally {
    await stopApp(server);
  }
});

test('unauthenticated manual close cannot mutate paper or risk state', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      body: { tradeId: 'T-1' },
    });

    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), {
      error: 'Authentication required',
      message: 'Authentication required',
    });
    assert.equal(state.closeCalls?.length || 0, 0);
    assert.equal(state.riskClosures?.length || 0, 0);
  } finally {
    await stopApp(server);
  }
});

test('manual close with a missing tradeId does not notify risk', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: {},
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.json(), { error: 'tradeId is required' });
    assert.equal(state.closeCalls?.length || 0, 0);
    assert.equal(state.riskClosures?.length || 0, 0);
  } finally {
    await stopApp(server);
  }
});

test('manual close of an unknown trade preserves 404 and does not notify risk', async () => {
  const state = { closeResult: null };
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'missing' },
    });

    assert.equal(result.statusCode, 404);
    assert.deepEqual(result.json(), { error: 'Trade not found or already closed' });
    assert.equal(state.closeCalls.length, 1);
    assert.equal(state.riskClosures?.length || 0, 0);
  } finally {
    await stopApp(server);
  }
});

test('repeated manual close notifies risk only for the first closure', async () => {
  const state = {
    closeResults: [
      { tradeId: 'T-1', reason: 'Manual', status: 'CLOSED', pnl: -25, exitTime: '2024-01-01T00:00:00.000Z' },
      null,
    ],
  };
  const server = await startApp(state);
  try {
    const first = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'T-1' },
    });
    const second = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'T-1' },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 404);
    assert.equal(state.riskClosures.length, 1);
    assert.equal(state.advanceRiskEngine.getDailyPnL(), -25);
    assert.equal(state.advanceRiskEngine.getConsecutiveLosses(), 1);
    assert.equal(state.advanceRiskEngine.isRiskStateHealthy(), true);
    assert.deepEqual(state.riskClosures[0], {
      pnl: -25,
      context: { nowMs: Date.parse('2024-01-01T00:00:00.000Z') },
    });
  } finally {
    await stopApp(server);
  }
});

test('malformed manual close snapshots fail and latch risk for invalid synchronization fields', async () => {
  for (const closeResult of [
    { tradeId: 'T-1', status: 'OPEN', pnl: 25, exitTime: '2024-01-01T00:00:00.000Z' },
    { tradeId: 'T-1', status: 'CLOSED', pnl: NaN, exitTime: '2024-01-01T00:00:00.000Z' },
    { tradeId: 'T-1', status: 'CLOSED', pnl: 25, exitTime: 'not-a-date' },
    { tradeId: 'T-1', status: 'OPEN', pnl: NaN, exitTime: 'not-a-date' },
  ]) {
    const state = { closeResult };
    const server = await startApp(state);
    try {
      const result = await request(server, {
        method: 'POST',
        path: '/api/paper-trades/close',
        headers: { 'x-api-key': API_KEY },
        body: { tradeId: 'T-1' },
      });

      assert.equal(result.statusCode, 500);
      assert.deepEqual(result.json(), { error: 'Internal server error' });
      assert.equal(state.riskClosures?.length || 0, 0);
      assert.equal(state.advanceRiskEngine.isRiskStateHealthy(), false);
      const riskResult = state.advanceRiskEngine.evaluate({
        symbol: 'BTCUSDT',
        timeframe: '1h',
        entryPrice: 100,
        atr: { ready: true, atr: 2, atrPercentage: 1 },
        direction: 'BUY',
        trend: null,
        structure: null,
        confluence: { confidence: 80 },
        regime: 'TRENDING_BULL',
      });
      assert.equal(riskResult.tradeAllowed, false);
      assert.equal(riskResult.rejectionReason, 'RISK_STATE_UNHEALTHY');
      assert.equal(state.paperClosed, true);
    } finally {
      await stopApp(server);
    }
  }
});

test('risk synchronization failure returns generic error without reopening the trade', async () => {
  const state = { throwRisk: true };
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'T-1' },
    });

    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(state.paperClosed, true);
    assert.equal(state.riskClosures.length, 1);
  } finally {
    await stopApp(server);
  }
});

test('manual close preflights the canonical risk dependency', async () => {
  for (const [state, expectedError] of [
    [{ disableAdvanceRisk: true }, 'Advance Risk engine not available'],
    [{ disablePaperTrade: true }, 'Paper trading engine not available'],
  ]) {
    const server = await startApp(state);
    try {
      const result = await request(server, {
        method: 'POST',
        path: '/api/paper-trades/close',
        headers: { 'x-api-key': API_KEY },
        body: { tradeId: 'T-1' },
      });

      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.json(), { error: expectedError });
      assert.equal(state.closeCalls?.length || 0, 0);
      assert.equal(state.paperClosed, undefined);
      assert.equal(state.riskClosures?.length || 0, 0);
    } finally {
      await stopApp(server);
    }
  }
});

test('missing tradeId wins before unavailable close dependencies', async () => {
  const state = { disablePaperTrade: true };
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      headers: { 'x-api-key': API_KEY },
      body: {},
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.json(), { error: 'tradeId is required' });
    assert.equal(state.closeCalls?.length || 0, 0);
    assert.equal(state.riskClosures?.length || 0, 0);
  } finally {
    await stopApp(server);
  }
});

test('retired risk route returns the default authenticated 404', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/risk?entryPrice=100&direction=BUY',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 404);
    assert.match(result.headers['content-type'], /^text\/html; charset=utf-8/);
    assert.match(result.text, /Cannot GET \/api\/risk/);
  } finally {
    await stopApp(server);
  }
});

test('real Express app preserves representative route errors', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { 'x-api-key': 'wrong-key' },
    });

    assert.equal(result.statusCode, 401);
    assert.equal(result.json().message, 'Invalid API key');
  } finally {
    await stopApp(server);
  }
});

test('synchronous route throws use the generic JSON 500 boundary', async () => {
  const errors = [];
  const app = express();
  app.get('/sync-throw', () => {
    throw new Error('secret direct route failure /repository/backend/src/app.js:321');
  });
  app.use(createErrorHandler({
    error(module, message, data) {
      errors.push({ module, message, data });
    },
  }));

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const result = await request(server, { path: '/sync-throw' });

    assert.equal(result.statusCode, 500);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(result.text.includes('secret direct route failure'), false);
    assert.ok(errors.some(entry => entry.data.category === 'unhandled'));
  } finally {
    await stopApp(server);
  }
});

test('synchronous dependency failures return a generic JSON 500 and preserve process health', async () => {
  const state = {
    throwHistory: true,
    errorMessage: 'secret /repository/backend/src/routes/routes.js:123',
  };
  const server = await startApp(state);
  try {
    const result = await request(server, {
      path: '/api/market',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 500);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Internal server error' });
    assert.equal(result.text.includes('<html'), false);
    assert.equal(result.text.includes('secret'), false);
    assert.equal(result.text.includes('routes.js'), false);
    assert.equal(result.text.includes('/repository/'), false);
    assert.equal(result.text.includes('Error:'), false);
    assert.ok(state.errors.some(entry => (
      entry.module === 'ErrorBoundary'
      && entry.data.path === '/api/market'
      && entry.data.status === 500
      && entry.data.category === 'unhandled'
    )));

    state.throwHistory = false;
    const health = await request(server, {
      path: '/api/status',
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(health.statusCode, 200);
  } finally {
    await stopApp(server);
  }
});

test('malformed JSON returns the exact controlled JSON contract', async () => {
  const state = {};
  const server = await startApp(state);
  try {
    const result = await request(server, {
      method: 'POST',
      path: '/api/paper-trades/close',
      rawBody: '{invalid}',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(result.statusCode, 400);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(result.json(), { error: 'Invalid JSON payload' });
    assert.ok(state.errors.some(entry => (
      entry.data.category === 'malformed-json' && entry.data.status === 400
    )));
  } finally {
    await stopApp(server);
  }
});

test('validation errors remain explicit 400 responses', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/candles?timeframe=invalid',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.json(), { error: 'Invalid timeframe', supported: ['1h'] });
  } finally {
    await stopApp(server);
  }
});

test('rate limiting remains an explicit 429 response', async () => {
  const server = await startApp({ configValues: { RATE_LIMIT_MAX_REQUESTS: 1 } });
  try {
    const first = await request(server, { path: '/healthz' });
    const second = await request(server, { path: '/healthz' });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error, 'Rate limit exceeded');
  } finally {
    await stopApp(server);
  }
});

test('authentication precedes the expensive-route limiter', async () => {
  const server = await startApp({ configValues: { RATE_LIMIT_EXPENSIVE_MAX: 1 } });
  try {
    const missing = await request(server, { path: '/api/backtest?timeframe=1h' });
    assert.equal(missing.statusCode, 401);

    const valid = await request(server, {
      path: '/api/backtest?timeframe=1h',
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(valid.statusCode, 503);
    assert.equal(valid.json().error, 'Backtest engine not available');
  } finally {
    await stopApp(server);
  }
});

test('unknown routes preserve the existing 404 behavior', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/does-not-exist',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 404);
    assert.match(result.text, /Cannot GET \/api\/does-not-exist/);
  } finally {
    await stopApp(server);
  }
});

test('/api/config remains a successful 200 response', async () => {
  const server = await startApp({});
  try {
    const result = await request(server, {
      path: '/api/config',
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(result.statusCode, 200);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.equal(result.json().port, 3000);
  } finally {
    await stopApp(server);
  }
});

test('headers-sent errors delegate to Express without a second write', () => {
  const errors = [];
  const logger = {
    error(module, message, data) {
      errors.push({ module, message, data });
    },
  };
  const error = new Error('secret internal failure');
  const nextCalls = [];
  const res = {
    headersSent: true,
    status() {
      throw new Error('headers-sent handler attempted a second write');
    },
    json() {
      throw new Error('headers-sent handler attempted a second write');
    },
  };

  createErrorHandler(logger)(error, {
    method: 'GET',
    path: '/api/partial',
  }, res, forwardedError => nextCalls.push(forwardedError));

  assert.deepEqual(nextCalls, [error]);
  assert.deepEqual(errors, [{
    module: 'ErrorBoundary',
    message: 'Request error',
    data: {
      method: 'GET',
      path: '/api/partial',
      status: 500,
      category: 'unhandled',
    },
  }]);
});
