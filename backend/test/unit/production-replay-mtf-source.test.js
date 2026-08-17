const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProductionReplayMtfSource,
  ProductionReplayMtfSourceError,
  PRODUCTION_REPLAY_MTF_PROVIDER,
  PRODUCTION_REPLAY_MTF_TIMEFRAMES,
} = require('../../src/engine/productionReplayMtfSource');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');

const BASE_TIME = Date.UTC(2024, 0, 1);
const THREE_HOUR_END = BASE_TIME + 3 * REPLAY_MTF_DURATIONS_MS['1h'];

function makeCandle(timeframe, openTime, index, overrides = {}) {
  const value = 100 + index;
  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    open: value,
    high: value + 1,
    low: value - 1,
    close: value,
    volume: index + 1,
    ...overrides,
  };
}

function makeResult(timeframe, startTime = BASE_TIME, endTime = THREE_HOUR_END, options = {}) {
  const durationMs = REPLAY_MTF_DURATIONS_MS[timeframe];
  const count = (endTime - startTime) / durationMs;
  const candles = options.candles || Array.from({ length: count }, (_, index) =>
    makeCandle(timeframe, startTime + index * durationMs, index));
  const diagnostics = {
    provider: PRODUCTION_REPLAY_MTF_PROVIDER,
    symbol: 'BTCUSDT',
    timeframe,
    startTime,
    endTime,
    pageCount: 1,
    attemptCount: 1,
    candleCount: candles.length,
    firstOpenTime: startTime,
    lastOpenTime: endTime - durationMs,
    ...options.diagnostics,
  };
  return { candles, diagnostics };
}

function makeResults(startTime = BASE_TIME, endTime = THREE_HOUR_END) {
  return Object.fromEntries(PRODUCTION_REPLAY_MTF_TIMEFRAMES.map(timeframe => [
    timeframe,
    makeResult(timeframe, startTime, endTime),
  ]));
}

function makeClient(results, options = {}) {
  const calls = [];
  const client = {
    async fetchCandles(request) {
      calls.push(structuredClone(request));
      if (options.failure?.timeframe === request.timeframe) {
        throw options.failure.error;
      }
      return options.results?.[request.timeframe] || results[request.timeframe];
    },
  };
  return { client, calls };
}

function makeSource(results = makeResults(), options = {}) {
  const { client, calls } = makeClient(results, options);
  return { source: new ProductionReplayMtfSource({ client }), calls };
}

function request(startTime = BASE_TIME, endTime = THREE_HOUR_END) {
  return { symbol: 'BTCUSDT', startTime, endTime };
}

async function assertSourceError(promise, code, details = {}) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ProductionReplayMtfSourceError);
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(details)) assert.equal(error[key], value);
    return true;
  });
}

function expectedCalls(startTime = BASE_TIME, endTime = THREE_HOUR_END) {
  return PRODUCTION_REPLAY_MTF_TIMEFRAMES.map(timeframe => ({
    symbol: 'BTCUSDT',
    timeframe,
    startTime,
    endTime,
  }));
}

test('acquires four independent streams in exact order with exact requests', async () => {
  const { source, calls } = makeSource();
  const result = await source.fetch(request());

  assert.deepEqual(calls, expectedCalls());
  assert.deepEqual(Object.keys(result.rawInput), [
    'schemaVersion',
    'primaryTimeframe',
    'sourcePolicy',
    'timeframes',
  ]);
  assert.deepEqual(Object.keys(result.rawInput.timeframes), PRODUCTION_REPLAY_MTF_TIMEFRAMES);
  assert.equal(result.rawInput.schemaVersion, 2);
  assert.equal(result.rawInput.primaryTimeframe, '1h');
  assert.equal(result.rawInput.sourcePolicy, 'independent');
  assert.deepEqual(Object.keys(result.provenance), [
    'provider',
    'symbol',
    'requestedStartTime',
    'requestedEndTime',
    'streams',
  ]);
});

test('preserves native OHLCV values and emits no closeTime', async () => {
  const results = makeResults();
  const { source } = makeSource(results);
  const result = await source.fetch(request());
  const candle = result.rawInput.timeframes['5m'][0];
  const expected = results['5m'].candles[0];

  assert.deepEqual(candle, expected);
  assert.equal(Object.hasOwn(candle, 'closeTime'), false);
});

test('shallow-copies stream arrays without cloning or mutating candle objects', async () => {
  const results = makeResults();
  const before = structuredClone(results);
  const { source } = makeSource(results);
  const result = await source.fetch(request());

  for (const timeframe of PRODUCTION_REPLAY_MTF_TIMEFRAMES) {
    assert.notStrictEqual(result.rawInput.timeframes[timeframe], results[timeframe].candles);
    assert.strictEqual(result.rawInput.timeframes[timeframe][0], results[timeframe].candles[0]);
  }
  assert.deepEqual(results, before);
});

test('proves exact multi-hour counts and boundaries for every stream', async () => {
  const { source } = makeSource();
  const { rawInput, provenance } = await source.fetch(request());
  const expectedCounts = { '1m': 180, '5m': 36, '15m': 12, '1h': 3 };

  for (const timeframe of PRODUCTION_REPLAY_MTF_TIMEFRAMES) {
    const durationMs = REPLAY_MTF_DURATIONS_MS[timeframe];
    const stream = rawInput.timeframes[timeframe];
    const metadata = provenance.streams[timeframe];
    assert.equal(stream.length, expectedCounts[timeframe]);
    assert.equal(stream[0].openTime, BASE_TIME);
    assert.equal(stream.at(-1).openTime, THREE_HOUR_END - durationMs);
    assert.equal(metadata.candleCount, expectedCounts[timeframe]);
    assert.equal(metadata.firstOpenTime, BASE_TIME);
    assert.equal(metadata.lastOpenTime, THREE_HOUR_END - durationMs);
  }
});

test('successful rawInput is accepted unchanged by the existing schema-v2 normalizer', async () => {
  const endTime = BASE_TIME + 51 * REPLAY_MTF_DURATIONS_MS['1h'];
  const results = makeResults(BASE_TIME, endTime);
  const { source } = makeSource(results);
  const { rawInput } = await source.fetch(request(BASE_TIME, endTime));
  const normalized = normalizeReplayMultiTimeframeInput(rawInput);

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.primaryTimeframe, '1h');
  assert.equal(normalized.sourcePolicy, 'independent');
  assert.deepEqual(
    Object.fromEntries(PRODUCTION_REPLAY_MTF_TIMEFRAMES.map(timeframe => [
      timeframe,
      normalized.timeframes[timeframe].length,
    ])),
    { '1m': 3060, '5m': 612, '15m': 204, '1h': 51 },
  );
});

test('provenance is exact, deterministic, and contains no wall-clock metadata', async () => {
  const results = makeResults();
  results['1m'].diagnostics.pageCount = 2;
  results['1m'].diagnostics.attemptCount = 3;
  const first = await makeSource(results).source.fetch(request());
  const second = await makeSource(results).source.fetch(request());

  assert.deepEqual(second, first);
  assert.equal(first.provenance.provider, PRODUCTION_REPLAY_MTF_PROVIDER);
  assert.equal(first.provenance.symbol, 'BTCUSDT');
  assert.equal(first.provenance.requestedStartTime, BASE_TIME);
  assert.equal(first.provenance.requestedEndTime, THREE_HOUR_END);
  assert.equal(first.provenance.streams['1m'].pageCount, 2);
  assert.equal(first.provenance.streams['1m'].attemptCount, 3);
  assert.equal(Object.hasOwn(first.provenance, 'fetchedAt'), false);
  assert.equal(JSON.stringify(first).includes('fetchedAt'), false);
});

test('rejects invalid symbol before client I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(source.fetch({ symbol: 'btcusdt', startTime: BASE_TIME, endTime: THREE_HOUR_END }), 'INVALID_REQUEST');
  assert.deepEqual(calls, []);
});

test('rejects invalid startTime before client I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(source.fetch(request(NaN, THREE_HOUR_END)), 'INVALID_REQUEST');
  assert.deepEqual(calls, []);
});

test('rejects invalid endTime before client I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(source.fetch(request(BASE_TIME, Infinity)), 'INVALID_REQUEST');
  assert.deepEqual(calls, []);
});

test('rejects non-increasing horizon before client I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(source.fetch(request(BASE_TIME, BASE_TIME)), 'INVALID_REQUEST');
  assert.deepEqual(calls, []);
});

test('rejects unaligned startTime before client I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(source.fetch(request(BASE_TIME + 60_000, THREE_HOUR_END)), 'UNALIGNED_HORIZON');
  assert.deepEqual(calls, []);
});

test('rejects unaligned endTime before client I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(source.fetch(request(BASE_TIME, THREE_HOUR_END + 60_000)), 'UNALIGNED_HORIZON');
  assert.deepEqual(calls, []);
});

test('wraps first-stream failure and stops acquisition immediately', async () => {
  const cause = Object.assign(new Error('1m failed'), { code: 'RETRY_EXHAUSTED' });
  const { source, calls } = makeSource(makeResults(), { failure: { timeframe: '1m', error: cause } });

  await assertSourceError(source.fetch(request()), 'STREAM_FAILURE', {
    failedTimeframe: '1m',
    timeframe: '1m',
    originalCode: 'RETRY_EXHAUSTED',
    cause,
  });
  assert.deepEqual(calls, [expectedCalls()[0]]);
});

test('middle-stream failure discards prior streams and never calls later streams', async () => {
  const cause = Object.assign(new Error('15m failed'), { code: 'HTTP_ERROR' });
  const { source, calls } = makeSource(makeResults(), { failure: { timeframe: '15m', error: cause } });
  let escaped;

  try {
    escaped = await source.fetch(request());
  } catch (error) {
    assert.equal(error.code, 'STREAM_FAILURE');
    assert.equal(error.failedTimeframe, '15m');
    assert.strictEqual(error.cause, cause);
  }

  assert.equal(escaped, undefined);
  assert.deepEqual(calls, expectedCalls().slice(0, 3));
});

test('final-stream failure rejects the complete source without a partial rawInput', async () => {
  const cause = Object.assign(new Error('1h failed'), { code: 'RETRY_EXHAUSTED' });
  const { source, calls } = makeSource(makeResults(), { failure: { timeframe: '1h', error: cause } });

  await assertSourceError(source.fetch(request()), 'STREAM_FAILURE', {
    failedTimeframe: '1h',
    originalCode: 'RETRY_EXHAUSTED',
  });
  assert.deepEqual(calls, expectedCalls());
});

test('rejects missing result, missing candles, and non-array candles', async () => {
  for (const replacement of [undefined, { diagnostics: {} }, { candles: {}, diagnostics: {} }]) {
    const results = makeResults();
    results['1m'] = replacement;
    const { source } = makeSource(results);
    await assertSourceError(source.fetch(request()), 'STREAM_CONTRACT');
  }
});

test('rejects missing diagnostics', async () => {
  const results = makeResults();
  delete results['5m'].diagnostics;
  const { source } = makeSource(results);
  await assertSourceError(source.fetch(request()), 'STREAM_CONTRACT');
});

test('rejects every required diagnostics mismatch as cross-stream mismatch', async () => {
  const mismatches = [
    ['provider', 'other-provider'],
    ['symbol', 'ETHUSDT'],
    ['timeframe', '1h'],
    ['startTime', BASE_TIME + REPLAY_MTF_DURATIONS_MS['1h']],
    ['endTime', THREE_HOUR_END + REPLAY_MTF_DURATIONS_MS['1h']],
    ['candleCount', 1],
    ['firstOpenTime', BASE_TIME + 60_000],
    ['lastOpenTime', THREE_HOUR_END],
  ];

  for (const [field, value] of mismatches) {
    const results = makeResults();
    results['5m'].diagnostics[field] = value;
    const { source } = makeSource(results);
    await assertSourceError(source.fetch(request()), 'CROSS_STREAM_MISMATCH', { field });
  }
});

test('rejects mathematical candle count mismatch even when diagnostics agree', async () => {
  const results = makeResults();
  results['15m'].candles = results['15m'].candles.slice(0, -1);
  results['15m'].diagnostics.candleCount = results['15m'].candles.length;
  const { source } = makeSource(results);

  await assertSourceError(source.fetch(request()), 'CROSS_STREAM_MISMATCH', {
    timeframe: '15m',
    field: 'candleCount',
    expected: 12,
  });
});

test('rejects shared stream array identity', async () => {
  const results = makeResults();
  results['5m'].candles = results['1m'].candles;
  const { source } = makeSource(results);

  await assertSourceError(source.fetch(request()), 'STREAM_CONTRACT', { timeframe: '5m' });
});

test('rejects shared candle object identity across streams', async () => {
  const results = makeResults();
  results['5m'].candles[0] = results['1m'].candles[0];
  const { source } = makeSource(results);

  await assertSourceError(source.fetch(request()), 'STREAM_CONTRACT', { timeframe: '5m' });
});

test('rejects closeTime in an M1A candle rather than emitting it downstream', async () => {
  const results = makeResults();
  results['1m'].candles[0].closeTime = BASE_TIME + REPLAY_MTF_DURATIONS_MS['1m'];
  const { source } = makeSource(results);

  await assertSourceError(source.fetch(request()), 'STREAM_CONTRACT', { timeframe: '1m' });
});

test('calls each timeframe exactly once without adding a retry layer', async () => {
  const { source, calls } = makeSource();
  await source.fetch(request());
  assert.deepEqual(calls, expectedCalls());
  assert.equal(calls.length, 4);
});

test('does not mutate the caller request or M1A results', async () => {
  const results = makeResults();
  const originalRequest = request();
  const requestBefore = structuredClone(originalRequest);
  const resultsBefore = structuredClone(results);
  const { source } = makeSource(results);

  await source.fetch(originalRequest);

  assert.deepEqual(originalRequest, requestBefore);
  assert.deepEqual(results, resultsBefore);
});

test('has no aggregation, resampling, or fallback ownership references', () => {
  const sourceText = fs.readFileSync(
    require.resolve('../../src/engine/productionReplayMtfSource'),
    'utf8',
  );
  assert.doesNotMatch(sourceText, /CandleEngine|CoinGecko|aggregate|resampl|fallback/i);
});

test('repeated acquisition with identical results is deterministic', async () => {
  const first = await makeSource().source.fetch(request());
  const second = await makeSource().source.fetch(request());

  assert.deepEqual(second, first);
});
