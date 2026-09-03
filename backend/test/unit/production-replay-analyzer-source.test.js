const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProductionReplayAnalyzerSource,
  ProductionReplayAnalyzerSourceError,
} = require('../../src/engine/productionReplayAnalyzerSource');
const { ReplayAnalyzerInputError } = require('../../src/engine/replayAnalyzerInput');
const { createReplayAnalyzerHistory } = require('../../src/engine/replayAnalyzerHistory');
const { createReplayAnalyzerOrchestrator } = require('../../src/engine/replayAnalyzerOrchestrator');

const START_TIME = Date.parse('2026-01-10T00:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const END_TIME = START_TIME + 3 * HOUR_MS;
const SYMBOL = 'BTCUSDT';
const COIN_ID = 'bitcoin';
const VS_CURRENCY = 'usd';
const HASH = 'a'.repeat(64);

function makeEvents({ startTime = START_TIME, count = 3, price = 45_000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: startTime + index * HOUR_MS,
    price: price + index,
    volume: 1_000 + index,
    change24h: 2.5 + index / 10,
  }));
}

function makeResult({ events = makeEvents(), diagnostics = {} } = {}) {
  const startTime = events[0]?.timestamp ?? START_TIME;
  const endTime = startTime + events.length * HOUR_MS;
  return {
    events,
    diagnostics: {
      provider: 'coingecko',
      coinId: COIN_ID,
      vsCurrency: VS_CURRENCY,
      targetStartTime: startTime,
      targetEndTime: endTime,
      acquisitionStartTime: startTime - DAY_MS,
      acquisitionEndTime: endTime,
      eventCount: events.length,
      firstEventTimestamp: events[0]?.timestamp,
      lastEventTimestamp: events.at(-1)?.timestamp,
      rawPayloadSha256: HASH,
      ...diagnostics,
    },
  };
}

function makeClient(result = makeResult(), options = {}) {
  const calls = [];
  const client = {
    async fetchHistoricalAnalyzerData(request) {
      calls.push(request);
      if (options.error) throw options.error;
      return options.result ?? result;
    },
  };
  return { client, calls };
}

function makeSource(result = makeResult(), options = {}) {
  const { client, calls } = makeClient(result, options);
  const source = new ProductionReplayAnalyzerSource({
    client,
    symbol: options.symbol ?? SYMBOL,
    coinId: options.coinId ?? COIN_ID,
    vsCurrency: options.vsCurrency ?? VS_CURRENCY,
  });
  return { source, calls };
}

function request(startTime = START_TIME, endTime = END_TIME) {
  return { symbol: SYMBOL, startTime, endTime };
}

async function assertSourceError(operation, code, details = {}) {
  await assert.rejects(Promise.resolve().then(operation), error => {
    assert.ok(error instanceof ProductionReplayAnalyzerSourceError);
    assert.equal(error.name, 'ProductionReplayAnalyzerSourceError');
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(details)) assert.equal(error[key], value);
    return true;
  });
}

test('exports exactly the approved A1H2 API', () => {
  assert.deepEqual(Object.keys(require('../../src/engine/productionReplayAnalyzerSource')), [
    'ProductionReplayAnalyzerSource',
    'ProductionReplayAnalyzerSourceError',
  ]);
  assert.deepEqual(Object.getOwnPropertyNames(ProductionReplayAnalyzerSource.prototype), [
    'constructor',
    'fetch',
  ]);
});

test('successfully transforms A1H1 events into normalized Analyzer input and provenance', async () => {
  const { source, calls } = makeSource();
  const result = await source.fetch(request());

  assert.deepEqual(Object.keys(result), ['analyzerInput', 'provenance']);
  assert.deepEqual(Object.keys(result.analyzerInput), ['schemaVersion', 'symbol', 'snapshots']);
  assert.equal(result.analyzerInput.schemaVersion, 1);
  assert.equal(result.analyzerInput.symbol, SYMBOL);
  assert.deepEqual(result.analyzerInput.snapshots, [
    {
      timestamp: '2026-01-10T00:00:00.000Z',
      price: 45_000,
      volume: 1_000,
      change24h: 2.5,
    },
    {
      timestamp: '2026-01-10T01:00:00.000Z',
      price: 45_001,
      volume: 1_001,
      change24h: 2.6,
    },
    {
      timestamp: '2026-01-10T02:00:00.000Z',
      price: 45_002,
      volume: 1_002,
      change24h: 2.7,
    },
  ]);
  assert.deepEqual(calls, [{ startTime: START_TIME, endTime: END_TIME }]);
});

test('preserves exact event count, values, and instants without cadence rewriting', async () => {
  const events = [
    { timestamp: START_TIME, price: 45_000.125, volume: 0, change24h: -3.75 },
    { timestamp: START_TIME + HOUR_MS, price: 45_000.875, volume: 987_654.321, change24h: 4.125 },
    { timestamp: START_TIME + 2 * HOUR_MS, price: 45_100.5, volume: 1, change24h: 0 },
  ];
  const { source } = makeSource(makeResult({ events }));
  const { analyzerInput } = await source.fetch(request());

  assert.equal(analyzerInput.snapshots.length, events.length);
  for (const [index, event] of events.entries()) {
    const snapshot = analyzerInput.snapshots[index];
    assert.equal(Date.parse(snapshot.timestamp), event.timestamp);
    assert.equal(snapshot.price, event.price);
    assert.equal(snapshot.volume, event.volume);
    assert.equal(snapshot.change24h, event.change24h);
  }
});

test('returns frozen analyzer input, snapshots, provenance, and outer result', async () => {
  const { source } = makeSource();
  const result = await source.fetch(request());

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.analyzerInput));
  assert.ok(Object.isFrozen(result.analyzerInput.snapshots));
  assert.ok(result.analyzerInput.snapshots.every(Object.isFrozen));
  assert.ok(Object.isFrozen(result.provenance));
});

test('returns exact deterministic provenance without wall-clock metadata', async () => {
  const { source } = makeSource();
  const { provenance } = await source.fetch(request());

  assert.deepEqual(Object.keys(provenance), [
    'sourceType',
    'semanticMode',
    'provider',
    'coinId',
    'vsCurrency',
    'symbol',
    'requestedStartTime',
    'requestedEndTime',
    'acquisitionStartTime',
    'acquisitionEndTime',
    'eventCount',
    'firstEventTimestamp',
    'lastEventTimestamp',
    'rawPayloadSha256',
  ]);
  assert.deepEqual(provenance, {
    sourceType: 'production-replay-analyzer',
    semanticMode: 'historical-equivalent',
    provider: 'coingecko',
    coinId: COIN_ID,
    vsCurrency: VS_CURRENCY,
    symbol: SYMBOL,
    requestedStartTime: START_TIME,
    requestedEndTime: END_TIME,
    acquisitionStartTime: START_TIME - DAY_MS,
    acquisitionEndTime: END_TIME,
    eventCount: 3,
    firstEventTimestamp: START_TIME,
    lastEventTimestamp: END_TIME - HOUR_MS,
    rawPayloadSha256: HASH,
  });
  assert.equal(Object.hasOwn(provenance, 'fetchedAt'), false);
  assert.equal(Object.hasOwn(provenance, 'requestId'), false);
  assert.equal(Object.hasOwn(provenance, 'now'), false);
});

test('repeated identical results are deeply deterministic with fresh output objects', async () => {
  const first = await makeSource().source.fetch(request());
  const second = await makeSource().source.fetch(request());

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.analyzerInput, second.analyzerInput);
  assert.deepEqual(first, second);
});

test('calls A1H1 exactly once with only startTime and endTime', async () => {
  const { source, calls } = makeSource();
  await source.fetch(request());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { startTime: START_TIME, endTime: END_TIME });
  assert.equal(Object.hasOwn(calls[0], 'symbol'), false);
});

test('does not return rawInput, raw events, or semanticMode inside analyzerInput', async () => {
  const { source } = makeSource();
  const result = await source.fetch(request());

  assert.equal(Object.hasOwn(result, 'rawInput'), false);
  assert.equal(Object.hasOwn(result, 'events'), false);
  assert.equal(Object.hasOwn(result.analyzerInput, 'semanticMode'), false);
});

test('does not mutate the request, result, events, or diagnostics', async () => {
  const events = makeEvents();
  const result = makeResult({ events });
  const requestValue = request();
  const beforeRequest = structuredClone(requestValue);
  const beforeResult = structuredClone(result);
  const { source } = makeSource(result);

  await source.fetch(requestValue);

  assert.deepEqual(requestValue, beforeRequest);
  assert.deepEqual(result, beforeResult);
  assert.strictEqual(result.events[0], events[0]);
});

test('binds and validates explicit constructor identity without environment access', () => {
  assert.throws(
    () => new ProductionReplayAnalyzerSource({ symbol: SYMBOL, coinId: COIN_ID, vsCurrency: VS_CURRENCY }),
    /client\.fetchHistoricalAnalyzerData/,
  );
  assert.throws(
    () => new ProductionReplayAnalyzerSource({ client: {}, symbol: SYMBOL, coinId: COIN_ID, vsCurrency: VS_CURRENCY }),
    /client\.fetchHistoricalAnalyzerData/,
  );
  assert.throws(
    () => new ProductionReplayAnalyzerSource({ client: {}, symbol: '', coinId: COIN_ID, vsCurrency: VS_CURRENCY }),
    /client\.fetchHistoricalAnalyzerData/,
  );

  const { client } = makeClient();
  for (const [field, value, matcher] of [
    ['symbol', '', /symbol must be a non-empty string/],
    ['coinId', 'Bitcoin', /coinId must be a lowercase/],
    ['vsCurrency', 'USD', /vsCurrency must be a lowercase/],
  ]) {
    assert.throws(
      () => new ProductionReplayAnalyzerSource({ client, symbol: SYMBOL, coinId: COIN_ID, vsCurrency: VS_CURRENCY, [field]: value }),
      matcher,
    );
  }
});

test('rejects invalid request roots and unexpected properties before A1H1 I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(() => source.fetch([]), 'INVALID_REQUEST');
  await assertSourceError(() => source.fetch(new Date()), 'INVALID_REQUEST');
  await assertSourceError(() => source.fetch({ ...request(), extra: true }), 'INVALID_REQUEST');
  await assertSourceError(() => source.fetch({ ...request(), [Symbol('extra')]: true }), 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('rejects symbol mismatch before A1H1 I/O', async () => {
  const { source, calls } = makeSource();
  await assertSourceError(() => source.fetch({ ...request(), symbol: 'ETHUSDT' }), 'SYMBOL_MISMATCH');
  assert.equal(calls.length, 0);
});

test('rejects invalid timestamps and non-increasing horizons before A1H1 I/O', async () => {
  const { source, calls } = makeSource();
  for (const value of [undefined, null, NaN, Infinity, -1, 1.5, 'not-a-timestamp', 8_640_000_000_000_001]) {
    await assertSourceError(() => source.fetch({ ...request(), startTime: value }), 'INVALID_REQUEST');
    await assertSourceError(() => source.fetch({ ...request(), endTime: value }), 'INVALID_REQUEST');
  }
  await assertSourceError(() => source.fetch(request(START_TIME, START_TIME)), 'INVALID_REQUEST');
  await assertSourceError(() => source.fetch(request(END_TIME, START_TIME)), 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('wraps A1H1 failures as SOURCE_FAILURE with originalCode and cause', async () => {
  const cause = new Error('provider unavailable');
  cause.code = 'PROVIDER_UNAVAILABLE';
  const { source } = makeSource(makeResult(), { error: cause });

  await assertSourceError(() => source.fetch(request()), 'SOURCE_FAILURE', {
    originalCode: 'PROVIDER_UNAVAILABLE',
    cause,
  });
});

test('preserves the exact real normalizer cause in NORMALIZATION_FAILURE', async () => {
  const events = makeEvents();
  events[1].price = 0;
  const { source } = makeSource(makeResult({ events }));

  await assert.rejects(source.fetch(request()), error => {
    assert.ok(error instanceof ProductionReplayAnalyzerSourceError);
    assert.equal(error.code, 'NORMALIZATION_FAILURE');
    assert.equal(error.originalCode, 'INVALID_PRICE');
    assert.notEqual(error.cause, undefined);
    assert.ok(error.cause instanceof ReplayAnalyzerInputError);
    assert.equal(error.cause.code, 'INVALID_PRICE');
    assert.equal(error.cause.name, 'ReplayAnalyzerInputError');
    return true;
  });
});

test('wraps a source error without code without installing originalCode', async () => {
  const cause = new Error('provider unavailable without code');
  const { source } = makeSource(makeResult(), { error: cause });

  await assert.rejects(source.fetch(request()), error => {
    assert.ok(error instanceof ProductionReplayAnalyzerSourceError);
    assert.equal(error.code, 'SOURCE_FAILURE');
    assert.equal(error.cause, cause);
    assert.equal(Object.hasOwn(error, 'originalCode'), false);
    return true;
  });
});

test('does not copy arbitrary enumerable source error metadata', async () => {
  const cause = new Error('provider metadata isolation');
  cause.secretMarker = 'must-not-copy';
  cause.headers = { synthetic: true };
  cause.extra = 123;
  const { source } = makeSource(makeResult(), { error: cause });

  await assert.rejects(source.fetch(request()), error => {
    assert.equal(error.code, 'SOURCE_FAILURE');
    assert.equal(error.cause, cause);
    assert.equal(Object.hasOwn(error, 'secretMarker'), false);
    assert.equal(Object.hasOwn(error, 'headers'), false);
    assert.equal(Object.hasOwn(error, 'extra'), false);
    return true;
  });
});

test('rejects malformed dependency roots and exact-key violations', async () => {
  const base = makeResult();
  const cases = [
    ['null root', null],
    ['array root', []],
    ['unknown root key', { ...base, extra: true }],
    ['symbol root key', { ...base, [Symbol('extra')]: true }],
    ['missing events', { diagnostics: base.diagnostics }],
    ['missing diagnostics', { events: base.events }],
    ['empty events', makeResult({ events: [] })],
    ['sparse events', makeResult({ events: Object.assign(new Array(3), { 0: makeEvents()[0] }) })],
    ['non-object diagnostics', { ...base, diagnostics: null }],
    ['unknown diagnostics key', makeResult({ diagnostics: { ...base.diagnostics, extra: true } })],
  ];

  for (const [label, result] of cases) {
    const { source } = makeSource(result);
    await assertSourceError(() => source.fetch(request()), 'SOURCE_CONTRACT');
    assert.ok(label);
  }
});

test('rejects shared, malformed, missing, and unknown event fields', async () => {
  const shared = makeEvents()[0];
  const sharedResult = makeResult({ events: [shared, shared, makeEvents()[2]] });
  await assertSourceError(() => makeSource(sharedResult).source.fetch(request()), 'SOURCE_CONTRACT');

  const malformed = makeEvents();
  malformed[1] = null;
  await assertSourceError(() => makeSource(makeResult({ events: malformed })).source.fetch(request()), 'SOURCE_CONTRACT');

  const missing = makeEvents();
  delete missing[1].volume;
  await assertSourceError(() => makeSource(makeResult({ events: missing })).source.fetch(request()), 'SOURCE_CONTRACT');

  const unknown = makeEvents();
  unknown[1].extra = true;
  await assertSourceError(() => makeSource(makeResult({ events: unknown })).source.fetch(request()), 'SOURCE_CONTRACT');
});

test('rejects invalid event timestamps without leaking RangeError', async () => {
  for (const timestamp of [undefined, null, NaN, Infinity, -1, 1.5, '2026-01-10T00:00:00.000Z', 8_640_000_000_000_001]) {
    const events = makeEvents();
    events[1].timestamp = timestamp;
    const result = makeResult({ events });
    result.diagnostics.firstEventTimestamp = events[0].timestamp;
    result.diagnostics.lastEventTimestamp = events.at(-1).timestamp;
    await assertSourceError(() => makeSource(result).source.fetch(request()), 'SOURCE_CONTRACT');
  }
});

test('rejects dependency diagnostic mismatches', async () => {
  const base = makeResult().diagnostics;
  const mismatches = [
    ['provider', 'other'],
    ['coinId', 'ethereum'],
    ['vsCurrency', 'eur'],
    ['targetStartTime', START_TIME + 1],
    ['targetEndTime', END_TIME + 1],
    ['acquisitionStartTime', START_TIME],
    ['acquisitionEndTime', END_TIME + 1],
    ['eventCount', 2],
    ['firstEventTimestamp', START_TIME + 1],
    ['lastEventTimestamp', END_TIME],
  ];

  for (const [field, value] of mismatches) {
    const result = makeResult({ diagnostics: { ...base, [field]: value } });
    await assertSourceError(() => makeSource(result).source.fetch(request()), 'SOURCE_CONTRACT');
  }
});

test('rejects event horizons that do not preserve exact first and last target events', async () => {
  const firstMismatch = makeEvents();
  firstMismatch[0].timestamp += HOUR_MS;
  const firstResult = makeResult({ events: firstMismatch });
  firstResult.diagnostics.targetStartTime = START_TIME;
  await assertSourceError(() => makeSource(firstResult).source.fetch(request()), 'SOURCE_CONTRACT');

  const lastMismatch = makeEvents();
  lastMismatch[2].timestamp += HOUR_MS;
  const lastResult = makeResult({ events: lastMismatch });
  await assertSourceError(() => makeSource(lastResult).source.fetch(request()), 'SOURCE_CONTRACT');
});

test('rejects event count and expected hourly target count mismatches', async () => {
  const events = makeEvents({ count: 2 });
  const result = makeResult({ events, diagnostics: { eventCount: 3, targetEndTime: END_TIME } });
  await assertSourceError(() => makeSource(result).source.fetch(request()), 'SOURCE_CONTRACT');

  const countMismatch = makeResult({ diagnostics: { eventCount: 2 } });
  await assertSourceError(() => makeSource(countMismatch).source.fetch(request()), 'SOURCE_CONTRACT');
});

test('rejects malformed payload hashes without recomputing them', async () => {
  for (const rawPayloadSha256 of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), '', undefined, Symbol('hash')]) {
    const result = makeResult({ diagnostics: { rawPayloadSha256 } });
    await assertSourceError(() => makeSource(result).source.fetch(request()), 'SOURCE_CONTRACT');
  }
});

test('wraps normalizer failures as NORMALIZATION_FAILURE with originalCode and cause', async () => {
  for (const [field, value, originalCode] of [
    ['price', 0, 'INVALID_PRICE'],
    ['volume', -1, 'INVALID_VOLUME'],
    ['change24h', Infinity, 'INVALID_CHANGE24H'],
  ]) {
    const events = makeEvents();
    events[1][field] = value;
    const { source } = makeSource(makeResult({ events }));
    await assertSourceError(() => source.fetch(request()), 'NORMALIZATION_FAILURE', { originalCode });
  }
});

test('returns no partial output after dependency or normalization failure', async () => {
  const malformed = makeResult({ diagnostics: { provider: 'wrong' } });
  await assert.rejects(makeSource(malformed).source.fetch(request()), error => {
    assert.equal(error.code, 'SOURCE_CONTRACT');
    assert.equal(Object.hasOwn(error, 'analyzerInput'), false);
    assert.equal(Object.hasOwn(error, 'provenance'), false);
    return true;
  });
});

test('actual ReplayAnalyzerHistory accepts the returned normalized input', async () => {
  const { source } = makeSource();
  const { analyzerInput } = await source.fetch(request());
  const history = createReplayAnalyzerHistory(analyzerInput, {
    symbol: SYMBOL,
    maxHistory: 500,
  });

  history.advanceThrough(START_TIME + HOUR_MS);
  assert.deepEqual(history.all(), analyzerInput.snapshots.slice(0, 2));
});

test('actual ReplayAnalyzerOrchestrator preserves causal E <= T visibility', async () => {
  const { source } = makeSource();
  const { analyzerInput } = await source.fetch(request());
  const history = createReplayAnalyzerHistory(analyzerInput, {
    symbol: SYMBOL,
    maxHistory: 500,
  });
  const observed = [];
  const orchestrator = createReplayAnalyzerOrchestrator({
    source: analyzerInput,
    history,
    analyzer: {
      analyze(currentHistory) {
        observed.push(currentHistory.all());
      },
    },
    symbol: SYMBOL,
  });

  const t1 = START_TIME + 30 * 60 * 1000;
  orchestrator.runForBoundary(t1);
  assert.equal(history.getEventTimestamp(), START_TIME);
  assert.deepEqual(history.all(), analyzerInput.snapshots.slice(0, 1));
  assert.equal(history.all().length, 1);
  assert.equal(history.all().at(-1).timestamp, '2026-01-10T00:00:00.000Z');
  assert.equal(history.all().some(snapshot => Date.parse(snapshot.timestamp) > t1), false);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], analyzerInput.snapshots.slice(0, 1));
  assert.equal(observed[0].at(-1).timestamp, '2026-01-10T00:00:00.000Z');
  assert.equal(observed[0].some(snapshot => Date.parse(snapshot.timestamp) > t1), false);

  const t2 = START_TIME + HOUR_MS;
  orchestrator.runForBoundary(t2);
  assert.equal(history.getEventTimestamp(), START_TIME + HOUR_MS);
  assert.deepEqual(history.all(), analyzerInput.snapshots.slice(0, 2));
  assert.equal(history.all().length, 2);
  assert.equal(history.all().at(-1).timestamp, '2026-01-10T01:00:00.000Z');
  assert.equal(history.all().some(snapshot => Date.parse(snapshot.timestamp) > t2), false);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[1], analyzerInput.snapshots.slice(0, 2));
  assert.equal(observed[1].at(-1).timestamp, '2026-01-10T01:00:00.000Z');
  assert.equal(observed[1].some(snapshot => Date.parse(snapshot.timestamp) > t2), false);
});

test('does not hide Analyzer warm-up or request pre-start events', async () => {
  const { source, calls } = makeSource();
  await source.fetch(request());

  assert.deepEqual(calls, [{ startTime: START_TIME, endTime: END_TIME }]);
  assert.equal(calls.some(call => call.startTime < START_TIME), false);
});

test('production source has no forbidden runtime ownership or secret access', () => {
  const sourcePath = path.join(__dirname, '../../src/engine/productionReplayAnalyzerSource.js');
  const source = fs.readFileSync(sourcePath, 'utf8');

  for (const forbidden of [
    'process.env',
    'COINGECKO_DEMO_API_KEY',
    'Authorization',
    'console.log',
    'console.error',
    'Date.now',
    'fetchedAt',
    'StrategyReplay',
    'CandleEngine',
    'Binance',
    'MarketAnalyzer',
    'ReplayPipelineRunner',
    'routes',
    'server',
    'app.js',
  ]) {
    assert.equal(source.includes(forbidden), false, `source contains forbidden reference ${forbidden}`);
  }
});

test('forwards signal to the historical Analyzer client and preserves cancellation', async () => {
  const controller = new AbortController();
  const result = makeResult();
  const calls = [];
  const source = new ProductionReplayAnalyzerSource({
    client: {
      async fetchHistoricalAnalyzerData(requestValue, options) {
        calls.push({ request: requestValue, options });
        return result;
      },
    },
    symbol: SYMBOL,
    coinId: COIN_ID,
    vsCurrency: VS_CURRENCY,
  });

  await source.fetch(request(), { signal: controller.signal });
  assert.deepEqual(calls[0].request, { startTime: START_TIME, endTime: END_TIME });
  assert.equal(calls[0].options.signal, controller.signal);

  const cancelling = new AbortController();
  const cancellingSource = new ProductionReplayAnalyzerSource({
    client: {
      async fetchHistoricalAnalyzerData() {
        cancelling.abort();
        throw new Error('analyzer completion raced shutdown');
      },
    },
    symbol: SYMBOL,
    coinId: COIN_ID,
    vsCurrency: VS_CURRENCY,
  });
  await assert.rejects(
    cancellingSource.fetch(request(), { signal: cancelling.signal }),
    { message: 'analyzer completion raced shutdown' },
  );
});
