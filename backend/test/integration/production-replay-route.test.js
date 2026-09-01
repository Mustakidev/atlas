const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createApp } = require('../../src/app');

const API_KEY = 'production-replay-test-api-key-32-characters';
const OPERATOR_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';
const START_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const END_TIME = START_TIME + (51 * 3_600_000);
const VALID_QUERY = `symbol=BTCUSDT&startTime=${START_TIME}&endTime=${END_TIME}`;

function makeConfig(overrides = {}) {
  const values = {
    API_KEY,
    ATLAS_OPERATOR_PASSWORD_HASH: OPERATOR_HASH,
    ATLAS_ORIGIN: 'http://127.0.0.1',
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

  return {
    get(key) {
      return values[key];
    },
  };
}

function makeLogger(state = {}) {
  return {
    info() {},
    system() {},
    warn(module, message, data) {
      state.warnings = state.warnings || [];
      state.warnings.push({ module, message, data });
    },
    error(module, message, data) {
      state.errors = state.errors || [];
      state.errors.push({ module, message, data });
    },
  };
}

function makeRoutes({ application, candleEngine, logger, config }) {
  return {
    apiManager: {},
    history: {},
    analyzer: {},
    candleEngine,
    logger,
    config,
    eventBus: {},
    cache: {},
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
    riskEngine: {},
    regimeEngine: {},
    regimeDecisionEngine: {},
    advanceRiskEngine: {},
    mtfConfirmationEngine: {},
    productionReplayApplication: application,
    symbol: 'BTCUSDT',
  };
}

function createTestApp({
  application,
  candleEngine = {
    getAllTimeframes: () => ['1h'],
    getCandles: () => [{ openTime: START_TIME }],
    getActive: () => null,
  },
  configValues,
  loggerState = {},
} = {}) {
  const config = makeConfig(configValues);
  const logger = makeLogger(loggerState);
  const routes = makeRoutes({
    application,
    candleEngine,
    logger,
    config,
  });

  const app = createApp({
    config,
    logger,
    routes,
    getLastDecision: () => null,
    getPipelineHealth: () => null,
  });

  return { app, loggerState };
}

function startApp(options) {
  const { app, ...state } = createTestApp(options);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, state }));
  });
}

function stopApp(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function request(server, {
  method = 'GET',
  path,
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path,
      headers,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, text, body });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

async function withApp(options, callback) {
  const started = await startApp(options);
  try {
    return await callback(started.server, started.state);
  } finally {
    await stopApp(started.server);
  }
}

function authHeaders() {
  return { 'x-api-key': API_KEY };
}

function assertCanonicalInvalid(result) {
  assert.equal(result.statusCode, 400);
  assert.deepEqual(result.body, {
    error: 'Invalid canonical replay request',
    code: 'INVALID_REQUEST',
  });
}

test('canonical router runs before legacy sanitizeQuery', async () => {
  await withApp({ application: { run: async () => ({}) } }, async server => {
    for (const field of ['direction=INVALID', 'entryPrice=abc']) {
      const result = await request(server, {
        path: `/api/strategy/replay/v2?${VALID_QUERY}&${field}`,
        headers: authHeaders(),
      });
      assertCanonicalInvalid(result);
    }
  });
});

test('canonical success uses only the injected application', async () => {
  const calls = [];
  const resultBody = { replay: { cycles: [] }, provenance: { sourceType: 'test' } };
  const application = {
    async run(requestInput) {
      calls.push(requestInput);
      return resultBody;
    },
  };
  const candleEngine = {
    getAllTimeframes() { throw new Error('canonical request read candle data'); },
    getCandles() { throw new Error('canonical request read candle data'); },
    getActive() { throw new Error('canonical request read candle data'); },
  };
  await withApp({ application, candleEngine }, async server => {
    const result = await request(server, {
      path: `/api/strategy/replay/v2?${VALID_QUERY}`,
      headers: authHeaders(),
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, resultBody);
    assert.equal(Object.hasOwn(result.body, 'data'), false);
  });

  assert.deepEqual(calls, [{
    symbol: 'BTCUSDT',
    startTime: START_TIME,
    endTime: END_TIME,
  }]);
});

test('canonical availability is checked after parsing', async () => {
  await withApp({ application: null }, async server => {
    const unavailable = await request(server, {
      path: `/api/strategy/replay/v2?${VALID_QUERY}`,
      headers: authHeaders(),
    });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.body, {
      error: 'Canonical replay application unavailable',
      code: 'CANONICAL_REPLAY_UNAVAILABLE',
    });

    const malformed = await request(server, {
      path: `/api/strategy/replay/v2?symbol=BTCUSDT&startTime=${START_TIME}`,
      headers: authHeaders(),
    });
    assertCanonicalInvalid(malformed);
  });
});

test('removed legacy replay paths return the default authenticated 404', async () => {
  let canonicalCalls = 0;
  const application = { run: async () => { canonicalCalls++; return {}; } };

  await withApp({ application }, async server => {
    const getResult = await request(server, {
      path: '/api/strategy/replay',
      headers: authHeaders(),
    });
    assert.equal(getResult.statusCode, 404);
    assert.match(getResult.headers['content-type'], /^text\/html; charset=utf-8/);
    assert.match(getResult.text, /Cannot GET \/api\/strategy\/replay/);

    const postResult = await request(server, {
      method: 'POST',
      path: '/api/strategy/replay',
      headers: authHeaders(),
    });
    assert.equal(postResult.statusCode, 404);
    assert.match(postResult.headers['content-type'], /^text\/html; charset=utf-8/);
    assert.match(postResult.text, /Cannot POST \/api\/strategy\/replay/);
  });

  assert.equal(canonicalCalls, 0);
});

test('canonical route inherits authentication', async () => {
  await withApp({ application: { run: async () => ({}) } }, async server => {
    const missing = await request(server, { path: `/api/strategy/replay/v2?${VALID_QUERY}` });
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(missing.body, {
      error: 'Authentication required',
      message: 'Authentication required',
    });

    const invalid = await request(server, {
      path: `/api/strategy/replay/v2?${VALID_QUERY}`,
      headers: { 'x-api-key': 'wrong-key' },
    });
    assert.equal(invalid.statusCode, 401);
    assert.deepEqual(invalid.body, {
      error: 'Authentication required',
      message: 'Invalid API key',
    });
  });
});

test('canonical route inherits the expensive limiter', async () => {
  let calls = 0;
  const application = {
    run: async () => {
      calls++;
      return { ok: true };
    },
  };

  await withApp({
    application,
    configValues: { RATE_LIMIT_EXPENSIVE_MAX: 1 },
  }, async server => {
    const first = await request(server, {
      path: `/api/strategy/replay/v2?${VALID_QUERY}`,
      headers: authHeaders(),
    });
    assert.equal(first.statusCode, 200);

    const second = await request(server, {
      path: `/api/strategy/replay/v2?${VALID_QUERY}`,
      headers: authHeaders(),
    });
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.error, 'Rate limit exceeded for expensive endpoint');
  });

  assert.equal(calls, 1);
});

test('canonical unknown errors use the generic error boundary', async () => {
  const loggerState = {};
  const application = {
    run: async () => {
      throw new Error('secret canonical failure');
    },
  };

  await withApp({ application, loggerState }, async server => {
    const result = await request(server, {
      path: `/api/strategy/replay/v2?${VALID_QUERY}`,
      headers: authHeaders(),
    });
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.body, { error: 'Internal server error' });
    assert.equal(result.text.includes('secret canonical failure'), false);
  });

  assert.ok(loggerState.errors.some(entry => (
    entry.module === 'ErrorBoundary'
      && entry.data.path === '/api/strategy/replay/v2'
      && entry.data.status === 500
  )));
});

test('POST V2 remains the default Express HTML 404', async () => {
  await withApp({ application: { run: async () => ({}) } }, async server => {
    const result = await request(server, {
      method: 'POST',
      path: '/api/strategy/replay/v2',
      headers: authHeaders(),
    });
    assert.equal(result.statusCode, 404);
    assert.match(result.text, /Cannot POST \/api\/strategy\/replay\/v2/);
  });
});
