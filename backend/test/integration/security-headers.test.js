const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createApp } = require('../../src/app');

const API_KEY = 'ph8-security-header-test-api-key-32-characters';
const PASSWORD_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';

function makeConfig(overrides = {}) {
  const values = {
    API_KEY,
    ATLAS_OPERATOR_PASSWORD_HASH: PASSWORD_HASH,
    ATLAS_ORIGIN: 'http://localhost:3000',
    ATLAS_COOKIE_SECURE: false,
    CORS_ORIGIN: 'http://allowed.test',
    MAX_BODY_SIZE: '1mb',
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX_REQUESTS: 1000,
    RATE_LIMIT_EXPENSIVE_MAX: 1000,
    RATE_LIMIT_LOGIN_MAX_REQUESTS: 10,
    RATE_LIMIT_LOGIN_WINDOW_MS: 15 * 60 * 1000,
    ...overrides,
  };

  return { get: key => values[key], getAll: () => ({ ...values }) };
}

function makeLogger() {
  return { info() {}, warn() {}, error() {}, system() {} };
}

function makeApp(config) {
  const logger = makeLogger();
  const routes = {
    apiManager: {
      isConnected: () => true,
      getHealth: () => ({ connected: true }),
    },
    history: {
      latest: () => null,
      last: () => [],
      size: () => 0,
    },
    analyzer: { getAnalysis: () => null },
    candleEngine: {
      getAllTimeframes: () => ['1h'],
      getCandles: () => [],
      getActive: () => null,
    },
    logger,
    config,
    eventBus: {},
    cache: { getAge: () => null },
    indicatorRegistry: {},
    structureEngine: {},
    confluenceEngine: {},
    validationEngine: {},
    mtfEngine: {},
    macdEngine: {},
    atrEngine: {},
    bollingerEngine: {},
    signalHistoryEngine: {},
    backtestEngine: {},
    analyticsEngine: {},
    paperTradeEngine: {},
    regimeEngine: {},
    regimeDecisionEngine: {},
    advanceRiskEngine: {},
    mtfConfirmationEngine: {},
    productionReplayApplication: null,
    symbol: 'BTCUSDT',
  };

  return createApp({
    config,
    logger,
    routes,
    getLastDecision: () => null,
    getPipelineHealth: () => null,
  });
}

function startApp(config) {
  const server = http.createServer(makeApp(config));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopApp(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function request(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      headers,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

function parseCsp(value) {
  const directives = new Map();
  for (const item of value.split(';')) {
    const tokens = item.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) directives.set(tokens[0], tokens.slice(1));
  }
  return directives;
}

function assertCommonHeaders(response) {
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['permissions-policy'], /camera=\(\)/);
  assert.equal(response.headers['x-powered-by'], undefined);
}

test('security headers cover public, static, authenticated, and error responses', async () => {
  const server = await startApp(makeConfig());
  try {
    for (const path of ['/healthz', '/readyz', '/', '/app.js']) {
      const response = await request(server, path);
      assertCommonHeaders(response);
    }

    const authenticated = await request(server, '/api/status', { 'x-api-key': API_KEY });
    assert.equal(authenticated.statusCode, 200);
    assertCommonHeaders(authenticated);
    assert.equal(authenticated.headers['cache-control'], 'no-store');

    const unauthorized = await request(server, '/api/status');
    assert.equal(unauthorized.statusCode, 401);
    assertCommonHeaders(unauthorized);
    assert.equal(unauthorized.headers['cache-control'], 'no-store');

    const apiError = await request(server, '/api/candles?timeframe=invalid', { 'x-api-key': API_KEY });
    assert.equal(apiError.statusCode, 400);
    assertCommonHeaders(apiError);
    assert.equal(apiError.headers['cache-control'], 'no-store');

    const notFound = await request(server, '/missing');
    assert.equal(notFound.statusCode, 404);
    assertCommonHeaders(notFound);
    assert.notEqual(notFound.headers['cache-control'], 'no-store');
  } finally {
    await stopApp(server);
  }
});

test('CSP exposes only the locked semantic directives', async () => {
  const server = await startApp(makeConfig());
  try {
    const response = await request(server, '/');
    const csp = parseCsp(response.headers['content-security-policy']);
    const expected = {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'script-src-elem': ["'self'"],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'"],
      'style-src-elem': ["'self'"],
      'style-src-attr': ["'none'"],
      'connect-src': ["'self'"],
      'img-src': ["'none'"],
      'font-src': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'frame-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'worker-src': ["'none'"],
      'manifest-src': ["'none'"],
      'media-src': ["'none'"],
    };
    assert.deepEqual(Object.fromEntries(csp), expected);
    assert.equal(csp.get('script-src').includes("'unsafe-inline'"), false);
    assert.equal(csp.get('script-src').includes("'unsafe-eval'"), false);
    assert.equal(csp.get('script-src').includes('https://unpkg.com'), false);
  } finally {
    await stopApp(server);
  }
});

test('HSTS is limited to validated non-loopback HTTPS origins', async () => {
  const cases = [
    { origin: 'http://localhost:3000', expected: undefined },
    { origin: 'https://localhost:3000', expected: undefined },
    { origin: 'https://atlas.example.test', expected: 'max-age=31536000' },
  ];

  for (const scenario of cases) {
    const server = await startApp(makeConfig({ ATLAS_ORIGIN: scenario.origin }));
    try {
      const response = await request(server, '/healthz');
      assert.equal(response.headers['strict-transport-security'], scenario.expected, scenario.origin);
    } finally {
      await stopApp(server);
    }
  }
});
