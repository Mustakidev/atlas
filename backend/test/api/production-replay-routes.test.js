const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  createProductionReplayRouter,
} = require('../../src/routes/productionReplayRoutes');
const {
  ProductionReplayApplicationError,
} = require('../../src/application/productionReplayApplication');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MIN_START_TIME = DAY_MS;
const MIN_HORIZON_MS = 51 * HOUR_MS;
const MAX_HORIZON_MS = 99 * DAY_MS - HOUR_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;
const START_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const END_TIME = START_TIME + MIN_HORIZON_MS;

const APP_ERROR_CASES = [
  ['INVALID_REQUEST', 400, 'Invalid canonical replay request'],
  ['MTF_SOURCE_FAILURE', 502, 'Canonical replay source unavailable'],
  ['ANALYZER_SOURCE_FAILURE', 502, 'Canonical replay source unavailable'],
  ['SOURCE_MISMATCH', 502, 'Canonical replay source contract failure'],
  ['DEPENDENCY_FAILURE', 500, 'Canonical replay dependency failure'],
  ['REPLAY_FAILURE', 500, 'Canonical replay failed'],
];

function validQuery(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    startTime: String(START_TIME),
    endTime: String(END_TIME),
    ...overrides,
  };
}

function encodeQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, value);
    }
  }
  return params.toString();
}

function requestPath(query) {
  const encoded = encodeQuery(query);
  return `/strategy/replay/v2${encoded ? `?${encoded}` : ''}`;
}

function makeLogger() {
  return {
    errors: [],
    error(module, message, data) {
      this.errors.push({ module, message, data });
    },
  };
}

function createTestApp({ application, logger = makeLogger(), captureQuery = false } = {}) {
  const app = express();
  let queryReference;
  let querySnapshot;

  if (captureQuery) {
    app.use((req, res, next) => {
      queryReference = req.query;
      querySnapshot = structuredClone(req.query);
      next();
    });
  }

  app.use(createProductionReplayRouter({ application, logger }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return { app, logger, getQuery: () => ({ queryReference, querySnapshot }) };
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

function request(server, { method = 'GET', path: requestUrl, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: requestUrl,
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

async function withRequest(options, callback) {
  const started = await startApp(options);
  try {
    return await callback(started.server, started.state);
  } finally {
    await stopApp(started.server);
  }
}

function assertInvalid(result) {
  assert.equal(result.statusCode, 400);
  assert.deepEqual(result.body, {
    error: 'Invalid canonical replay request',
    code: 'INVALID_REQUEST',
  });
  assert.deepEqual(Object.keys(result.body), ['error', 'code']);
}

function assertNoApplicationRun(application) {
  assert.equal(application.calls, 0);
}

test('exports only createProductionReplayRouter', () => {
  const moduleExports = require('../../src/routes/productionReplayRoutes');
  assert.deepEqual(Object.keys(moduleExports), ['createProductionReplayRouter']);
});

test('accepts null and undefined applications', () => {
  const logger = makeLogger();
  assert.doesNotThrow(() => createProductionReplayRouter({ application: null, logger }));
  assert.doesNotThrow(() => createProductionReplayRouter({ application: undefined, logger }));
});

test('rejects malformed non-null applications', () => {
  const logger = makeLogger();
  for (const application of [{}, { run: null }, 42, 'application']) {
    assert.throws(
      () => createProductionReplayRouter({ application, logger }),
      /application\.run must be a function/,
    );
  }
});

test('requires only logger.error', () => {
  assert.doesNotThrow(() => createProductionReplayRouter({
    application: null,
    logger: { error() {} },
  }));
  for (const logger of [null, undefined, {}, { info() {} }, { error: null }]) {
    assert.throws(
      () => createProductionReplayRouter({ application: null, logger }),
      /logger\.error must be a function/,
    );
  }
});

test('valid 51-hour request reaches application with the exact canonical request', async () => {
  const application = {
    calls: 0,
    requests: [],
    async run(input) {
      this.calls++;
      this.requests.push(input);
      return { replay: { cycles: [] }, provenance: { source: 'test' } };
    },
  };

  await withRequest({ application }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      replay: { cycles: [] },
      provenance: { source: 'test' },
    });
  });

  assert.equal(application.calls, 1);
  assert.deepEqual(application.requests, [{
    symbol: 'BTCUSDT',
    startTime: START_TIME,
    endTime: END_TIME,
  }]);
});

test('returns the exact application result without a data envelope', async () => {
  const canonicalResult = Object.freeze({
    replay: Object.freeze({ cycles: [], runnerState: { status: 'EXHAUSTED' } }),
    provenance: Object.freeze({ sourceType: 'production-replay-application' }),
  });
  const application = { run: async () => canonicalResult, calls: 0 };

  await withRequest({ application }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, canonicalResult);
    assert.equal(Object.hasOwn(result.body, 'data'), false);
    assert.equal(Object.hasOwn(result.body, 'calculationTime'), false);
  });
});

test('does not mutate req.query', async () => {
  const application = { calls: 0, run: async () => ({ ok: true }) };
  const started = await startApp({ application, captureQuery: true });
  try {
    await request(started.server, { path: requestPath(validQuery()) });
    const captured = started.state.getQuery();
    assert.deepEqual(captured.queryReference, captured.querySnapshot);
  } finally {
    await stopApp(started.server);
  }
});

for (const [field, label] of [
  ['symbol', 'symbol'],
  ['startTime', 'startTime'],
  ['endTime', 'endTime'],
]) {
  test(`rejects missing ${label}`, async () => {
    const application = { calls: 0, run: async () => ({}) };
    const query = validQuery();
    delete query[field];

    await withRequest({ application }, async (server) => {
      const result = await request(server, { path: requestPath(query) });
      assertInvalid(result);
    });
    assertNoApplicationRun(application);
  });
}

test('rejects unknown query parameters', async () => {
  const application = { calls: 0, run: async () => ({}) };
  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: requestPath(validQuery({ unknown: 'value' })),
    });
    assertInvalid(result);
  });
  assertNoApplicationRun(application);
});

for (const [key, value, label] of [
  ['direction', 'INVALID', 'direction'],
  ['entryPrice', 'abc', 'entryPrice'],
]) {
  test(`legacy-recognized unknown ${label} remains canonical INVALID_REQUEST`, async () => {
    const application = { calls: 0, run: async () => ({}) };
    await withRequest({ application }, async (server) => {
      const result = await request(server, {
        path: requestPath(validQuery({ [key]: value })),
      });
      assertInvalid(result);
    });
    assertNoApplicationRun(application);
  });
}

for (const field of ['symbol', 'startTime', 'endTime']) {
  test(`rejects repeated ${field}`, async () => {
    const application = { calls: 0, run: async () => ({}) };
    const query = validQuery({ [field]: [validQuery()[field], validQuery()[field]] });
    await withRequest({ application }, async (server) => {
      const result = await request(server, { path: requestPath(query) });
      assertInvalid(result);
    });
    assertNoApplicationRun(application);
  });
}

for (const [label, value] of [
  ['empty symbol', ''],
  ['whitespace symbol', '   '],
  ['lowercase symbol', 'btcusdt'],
  ['unsupported symbol', 'ETHUSDT'],
  ['slash symbol', 'BTC/USDT'],
]) {
  test(`rejects ${label}`, async () => {
    const application = { calls: 0, run: async () => ({}) };
    await withRequest({ application }, async (server) => {
      const result = await request(server, {
        path: requestPath(validQuery({ symbol: value })),
      });
      assertInvalid(result);
    });
    assertNoApplicationRun(application);
  });
}

for (const [label, value] of [
  ['empty', ''],
  ['whitespace', '   '],
  ['ISO', '2024-01-01T00:00:00.000Z'],
  ['signed', `+${START_TIME}`],
  ['decimal', `${START_TIME}.5`],
  ['exponent', '1e12'],
  ['unsafe integer', '9007199254740992'],
]) {
  test(`rejects ${label} startTime`, async () => {
    const application = { calls: 0, run: async () => ({}) };
    await withRequest({ application }, async (server) => {
      const result = await request(server, {
        path: requestPath(validQuery({ startTime: value })),
      });
      assertInvalid(result);
    });
    assertNoApplicationRun(application);
  });

  test(`rejects ${label} endTime`, async () => {
    const application = { calls: 0, run: async () => ({}) };
    await withRequest({ application }, async (server) => {
      const result = await request(server, {
        path: requestPath(validQuery({ endTime: value })),
      });
      assertInvalid(result);
    });
    assertNoApplicationRun(application);
  });
}

test('rejects object query values', async () => {
  const application = { calls: 0, run: async () => ({}) };
  const encoded = [
    `symbol%5Bvalue%5D=BTCUSDT`,
    `startTime=${START_TIME}`,
    `endTime=${END_TIME}`,
  ].join('&');

  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: `/strategy/replay/v2?${encoded}`,
    });
    assertInvalid(result);
  });
  assertNoApplicationRun(application);
});

test('rejects non-hour-aligned startTime and endTime', async () => {
  const application = { calls: 0, run: async () => ({}) };
  await withRequest({ application }, async (server) => {
    const startResult = await request(server, {
      path: requestPath(validQuery({ startTime: String(START_TIME + 1) })),
    });
    assertInvalid(startResult);

    const endResult = await request(server, {
      path: requestPath(validQuery({ endTime: String(END_TIME + 1) })),
    });
    assertInvalid(endResult);
  });
  assertNoApplicationRun(application);
});

test('rejects equal and reverse horizons', async () => {
  const application = { calls: 0, run: async () => ({}) };
  await withRequest({ application }, async (server) => {
    const equal = await request(server, {
      path: requestPath(validQuery({ endTime: String(START_TIME) })),
    });
    assertInvalid(equal);

    const reverse = await request(server, {
      path: requestPath(validQuery({
        startTime: String(END_TIME),
        endTime: String(START_TIME),
      })),
    });
    assertInvalid(reverse);
  });
  assertNoApplicationRun(application);
});

test('rejects a horizon shorter than 51 hours', async () => {
  const application = { calls: 0, run: async () => ({}) };
  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: requestPath(validQuery({ endTime: String(START_TIME + 50 * HOUR_MS) })),
    });
    assertInvalid(result);
  });
  assertNoApplicationRun(application);
});

test('accepts exactly the 51-hour horizon', async () => {
  const application = {
    calls: 0,
    run: async () => {
      application.calls++;
      return { accepted: true };
    },
  };
  await withRequest({ application }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { accepted: true });
  });
  assert.equal(application.calls, 1);
});

test('accepts exactly the maximum horizon', async () => {
  const application = {
    calls: 0,
    run: async () => {
      application.calls++;
      return { accepted: true };
    },
  };
  const endTime = START_TIME + MAX_HORIZON_MS;
  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: requestPath(validQuery({ endTime: String(endTime) })),
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { accepted: true });
  });
  assert.equal(application.calls, 1);
});

test('rejects maximum horizon plus one hour', async () => {
  const application = { calls: 0, run: async () => ({}) };
  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: requestPath(validQuery({
        endTime: String(START_TIME + MAX_HORIZON_MS + HOUR_MS),
      })),
    });
    assertInvalid(result);
  });
  assertNoApplicationRun(application);
});

test('rejects a startTime before the 24-hour pre-roll minimum', async () => {
  const application = { calls: 0, run: async () => ({}) };
  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: requestPath(validQuery({
        startTime: '0',
        endTime: String(51 * HOUR_MS),
      })),
    });
    assertInvalid(result);
  });
  assertNoApplicationRun(application);
});

test('rejects an endTime that leaves no valid terminal Date boundary', async () => {
  const application = { calls: 0, run: async () => ({}) };
  const endTime = MAX_DATE_MS;
  const startTime = endTime - MIN_HORIZON_MS;
  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: requestPath(validQuery({
        startTime: String(startTime),
        endTime: String(endTime),
      })),
    });
    assertInvalid(result);
  });
  assertNoApplicationRun(application);
});

test('returns exact 503 for a null application after valid parsing', async () => {
  await withRequest({ application: null }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, {
      error: 'Canonical replay application unavailable',
      code: 'CANONICAL_REPLAY_UNAVAILABLE',
    });
    assert.deepEqual(Object.keys(result.body), ['error', 'code']);
  });
});

test('returns exact 503 for an undefined application after valid parsing', async () => {
  await withRequest({ application: undefined }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, {
      error: 'Canonical replay application unavailable',
      code: 'CANONICAL_REPLAY_UNAVAILABLE',
    });
  });
});

test('returns 400 for malformed input even when the application is unavailable', async () => {
  await withRequest({ application: null }, async (server) => {
    const result = await request(server, {
      path: requestPath({ symbol: 'BTCUSDT', startTime: String(START_TIME) }),
    });
    assertInvalid(result);
  });
});

for (const [code, status, errorMessage] of APP_ERROR_CASES) {
  test(`maps genuine APP ${code} to its exact public response`, async () => {
    const logger = makeLogger();
    const application = {
      calls: 0,
      run: async () => {
        this;
        throw new ProductionReplayApplicationError(code, 'secret internal message', {
          cause: new Error('secret cause'),
          originalCode: 'SECRET_ORIGINAL_CODE',
          source: 'safe-source',
          phase: 'safe-phase',
          field: 'secret.field',
          expected: 'secret expected',
          actual: 'secret actual',
        });
      },
    };

    await withRequest({ application, logger }, async (server) => {
      const result = await request(server, { path: requestPath(validQuery()) });
      assert.equal(result.statusCode, status);
      assert.deepEqual(result.body, { error: errorMessage, code });
      assert.deepEqual(Object.keys(result.body), ['error', 'code']);
      assert.equal(result.text.includes('secret'), false);
    });

    assert.deepEqual(logger.errors, [{
      module: 'CanonicalReplay',
      message: 'Canonical replay application failed',
      data: { code, source: 'safe-source', phase: 'safe-phase' },
    }]);
  });
}

test('logger failure does not alter a known APP error response', async () => {
  const loggerFailure = new Error('logger failed');
  const logger = {
    error() {
      throw loggerFailure;
    },
  };
  const application = {
    run: async () => {
      throw new ProductionReplayApplicationError('REPLAY_FAILURE', 'secret replay failure', {
        cause: new Error('secret cause'),
        originalCode: 'SECRET_ORIGINAL_CODE',
        source: 'secret source',
        phase: 'secret phase',
      });
    },
  };

  await withRequest({ application, logger }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.body, {
      error: 'Canonical replay failed',
      code: 'REPLAY_FAILURE',
    });
    assert.deepEqual(Object.keys(result.body), ['error', 'code']);
    for (const secret of [
      'logger failed',
      'cause',
      'originalCode',
      'source',
      'phase',
      'Error',
    ]) {
      assert.equal(result.text.includes(secret), false, secret);
    }
  });
});

test('does not map arbitrary Error objects carrying an APP code', async () => {
  const application = {
    calls: 0,
    run: async () => {
      const error = new Error('secret arbitrary error');
      error.code = 'REPLAY_FAILURE';
      throw error;
    },
  };

  await withRequest({ application }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.body, { error: 'Internal server error' });
    assert.equal(result.text.includes('secret arbitrary error'), false);
  });
});

test('does not map arbitrary plain objects carrying an APP code', async () => {
  const application = {
    calls: 0,
    run: async () => {
      throw { code: 'REPLAY_FAILURE', message: 'secret plain object' };
    },
  };

  await withRequest({ application }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.body, { error: 'Internal server error' });
    assert.equal(result.text.includes('secret plain object'), false);
  });
});

test('does not call application.run on parser failure', async () => {
  const application = { calls: 0, run: async () => { application.calls++; return {}; } };
  await withRequest({ application }, async (server) => {
    const result = await request(server, {
      path: requestPath(validQuery({ startTime: 'not-a-timestamp' })),
    });
    assertInvalid(result);
  });
  assertNoApplicationRun(application);
});

test('does not call application.run when unavailable', async () => {
  let calls = 0;
  const application = null;
  await withRequest({ application }, async (server) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 503);
    calls++;
  });
  assert.equal(calls, 1);
});

test('registers GET only and does not own the legacy path', async () => {
  const application = { calls: 0, run: async () => ({ ok: true }) };
  await withRequest({ application }, async (server) => {
    const post = await request(server, {
      method: 'POST',
      path: '/strategy/replay/v2',
    });
    assert.equal(post.statusCode, 404);
    assert.match(post.text, /Cannot POST \/strategy\/replay\/v2/);

    const legacy = await request(server, {
      path: '/strategy/replay',
    });
    assert.equal(legacy.statusCode, 404);
    assert.match(legacy.text, /Cannot GET \/strategy\/replay/);
  });
});

test('production router has no forbidden source or legacy ownership imports', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/routes/productionReplayRoutes.js'),
    'utf8',
  );
  for (const forbidden of [
    'productionReplayComposition',
    'BinanceKlineClient',
    'CoinGeckoHistoricalAnalyzerClient',
    'ProductionReplayMtfSource',
    'ProductionReplayAnalyzerSource',
    'StrategyReplayEngine',
    'CandleEngine',
    'getFinalizedCandles',
    'node-fetch',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('maps internal cancellation to the existing shutdown response', async () => {
  const application = {
    async run() {
      throw new ProductionReplayApplicationError('CANCELLED', 'Canonical replay cancelled');
    },
  };

  await withRequest({ application }, async (server, state) => {
    const result = await request(server, { path: requestPath(validQuery()) });
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { error: 'Server shutting down' });
    assert.deepEqual(state.logger.errors, []);
  });
});
