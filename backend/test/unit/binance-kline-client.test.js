const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BinanceKlineClient,
  BinanceKlineClientError,
  DEFAULT_BASE_URL,
  TIMEFRAME_DURATIONS_MS,
} = require('../../src/network/binanceKlineClient');

const BASE_TIME = Date.UTC(2024, 0, 1);

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function row(openTime, timeframe = '1m', overrides = {}) {
  const duration = TIMEFRAME_DURATIONS_MS[timeframe];
  const values = [
    openTime,
    '100.10',
    '101.20',
    '99.90',
    '100.80',
    '12.34560000',
    openTime + duration - 1,
    '1234.56000000',
    42,
    '6.78900000',
    '678.90000000',
    '0',
  ];
  for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
  return values;
}

function response(body, status = 200, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        return headers[name] ?? headers[name.toLowerCase()] ?? null;
      },
    },
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function createClient(fetch, options = {}) {
  const waits = [];
  const client = new BinanceKlineClient({
    fetch,
    logger: logger(),
    sleep: async delay => waits.push(delay),
    config: {
      baseUrl: DEFAULT_BASE_URL,
      timeoutMs: 3210,
      pageSize: 1000,
      maxAttempts: 3,
      initialBackoffMs: 10,
      ...options,
    },
  });
  return { client, waits };
}

function fetchCallUrls(calls) {
  return calls.map(call => new URL(typeof call === 'string' ? call : call.url));
}

async function assertCode(promise, code, details = {}) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BinanceKlineClientError);
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(details)) assert.equal(error[key], value);
    return true;
  });
}

test('fetches each supported timeframe and maps one page without closeTime', async () => {
  for (const timeframe of ['1m', '5m', '15m', '1h']) {
    const duration = TIMEFRAME_DURATIONS_MS[timeframe];
    const startTime = BASE_TIME - (BASE_TIME % duration);
    const calls = [];
    const { client } = createClient(async (url, options) => {
      calls.push({ url, options });
      return response([row(startTime, timeframe)]);
    });

    const result = await client.fetchCandles({
      symbol: 'BTCUSDT',
      timeframe,
      startTime,
      endTime: startTime + duration,
    });

    assert.deepEqual(result.candles, [{
      openTime: startTime,
      timestamp: new Date(startTime).toISOString(),
      open: 100.1,
      high: 101.2,
      low: 99.9,
      close: 100.8,
      volume: 12.3456,
    }]);
    assert.equal(Object.hasOwn(result.candles[0], 'closeTime'), false);
    assert.deepEqual(result.diagnostics, {
      provider: 'binance-spot-klines',
      symbol: 'BTCUSDT',
      timeframe,
      startTime,
      endTime: startTime + duration,
      pageCount: 1,
      attemptCount: 1,
      candleCount: 1,
      firstOpenTime: startTime,
      lastOpenTime: startTime,
    });
    assert.equal(calls.length, 1);
  }
});

test('proves exact counts and boundaries for 5m, 15m, and 1h streams', async () => {
  for (const timeframe of ['5m', '15m', '1h']) {
    const duration = TIMEFRAME_DURATIONS_MS[timeframe];
    const count = 3;
    const startTime = BASE_TIME;
    const endTime = startTime + count * duration;
    const { client } = createClient(async () => response(
      Array.from({ length: count }, (_, index) => row(startTime + index * duration, timeframe)),
    ));

    const result = await client.fetchCandles({
      symbol: 'BTCUSDT', timeframe, startTime, endTime,
    });

    assert.equal(result.candles.length, count);
    assert.equal(result.diagnostics.candleCount, count);
    assert.equal(result.diagnostics.firstOpenTime, startTime);
    assert.equal(result.diagnostics.lastOpenTime, endTime - duration);
    assert.equal(result.candles.at(-1).openTime, endTime - duration);
  }
});

test('constructs exact bounded requests with limit and UTC timezone', async () => {
  const startTime = BASE_TIME;
  const endTime = startTime + 2 * TIMEFRAME_DURATIONS_MS['5m'];
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    return response([row(startTime, '5m'), row(startTime + TIMEFRAME_DURATIONS_MS['5m'], '5m')]);
  }, { pageSize: 2 });

  await client.fetchCandles({ symbol: 'BTCUSDT', timeframe: '5m', startTime, endTime });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v3/klines');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    symbol: 'BTCUSDT',
    interval: '5m',
    startTime: String(startTime),
    endTime: String(endTime - 1),
    limit: '2',
    timeZone: '0',
  });
  assert.deepEqual(calls[0].options, { timeout: 3210 });
});

test('paginates short pages until exact horizon termination', async () => {
  const duration = TIMEFRAME_DURATIONS_MS['1m'];
  const startTime = BASE_TIME;
  const pages = [
    [row(startTime, '1m'), row(startTime + duration, '1m')],
    [row(startTime + 2 * duration, '1m')],
  ];
  const calls = [];
  const { client } = createClient(async url => {
    calls.push(url);
    return response(pages.shift());
  }, { pageSize: 2 });

  const result = await client.fetchCandles({
    symbol: 'BTCUSDT',
    timeframe: '1m',
    startTime,
    endTime: startTime + 3 * duration,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(fetchCallUrls(calls).map(url => url.searchParams.get('startTime')), [
    String(startTime),
    String(startTime + 2 * duration),
  ]);
  assert.equal(result.diagnostics.pageCount, 2);
  assert.equal(result.diagnostics.attemptCount, 2);
});

test('paginates a stream larger than the provider maximum page size', async () => {
  const duration = TIMEFRAME_DURATIONS_MS['1m'];
  const startTime = BASE_TIME;
  const allRows = Array.from({ length: 1001 }, (_, index) => row(startTime + index * duration, '1m'));
  const calls = [];
  const { client } = createClient(async url => {
    const requestUrl = new URL(url);
    calls.push(requestUrl);
    const offset = Number(requestUrl.searchParams.get('startTime')) - startTime;
    const startIndex = offset / duration;
    return response(allRows.slice(startIndex, startIndex + 1000));
  });

  const result = await client.fetchCandles({
    symbol: 'BTCUSDT',
    timeframe: '1m',
    startTime,
    endTime: startTime + 1001 * duration,
  });

  assert.equal(result.candles.length, 1001);
  assert.equal(result.diagnostics.pageCount, 2);
  assert.deepEqual(calls.map(url => url.searchParams.get('startTime')), [
    String(startTime),
    String(startTime + 1000 * duration),
  ]);
});

test('rejects invalid provider numeric values and unsafe timestamps', async () => {
  const cases = [
    ['open', null],
    ['high', 'NaN'],
    ['low', 'Infinity'],
    ['close', 'not-a-number'],
    ['volume', ''],
    ['open', '   '],
    ['open', ' 1.2'],
    ['open', '1.2 '],
    ['open', '-1'],
    ['open', '1e3'],
    ['open', true],
    ['open', false],
    ['open', {}],
    ['open', []],
  ];
  for (const [field, value] of cases) {
    const { client } = createClient(async () => response([row(BASE_TIME, '1m', {
      [field === 'open' ? 1 : field === 'high' ? 2 : field === 'low' ? 3 : field === 'close' ? 4 : 5]: value,
    })]));
    await assertCode(client.fetchCandles({
      symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
    }), 'PROVIDER_CONTRACT');
  }

  const { client: leadingZeroClient } = createClient(async () => response([row(BASE_TIME, '1m', {
    1: '001.20',
  })]));
  const leadingZeroResult = await leadingZeroClient.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
  });
  assert.equal(leadingZeroResult.candles[0].open, 1.2);

  const { client: unsafeTimestampClient } = createClient(async () => response([row(Number.MAX_SAFE_INTEGER, '1m')]));
  await assertCode(unsafeTimestampClient.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
  }), 'PROVIDER_CONTRACT');
});

test('rejects provider close time mismatch', async () => {
  const { client } = createClient(async () => response([row(BASE_TIME, '1m', { 6: BASE_TIME + 1 })]));
  await assertCode(client.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
  }), 'PROVIDER_CONTRACT');
});

test('rejects duplicate, overlap, gap, and out-of-order pages', async () => {
  const duration = TIMEFRAME_DURATIONS_MS['1m'];
  const startTime = BASE_TIME;
  const cases = [
    {
      name: 'duplicate',
      pages: [[row(startTime, '1m')], [row(startTime, '1m')]],
    },
    {
      name: 'overlap',
      pages: [[row(startTime, '1m'), row(startTime + duration, '1m')], [row(startTime + duration, '1m')]],
    },
    {
      name: 'gap',
      pages: [[row(startTime, '1m'), row(startTime + 2 * duration, '1m')]],
    },
    {
      name: 'out-of-order',
      pages: [[row(startTime + duration, '1m'), row(startTime, '1m')]],
    },
  ];

  for (const testCase of cases) {
    const pages = testCase.pages.slice();
    const { client } = createClient(async () => response(pages.shift()), { pageSize: 2 });
    await assertCode(client.fetchCandles({
      symbol: 'BTCUSDT', timeframe: '1m', startTime, endTime: startTime + 3 * duration,
    }), testCase.name === 'gap' || testCase.name === 'out-of-order' ? 'PAGINATION_ERROR' : 'PAGINATION_ERROR');
  }
});

test('pagination validation failures do not retry valid HTTP pages', async () => {
  const duration = TIMEFRAME_DURATIONS_MS['1m'];
  let calls = 0;
  const { client, waits } = createClient(async () => {
    calls += 1;
    return response([row(BASE_TIME, '1m'), row(BASE_TIME + 2 * duration, '1m')]);
  }, { pageSize: 2 });

  await assertCode(client.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 3 * duration,
  }), 'PAGINATION_ERROR');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('rejects empty page before horizon end and never returns partial candles', async () => {
  const duration = TIMEFRAME_DURATIONS_MS['1m'];
  let calls = 0;
  const { client, waits } = createClient(async () => {
    calls += 1;
    return response(calls === 1 ? [row(BASE_TIME, '1m')] : []);
  }, { pageSize: 1 });

  await assertCode(client.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 2 * duration,
  }), 'INCOMPLETE_HISTORY');
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);
});

test('rejects permanent later-page failures without returning partial candles', async () => {
  for (const failure of [
    { status: 503, lastCode: 'HTTP_ERROR', waits: [10, 20] },
    { status: 429, lastCode: 'RATE_LIMITED', waits: [20, 40] },
  ]) {
    let calls = 0;
    let result = 'not-set';
    let caught;
    const { client, waits } = createClient(async () => {
      calls += 1;
      if (calls === 1) return response([row(BASE_TIME, '1m')]);
      return response({}, failure.status);
    }, { pageSize: 1 });

    await assert.rejects((async () => {
      result = await client.fetchCandles({
        symbol: 'BTCUSDT',
        timeframe: '1m',
        startTime: BASE_TIME,
        endTime: BASE_TIME + 2 * TIMEFRAME_DURATIONS_MS['1m'],
      });
    })(), error => {
      caught = error;
      return error instanceof BinanceKlineClientError && error.code === 'RETRY_EXHAUSTED';
    });

    assert.equal(result, 'not-set');
    assert.equal(calls, 4);
    assert.deepEqual(waits, failure.waits);
    assert.equal(caught.retryable, false);
    assert.equal(caught.attempts, 3);
    assert.equal(caught.lastCode, failure.lastCode);
    assert.equal(caught.status, failure.status);
    assert.ok(caught.cause instanceof BinanceKlineClientError);
  }
});

test('retries network, timeout, 5xx, and 429 responses with Retry-After', async () => {
  const cases = [
    { error: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), expectedWait: 10 },
    { error: Object.assign(new Error('request timeout'), { type: 'request-timeout' }), expectedWait: 10 },
    { response: response({ error: true }, 503), expectedWait: 10 },
    { response: response({ error: true }, 429, { 'retry-after': '3' }), expectedWait: 3000 },
  ];

  for (const testCase of cases) {
    let calls = 0;
    const { client, waits } = createClient(async () => {
      calls += 1;
      if (calls === 1) {
        if (testCase.error) throw testCase.error;
        return testCase.response;
      }
      return response([row(BASE_TIME, '1m')]);
    });

    await client.fetchCandles({
      symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
    });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [testCase.expectedWait]);
  }
});

test('uses bounded fallback backoff for missing or invalid Retry-After', async () => {
  for (const retryAfter of [undefined, 'abc', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    let calls = 0;
    const headers = retryAfter === undefined ? {} : { 'retry-after': retryAfter };
    const { client, waits } = createClient(async () => {
      calls += 1;
      if (calls === 1) return response({}, 429, headers);
      return response([row(BASE_TIME, '1m')]);
    });

    await client.fetchCandles({
      symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
    });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [20]);
  }
});

test('accepts case-insensitive Retry-After headers without retrying early', async () => {
  let calls = 0;
  const { client, waits } = createClient(async () => {
    calls += 1;
    if (calls === 1) return { status: 429, headers: { 'Retry-After': '4' }, async json() {} };
    return response([row(BASE_TIME, '1m')]);
  });

  await client.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [4000]);
});

test('exhausts retryable failures at three attempts and does not retry 418 or other 4xx', async () => {
  for (const status of [418, 400]) {
    let calls = 0;
    const { client, waits } = createClient(async () => {
      calls += 1;
      return response({}, status);
    });
    await assertCode(client.fetchCandles({
      symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
    }), 'HTTP_ERROR', { status });
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  }

  let calls = 0;
  const { client, waits } = createClient(async () => {
    calls += 1;
    return response({}, 503);
  });
  await assertCode(client.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
  }), 'RETRY_EXHAUSTED', { attempts: 3, lastCode: 'HTTP_ERROR' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('malformed JSON, non-array bodies, and malformed rows are never retried', async () => {
  const cases = [
    () => response(new SyntaxError('invalid json')),
    () => response({}),
    () => response([['short']]),
  ];
  for (const createResponse of cases) {
    let calls = 0;
    const { client, waits } = createClient(async () => {
      calls += 1;
      return createResponse();
    });
    await assertCode(client.fetchCandles({
      symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
    }), 'PROVIDER_CONTRACT');
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  }
});

test('rejects invalid requests before network I/O', async () => {
  let calls = 0;
  const { client } = createClient(async () => {
    calls += 1;
    return response([]);
  });
  const valid = { symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000 };

  for (const request of [
    { ...valid, symbol: 'btcusdt' },
    { ...valid, timeframe: '2m' },
    { ...valid, startTime: BASE_TIME + 1 },
    { ...valid, endTime: BASE_TIME + 60001 },
    { ...valid, endTime: BASE_TIME },
    { ...valid, startTime: null },
  ]) {
    await assertCode(client.fetchCandles(request), request.timeframe === '2m' ? 'UNSUPPORTED_TIMEFRAME' : request.startTime === BASE_TIME + 1 || request.endTime === BASE_TIME + 60001 ? 'UNALIGNED_HORIZON' : 'INVALID_REQUEST');
  }
  assert.equal(calls, 0);
});

test('repeated acquisition with identical responses is deterministic', async () => {
  const fetch = async () => response([row(BASE_TIME, '1m')]);
  const first = await createClient(fetch).client.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
  });
  const second = await createClient(fetch).client.fetchCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: BASE_TIME, endTime: BASE_TIME + 60000,
  });
  assert.deepEqual(second, first);
});
