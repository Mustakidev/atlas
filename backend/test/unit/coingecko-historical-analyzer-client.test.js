const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CoinGeckoHistoricalAnalyzerClient,
  CoinGeckoHistoricalAnalyzerClientError,
} = require('../../src/network/coingeckoHistoricalAnalyzerClient');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TARGET_START = Date.parse('2026-01-10T00:00:00.000Z');
const TARGET_HOURS = 72;
const TARGET_END = TARGET_START + TARGET_HOURS * HOUR_MS;
const ACQUISITION_START = TARGET_START - DAY_MS;
const MAX_TARGET_HOURS = 99 * 24;
const TEST_API_KEY = 'test-demo-key';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makePayload({ targetStart = TARGET_START, targetHours = TARGET_HOURS } = {}) {
  const acquisitionStart = targetStart - DAY_MS;
  const count = targetHours + 25;
  return {
    prices: Array.from({ length: count }, (_, index) => [
      acquisitionStart + index * HOUR_MS,
      1000 + index * 2,
    ]),
    total_volumes: Array.from({ length: count }, (_, index) => [
      acquisitionStart + index * HOUR_MS,
      10_000 + index,
    ]),
  };
}

function response(body, status = 200) {
  return {
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function createClient(fetch, config = {}) {
  return new CoinGeckoHistoricalAnalyzerClient({
    fetch,
    logger: { info() {}, warn() {}, error() {} },
    config: {
      baseUrl: 'https://provider.example.test/api/v3',
      apiKey: TEST_API_KEY,
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      timeout: 3210,
      ...config,
    },
  });
}

function request(startTime = TARGET_START, endTime = TARGET_END) {
  return { startTime, endTime };
}

async function assertCode(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof CoinGeckoHistoricalAnalyzerClientError);
    assert.equal(error.name, 'CoinGeckoHistoricalAnalyzerClientError');
    assert.equal(error.code, code);
    return true;
  });
}

async function assertPayloadCode(payload, code, input = request()) {
  const client = createClient(async () => response(payload));
  await assertCode(() => client.fetchHistoricalAnalyzerData(input), code);
}

function expectedHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

test('fetches the exact 72-hour contract with isolated Demo authentication', async () => {
  const payload = makePayload();
  const calls = [];
  const client = createClient(async (url, options) => {
    calls.push({ url, options });
    return response(payload);
  });

  const result = await client.fetchHistoricalAnalyzerData(request());
  const url = new URL(calls[0].url);

  assert.equal(url.pathname, '/api/v3/coins/bitcoin/market_chart/range');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    vs_currency: 'usd',
    from: String(ACQUISITION_START / 1000),
    to: String(TARGET_END / 1000),
    interval: 'hourly',
    precision: 'full',
  });
  assert.deepEqual(calls[0].options, {
    headers: { 'x-cg-demo-api-key': TEST_API_KEY },
    timeout: 3210,
  });
  assert.deepEqual(Object.keys(result), ['events', 'diagnostics']);
  assert.equal(result.events.length, TARGET_HOURS);
  assert.deepEqual(Object.keys(result.events[0]), ['timestamp', 'price', 'volume', 'change24h']);
  assert.equal(result.events[0].timestamp, TARGET_START);
  assert.equal(result.events.at(-1).timestamp, TARGET_END - HOUR_MS);
  assert.deepEqual(result.diagnostics, {
    provider: 'coingecko',
    coinId: 'bitcoin',
    vsCurrency: 'usd',
    targetStartTime: TARGET_START,
    targetEndTime: TARGET_END,
    acquisitionStartTime: ACQUISITION_START,
    acquisitionEndTime: TARGET_END,
    eventCount: TARGET_HOURS,
    firstEventTimestamp: TARGET_START,
    lastEventTimestamp: TARGET_END - HOUR_MS,
    rawPayloadSha256: expectedHash(payload),
  });
  assert.equal(Object.hasOwn(result.diagnostics, 'semanticMode'), false);
});

test('uses the production defaults without widening or shrinking the acquisition range', async () => {
  const payload = makePayload();
  const calls = [];
  const client = new CoinGeckoHistoricalAnalyzerClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response(payload);
    },
    config: { apiKey: TEST_API_KEY },
  });

  const result = await client.fetchHistoricalAnalyzerData({
    startTime: TARGET_START,
    endTime: TARGET_END,
  });
  const url = new URL(calls[0].url);

  assert.equal(url.origin, 'https://api.coingecko.com');
  assert.equal(url.pathname, '/api/v3/coins/bitcoin/market_chart/range');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    vs_currency: 'usd',
    from: String(ACQUISITION_START / 1000),
    to: String(TARGET_END / 1000),
    interval: 'hourly',
    precision: 'full',
  });
  assert.equal(calls[0].options.timeout, 10000);
  assert.equal(result.events.length, TARGET_HOURS);
});

test('accepts an exact 99-day target without widening or shrinking the acquisition range', async () => {
  const payload = makePayload({ targetHours: MAX_TARGET_HOURS });
  const calls = [];
  const client = createClient(async (url, options) => {
    calls.push({ url, options });
    return response(payload);
  });
  const targetEnd = TARGET_START + MAX_TARGET_HOURS * HOUR_MS;
  const result = await client.fetchHistoricalAnalyzerData({
    startTime: TARGET_START,
    endTime: targetEnd,
  });
  const url = new URL(calls[0].url);

  assert.deepEqual(Object.fromEntries(url.searchParams), {
    vs_currency: 'usd',
    from: String(ACQUISITION_START / 1000),
    to: String(targetEnd / 1000),
    interval: 'hourly',
    precision: 'full',
  });
  assert.equal(result.events.length, MAX_TARGET_HOURS);
});

test('rejects a 99-day target plus one hour before network I/O', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls += 1;
    return response(makePayload());
  });

  await assertCode(() => client.fetchHistoricalAnalyzerData({
    startTime: TARGET_START,
    endTime: TARGET_START + (MAX_TARGET_HOURS + 1) * HOUR_MS,
  }), 'INVALID_REQUEST');
  assert.equal(calls, 0);
});

test('supports arbitrary aligned multi-hour horizons mathematically', async () => {
  const targetStart = TARGET_START + 5 * HOUR_MS;
  const targetHours = 7;
  const payload = makePayload({ targetStart, targetHours });
  const client = createClient(async () => response(payload));

  const result = await client.fetchHistoricalAnalyzerData({
    startTime: targetStart,
    endTime: targetStart + targetHours * HOUR_MS,
  });

  assert.equal(result.events.length, targetHours);
  assert.equal(result.diagnostics.acquisitionStartTime, targetStart - DAY_MS);
  assert.equal(result.diagnostics.acquisitionEndTime, targetStart + targetHours * HOUR_MS);
});

test('trims the target horizon as half-open while retaining exact provider timestamps', async () => {
  const payload = makePayload();
  const client = createClient(async () => response(payload));
  const result = await client.fetchHistoricalAnalyzerData(request());

  assert.equal(result.events.some(event => event.timestamp === TARGET_START), true);
  assert.equal(result.events.some(event => event.timestamp === TARGET_END), false);
  assert.equal(result.events.every(event => event.timestamp >= TARGET_START && event.timestamp < TARGET_END), true);
  assert.equal(result.events.every(event => Number.isInteger(event.timestamp)), true);
});

test('derives change24h from the exact pre-roll price without rounding or clamping', async () => {
  const payload = makePayload();
  const client = createClient(async () => response(payload));
  const result = await client.fetchHistoricalAnalyzerData(request());
  const event = result.events[0];
  const referencePrice = payload.prices[0][1];

  assert.equal(event.price, payload.prices[24][1]);
  assert.equal(event.volume, payload.total_volumes[24][1]);
  assert.equal(event.change24h, (event.price / referencePrice - 1) * 100);
  assert.notEqual(event.change24h, Math.round(event.change24h));
});

test('repeated identical payloads produce fresh but deterministic results', async () => {
  const payload = makePayload();
  const client = createClient(async () => response(payload));
  const first = await client.fetchHistoricalAnalyzerData(request());
  const second = await client.fetchHistoricalAnalyzerData(request());

  assert.deepEqual(first, second);
  assert.notStrictEqual(first.events, second.events);
  assert.equal(first.diagnostics.rawPayloadSha256, second.diagnostics.rawPayloadSha256);
});

test('does not mutate request or provider payload and does not alias provider points', async () => {
  const payload = makePayload();
  const originalPayload = clone(payload);
  const input = request();
  const originalInput = { ...input };
  const client = createClient(async () => response(payload));
  const result = await client.fetchHistoricalAnalyzerData(input);

  assert.deepEqual(input, originalInput);
  assert.deepEqual(payload, originalPayload);
  assert.notStrictEqual(result.events, payload.prices);
  assert.notStrictEqual(result.events[0], payload.prices[24]);
  assert.notStrictEqual(result.events[0], payload.total_volumes[24]);
});

test('keeps the API key out of errors and returned semantic objects', async () => {
  const client = createClient(async () => response({ error: 'unauthorized' }, 401));
  let error;
  try {
    await client.fetchHistoricalAnalyzerData(request());
  } catch (caught) {
    error = caught;
  }

  assert.equal(error.code, 'UNAUTHORIZED');
  assert.equal(Object.hasOwn(client, 'config'), false);
  assert.equal(JSON.stringify(client).includes(TEST_API_KEY), false);
  assert.equal(JSON.stringify(error).includes(TEST_API_KEY), false);
  assert.equal(error.message.includes(TEST_API_KEY), false);
});

test('does not expose wall-clock metadata or provider credentials in diagnostics', async () => {
  const payload = makePayload();
  const client = createClient(async () => response(payload));
  const result = await client.fetchHistoricalAnalyzerData(request());

  assert.deepEqual(Object.keys(result.diagnostics), [
    'provider',
    'coinId',
    'vsCurrency',
    'targetStartTime',
    'targetEndTime',
    'acquisitionStartTime',
    'acquisitionEndTime',
    'eventCount',
    'firstEventTimestamp',
    'lastEventTimestamp',
    'rawPayloadSha256',
  ]);
  assert.equal(JSON.stringify(result).includes(TEST_API_KEY), false);
  assert.equal(JSON.stringify(result).includes('fetchedAt'), false);
});

test('rejects malformed roots and missing required series', async () => {
  const payload = makePayload();
  await assertPayloadCode(null, 'PROVIDER_CONTRACT');
  await assertPayloadCode([], 'PROVIDER_CONTRACT');
  await assertPayloadCode({ total_volumes: payload.total_volumes }, 'PROVIDER_CONTRACT');
  await assertPayloadCode({ prices: payload.prices }, 'PROVIDER_CONTRACT');
});

test('rejects malformed provider points and non-numeric values without coercion', async () => {
  const cases = [
    ['malformed point', value => { value.prices[0] = [value.prices[0][0]]; }, 'PROVIDER_CONTRACT'],
    ['price string', value => { value.prices[0][1] = '100'; }, 'INVALID_NUMERIC_VALUE'],
    ['price boolean', value => { value.prices[0][1] = true; }, 'INVALID_NUMERIC_VALUE'],
    ['price NaN', value => { value.prices[0][1] = NaN; }, 'INVALID_NUMERIC_VALUE'],
    ['price Infinity', value => { value.prices[0][1] = Infinity; }, 'INVALID_NUMERIC_VALUE'],
    ['price zero', value => { value.prices[0][1] = 0; }, 'INVALID_NUMERIC_VALUE'],
    ['price negative', value => { value.prices[0][1] = -1; }, 'INVALID_NUMERIC_VALUE'],
    ['volume string', value => { value.total_volumes[0][1] = '100'; }, 'INVALID_NUMERIC_VALUE'],
    ['volume false', value => { value.total_volumes[0][1] = false; }, 'INVALID_NUMERIC_VALUE'],
    ['volume NaN', value => { value.total_volumes[0][1] = NaN; }, 'INVALID_NUMERIC_VALUE'],
    ['volume negative', value => { value.total_volumes[0][1] = -1; }, 'INVALID_NUMERIC_VALUE'],
  ];

  for (const [, mutate, code] of cases) {
    const payload = makePayload();
    mutate(payload);
    await assertPayloadCode(payload, code);
  }
});

test('rejects invalid provider timestamps, duplicates, and non-monotonic order', async () => {
  const cases = [
    [value => { value.prices[1][0] = value.prices[0][0]; }, 'DUPLICATE_TIMESTAMP'],
    [value => { value.total_volumes[1][0] = value.total_volumes[0][0]; }, 'DUPLICATE_TIMESTAMP'],
    [value => { value.prices[1][0] = value.prices[0][0] - HOUR_MS; }, 'NON_MONOTONIC_TIMESTAMP'],
    [value => { value.total_volumes[1][0] = value.total_volumes[0][0] - HOUR_MS; }, 'NON_MONOTONIC_TIMESTAMP'],
    [value => { value.prices[0][0] = 'not-a-timestamp'; }, 'INVALID_NUMERIC_VALUE'],
    [value => { value.total_volumes[0][0] = Number.MAX_SAFE_INTEGER + 1; }, 'INVALID_NUMERIC_VALUE'],
  ];

  for (const [mutate, code] of cases) {
    const payload = makePayload();
    mutate(payload);
    await assertPayloadCode(payload, code);
  }
});

test('rejects price-volume count and timestamp mismatches without repair', async () => {
  const countMismatch = makePayload();
  countMismatch.total_volumes.pop();
  await assertPayloadCode(countMismatch, 'TIMESTAMP_MISMATCH');

  const timestampMismatch = makePayload();
  for (let index = 0; index < timestampMismatch.total_volumes.length; index += 1) {
    timestampMismatch.total_volumes[index][0] += HOUR_MS;
  }
  await assertPayloadCode(timestampMismatch, 'TIMESTAMP_MISMATCH');
});

test('rejects cadence gaps and timestamp jitter', async () => {
  const gap = makePayload();
  for (let index = 1; index < gap.prices.length; index += 1) gap.prices[index][0] += HOUR_MS;
  await assertPayloadCode(gap, 'UNSUPPORTED_CADENCE');

  const jitter = makePayload();
  jitter.total_volumes[1][0] += 1;
  await assertPayloadCode(jitter, 'UNSUPPORTED_CADENCE');
});

test('rejects incomplete acquisition boundaries and incorrect raw counts', async () => {
  const missingStart = makePayload();
  for (const series of [missingStart.prices, missingStart.total_volumes]) {
    for (const point of series) point[0] += HOUR_MS;
  }
  await assertPayloadCode(missingStart, 'INCOMPLETE_HORIZON');

  const missingEnd = makePayload();
  for (const series of [missingEnd.prices, missingEnd.total_volumes]) {
    for (const point of series) point[0] -= HOUR_MS;
  }
  await assertPayloadCode(missingEnd, 'INCOMPLETE_HORIZON');

  const incorrectCount = makePayload();
  incorrectCount.prices.pop();
  incorrectCount.total_volumes.pop();
  await assertPayloadCode(incorrectCount, 'INCOMPLETE_HORIZON');
});

test('reports incomplete coverage before defensive 24-hour reference transformation', async () => {
  const payload = makePayload();
  payload.prices.shift();
  payload.total_volumes.shift();
  for (const series of [payload.prices, payload.total_volumes]) {
    for (const point of series) point[0] += HOUR_MS;
  }
  await assertPayloadCode(payload, 'INCOMPLETE_HORIZON');
});

test('rejects invalid requests before network I/O', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls += 1;
    return response(makePayload());
  });
  const cases = [
    [null, 'INVALID_REQUEST'],
    [[], 'INVALID_REQUEST'],
    [{ startTime: TARGET_START }, 'INVALID_REQUEST'],
    [{ startTime: TARGET_START, endTime: TARGET_END + 1 }, 'INVALID_REQUEST'],
    [{ startTime: TARGET_START, endTime: TARGET_START }, 'INVALID_REQUEST'],
    [{ startTime: TARGET_START, endTime: TARGET_START - HOUR_MS }, 'INVALID_REQUEST'],
    [{ startTime: TARGET_START + 1, endTime: TARGET_END }, 'INVALID_REQUEST'],
    [{ startTime: TARGET_START, endTime: TARGET_END + 1 }, 'INVALID_REQUEST'],
    [{ startTime: DAY_MS - HOUR_MS, endTime: DAY_MS }, 'INVALID_REQUEST'],
    [{ startTime: Number.MAX_SAFE_INTEGER, endTime: Number.MAX_SAFE_INTEGER }, 'INVALID_REQUEST'],
  ];

  for (const [input, code] of cases) await assertCode(() => client.fetchHistoricalAnalyzerData(input), code);
  assert.equal(calls, 0);
});

test('classifies HTTP authorization, rate-limit, unavailable, and contract failures', async () => {
  for (const [status, code] of [
    [401, 'UNAUTHORIZED'],
    [403, 'UNAUTHORIZED'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [418, 'PROVIDER_CONTRACT'],
  ]) {
    const client = createClient(async () => response({}, status));
    await assertCode(() => client.fetchHistoricalAnalyzerData(request()), code);
  }
});

test('classifies network and timeout failures as provider unavailable', async () => {
  const networkClient = createClient(async () => {
    throw new Error('socket failed');
  });
  await assertCode(() => networkClient.fetchHistoricalAnalyzerData(request()), 'PROVIDER_UNAVAILABLE');

  const timeoutClient = createClient(async () => {
    const error = new Error('request timeout');
    error.type = 'request-timeout';
    throw error;
  });
  await assertCode(() => timeoutClient.fetchHistoricalAnalyzerData(request()), 'PROVIDER_UNAVAILABLE');
});

test('rejects invalid JSON and responses without json()', async () => {
  const invalidJson = createClient(async () => response(new Error('invalid JSON')));
  await assertCode(() => invalidJson.fetchHistoricalAnalyzerData(request()), 'PROVIDER_CONTRACT');

  const missingJson = createClient(async () => ({ status: 200 }));
  await assertCode(() => missingJson.fetchHistoricalAnalyzerData(request()), 'PROVIDER_CONTRACT');
});

test('uses only the approved production boundary and does not contain A1H2 or fallback logic', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/network/coingeckoHistoricalAnalyzerClient.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /normalizeReplayAnalyzerInput|schemaVersion|semanticMode|ReplayAnalyzerHistory|ReplayAnalyzerOrchestrator|MarketAnalyzer|ReplayPipelineRunner/);
  assert.doesNotMatch(source, /Binance|CandleEngine|interpolat|nearest|resampl|fallback/i);
});

test('exports only the approved A1H1 classes', () => {
  assert.deepEqual(Object.keys(require('../../src/network/coingeckoHistoricalAnalyzerClient')), [
    'CoinGeckoHistoricalAnalyzerClient',
    'CoinGeckoHistoricalAnalyzerClientError',
  ]);
});

test('validates constructor configuration without revealing credential values', () => {
  assert.throws(() => createClient(async () => response(makePayload()), { apiKey: '' }), /config\.apiKey/);
  assert.throws(() => createClient(async () => response(makePayload()), { timeout: 0 }), /config\.timeout/);
  assert.throws(() => createClient(async () => response(makePayload()), { baseUrl: 'file:///tmp' }), /HTTP or HTTPS/);
  assert.throws(() => createClient(async () => response(makePayload()), { coinId: 'Bitcoin' }), /coinId/);
  assert.throws(() => createClient(async () => response(makePayload()), { vsCurrency: 'USD' }), /vsCurrency/);
  assert.equal(TEST_API_KEY.length > 0, true);
});

test('propagates signal and preserves abort instead of provider-unavailable conversion', async () => {
  const controller = new AbortController();
  let fetchOptions;
  const client = createClient(async (url, options) => {
    fetchOptions = options;
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
  });

  await assert.rejects(
    client.fetchHistoricalAnalyzerData(request(), { signal: controller.signal }),
    { name: 'AbortError', code: 'ABORT_ERR' },
  );
  assert.equal(fetchOptions.signal, controller.signal);
});
