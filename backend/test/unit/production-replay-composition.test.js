const test = require('node:test');
const assert = require('node:assert/strict');

const compositionModule = require('../../src/application/productionReplayComposition');
const { createProductionReplayComposition } = compositionModule;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BASE_TIME = Date.parse('2026-01-10T00:00:00.000Z');
const PRIMARY_COUNT = 51;
const END_TIME = BASE_TIME + PRIMARY_COUNT * HOUR_MS;
const PROVIDER_KEY = 'coingecko-composition-test-key';

function makeLogger(calls = []) {
  return {
    info(...args) { calls.push(['info', args]); },
    warn(...args) { calls.push(['warn', args]); },
    error(...args) { calls.push(['error', args]); },
  };
}

function makeClock() {
  let monotonic = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => monotonic++,
  };
}

function makeRiskPolicySource() {
  return {
    getPolicy() {
      return {
        accountBalance: 10000,
        riskPerTradePct: 1,
        atrMultTrending: 2,
        atrMultRanging: 1.5,
        rrTrending: 3,
        rrRanging: 1.8,
        maxDailyLossPct: 5,
        maxDailyDrawdownPct: 10,
        maxConsecutiveLosses: 3,
        cooldownMs: 3_600_000,
        sessionMultipliers: { ASIAN: 1, LONDON: 1, NEW_YORK: 1 },
      };
    },
  };
}

function makeConfig(overrides = {}, calls = []) {
  const values = {
    COINGECKO_API_KEY: PROVIDER_KEY,
    API_KEY: 'atlas-inbound-key',
    REQUEST_TIMEOUT: 4321,
    INITIAL_BACKOFF: 765,
    MAX_RETRIES: 99,
    CONFLUENCE_BULLISH_THRESHOLD: 65,
    CONFLUENCE_BEARISH_THRESHOLD: 35,
    MAX_HISTORY: 500,
    ...overrides,
  };
  return {
    get(key) {
      calls.push(key);
      return values[key];
    },
  };
}

function makeDependencies(options = {}) {
  const configCalls = options.configCalls || [];
  const loggerCalls = options.loggerCalls || [];
  const sleepCalls = options.sleepCalls || [];
  const fetchCalls = options.fetchCalls || [];
  const config = options.config || makeConfig({}, configCalls);
  const logger = options.logger || makeLogger(loggerCalls);
  const sleep = options.sleep || (async delay => { sleepCalls.push(delay); });
  const fetch = options.fetch || (async (...args) => {
    fetchCalls.push(args);
    throw new Error('network must not be called during composition');
  });

  return {
    fetch,
    logger,
    config,
    clock: options.clock || makeClock(),
    riskPolicySource: options.riskPolicySource === undefined
      ? makeRiskPolicySource()
      : options.riskPolicySource,
    sleep,
    configCalls,
    loggerCalls,
    sleepCalls,
    fetchCalls,
  };
}

function compose(options = {}) {
  const dependencies = makeDependencies(options);
  return {
    ...dependencies,
    composition: createProductionReplayComposition(dependencies),
  };
}

function assertInvalidDependency(overrides, pattern) {
  assert.throws(
    () => createProductionReplayComposition({
      ...makeDependencies(),
      ...overrides,
    }),
    error => error.code === 'INVALID_DEPENDENCY' && pattern.test(error.message),
  );
}

function providerCandle(timeframe, openTime, index) {
  const duration = {
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': HOUR_MS,
  }[timeframe];
  const open = 100 + index;
  return [
    openTime,
    String(open),
    String(open + 1),
    String(open - 1),
    String(open + 0.5),
    '10',
    openTime + duration - 1,
    '100',
    1,
    '5',
    '50',
    '0',
  ];
}

function makeAnalyzerPayload(startTime, endTime) {
  const acquisitionStart = startTime - DAY_MS;
  const count = (endTime - acquisitionStart) / HOUR_MS + 1;
  const prices = [];
  const volumes = [];
  for (let index = 0; index < count; index++) {
    const timestamp = acquisitionStart + index * HOUR_MS;
    prices.push([timestamp, 1000 + index]);
    volumes.push([timestamp, 10000 + index]);
  }
  return { prices, total_volumes: volumes };
}

function makeSuccessfulFetch({ calls, failFirstKline = false } = {}) {
  let firstKline = true;
  return async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, options });

    if (parsed.pathname === '/api/v3/klines') {
      if (failFirstKline && firstKline) {
        firstKline = false;
        return { status: 500, async json() { return {}; } };
      }

      const timeframe = parsed.searchParams.get('interval');
      const startTime = Number(parsed.searchParams.get('startTime'));
      const endTime = Number(parsed.searchParams.get('endTime')) + 1;
      const pageSize = Number(parsed.searchParams.get('limit'));
      const duration = {
        '1m': 60_000,
        '5m': 300_000,
        '15m': 900_000,
        '1h': HOUR_MS,
      }[timeframe];
      const pageEnd = Math.min(endTime, startTime + duration * pageSize);
      const rows = [];
      for (let timestamp = startTime, index = 0; timestamp < pageEnd; timestamp += duration, index++) {
        rows.push(providerCandle(timeframe, timestamp, index));
      }
      return { status: 200, async json() { return rows; } };
    }

    if (parsed.pathname === '/api/v3/coins/bitcoin/market_chart/range') {
      const startTime = Number(parsed.searchParams.get('from')) * 1000 + DAY_MS;
      const endTime = Number(parsed.searchParams.get('to')) * 1000;
      return {
        status: 200,
        async json() { return makeAnalyzerPayload(startTime, endTime); },
      };
    }

    throw new Error(`unexpected provider URL: ${parsed.href}`);
  };
}

async function runQuietly(operation) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await operation();
  } finally {
    console.log = originalLog;
  }
}

test('exports exactly the composition factory', () => {
  assert.deepEqual(Object.keys(compositionModule), ['createProductionReplayComposition']);
});

test('constructs a frozen application facade with the exact public surface', () => {
  const { composition } = compose();

  assert.deepEqual(Object.keys(composition), ['application']);
  assert.equal(Object.isFrozen(composition), true);
  assert.equal(Object.isFrozen(composition.application), true);
  assert.deepEqual(Object.keys(composition.application), ['run']);
});

test('requires the canonical provider credential and never reuses Atlas API_KEY', () => {
  for (const value of [undefined, null, '', '   ', 42]) {
    const configCalls = [];
    const config = makeConfig({ COINGECKO_API_KEY: value }, configCalls);
    assert.throws(
      () => createProductionReplayComposition(makeDependencies({ config })),
      error => error.code === 'MISSING_PROVIDER_CREDENTIAL'
        && !error.message.includes(PROVIDER_KEY),
    );
    assert.equal(configCalls.includes('API_KEY'), false);
  }

  const configCalls = [];
  const config = makeConfig({ COINGECKO_API_KEY: undefined, API_KEY: PROVIDER_KEY }, configCalls);
  assert.throws(
    () => createProductionReplayComposition(makeDependencies({ config })),
    error => error.code === 'MISSING_PROVIDER_CREDENTIAL',
  );
  assert.equal(configCalls.includes('API_KEY'), false);
  assert.deepEqual(configCalls, ['COINGECKO_API_KEY']);
});

test('reads a trimmed provider credential independently and performs no construction side effects', () => {
  const configCalls = [];
  const fetchCalls = [];
  const sleepCalls = [];
  const loggerCalls = [];
  const config = makeConfig({ COINGECKO_API_KEY: `  ${PROVIDER_KEY}  ` }, configCalls);
  const { composition } = compose({
    config,
    fetchCalls,
    sleepCalls,
    loggerCalls,
  });

  assert.equal(configCalls.includes('COINGECKO_API_KEY'), true);
  assert.equal(configCalls.includes('API_KEY'), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(sleepCalls.length, 0);
  assert.equal(loggerCalls.length, 0);
  assert.equal(JSON.stringify(composition).includes(PROVIDER_KEY), false);
  assert.equal(JSON.stringify(composition.application).includes(PROVIDER_KEY), false);
});

test('validates injected dependencies before provider construction', () => {
  assertInvalidDependency({ fetch: null }, /fetch/);
  assertInvalidDependency({ logger: {} }, /logger\.info/);
  assertInvalidDependency({ config: {} }, /config\.get/);
  assertInvalidDependency({ clock: {} }, /clock\.nowMs/);
  assertInvalidDependency({ sleep: null }, /sleep/);
  assertInvalidDependency({ riskPolicySource: {} }, /riskPolicySource\.getPolicy/);

  assertInvalidDependency({ riskPolicySource: null }, /riskPolicySource/);
});

test('constructs the real provider and APP-1 graph without network activity', () => {
  const fetchCalls = [];
  const sleepCalls = [];
  const configCalls = [];
  const { composition } = compose({ fetchCalls, sleepCalls, configCalls });

  assert.equal(typeof composition.application.run, 'function');
  assert.equal(fetchCalls.length, 0);
  assert.equal(sleepCalls.length, 0);
  assert.equal(configCalls.includes('REQUEST_TIMEOUT'), true);
  assert.equal(configCalls.includes('INITIAL_BACKOFF'), true);
  assert.equal(configCalls.includes('MAX_RETRIES'), false);
});

test('composition source has no forbidden ownership imports', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/application/productionReplayComposition.js'),
    'utf8',
  );

  for (const forbidden of [
    'express',
    "require('../routes",
    "require('../app",
    "require('../../server",
    'StrategyReplayEngine',
    'CandleEngine',
    'getFinalizedCandles',
    'coins/bitcoin/ohlc',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('real 51-hour composition graph executes APP-1 with closed provider identities', async () => {
  const calls = [];
  const sleepCalls = [];
  const fetch = makeSuccessfulFetch({ calls });
  const composition = createProductionReplayComposition({
    fetch,
    logger: makeLogger(),
    config: makeConfig(),
    clock: makeClock(),
    riskPolicySource: makeRiskPolicySource(),
    sleep: async delay => sleepCalls.push(delay),
  });

  const result = await runQuietly(() => composition.application.run({
    symbol: 'BTCUSDT',
    startTime: BASE_TIME,
    endTime: END_TIME,
  }));

  const binanceCalls = calls.filter(call => call.url.pathname === '/api/v3/klines');
  const analyzerCalls = calls.filter(call => call.url.pathname === '/api/v3/coins/bitcoin/market_chart/range');

  assert.deepEqual(
    [...new Set(binanceCalls.map(call => call.url.searchParams.get('interval')))],
    ['1m', '5m', '15m', '1h'],
  );
  assert.equal(binanceCalls.every(call => call.url.searchParams.get('symbol') === 'BTCUSDT'), true);
  assert.equal(binanceCalls.every(call => call.url.hostname === 'data-api.binance.vision'), true);
  assert.equal(binanceCalls.every(call => call.url.searchParams.get('limit') === '1000'), true);
  assert.equal(binanceCalls.every(call => call.options.timeout === 4321), true);
  assert.equal(analyzerCalls.length, 1);
  assert.equal(analyzerCalls[0].url.hostname, 'api.coingecko.com');
  assert.equal(analyzerCalls[0].url.searchParams.get('vs_currency'), 'usd');
  assert.equal(analyzerCalls[0].url.searchParams.get('interval'), 'hourly');
  assert.equal(analyzerCalls[0].options.headers['x-cg-demo-api-key'], PROVIDER_KEY);
  assert.equal(analyzerCalls[0].url.href.includes(PROVIDER_KEY), false);
  assert.deepEqual(sleepCalls, []);

  assert.deepEqual(Object.keys(result), ['replay', 'provenance']);
  assert.equal(result.replay.cycles.length, PRIMARY_COUNT);
  assert.equal(result.replay.runnerState.status, 'EXHAUSTED');
  assert.equal(result.replay.runnerState.failure, null);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.replay), true);
  assert.equal(Object.hasOwn(result, 'totalCandles'), false);
  assert.equal(Object.hasOwn(result, 'rejections'), false);
  assert.equal(Object.hasOwn(result, 'engineVersion'), false);
  assert.equal(JSON.stringify(result).includes(PROVIDER_KEY), false);
});

test('existing retry policy values reach Binance without mapping MAX_RETRIES', async () => {
  const calls = [];
  const sleepCalls = [];
  const composition = createProductionReplayComposition({
    fetch: makeSuccessfulFetch({ calls, failFirstKline: true }),
    logger: makeLogger(),
    config: makeConfig({ MAX_RETRIES: 99 }),
    clock: makeClock(),
    riskPolicySource: makeRiskPolicySource(),
    sleep: async delay => sleepCalls.push(delay),
  });

  await runQuietly(() => composition.application.run({
    symbol: 'BTCUSDT',
    startTime: BASE_TIME,
    endTime: END_TIME,
  }));

  assert.deepEqual(sleepCalls, [765]);
  assert.equal(calls[0].url.hostname, 'data-api.binance.vision');
  assert.equal(calls[0].url.searchParams.get('limit'), '1000');
});

test('repeated composition creates fresh hidden graphs without exposing providers', () => {
  const first = compose().composition;
  const second = compose().composition;

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.application, second.application);
  assert.equal(Object.hasOwn(first, 'mtfSource'), false);
  assert.equal(Object.hasOwn(first, 'analyzerSource'), false);
  assert.equal(Object.hasOwn(first, 'credential'), false);
  assert.equal(Object.hasOwn(first, 'config'), false);
});
