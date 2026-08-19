const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HOUR_MS,
  DAY_MS,
  DEFAULT_REPLAY_DAYS,
  createReplayRequest,
  buildUrl,
} = require('../replayRequest');

const FIXED_NOW_MS = Date.parse('2024-02-15T12:34:56.789Z');
const EXPECTED_END_TIME = Date.parse('2024-02-15T12:00:00.000Z');
const EXPECTED_START_TIME = EXPECTED_END_TIME - (DEFAULT_REPLAY_DAYS * DAY_MS);

test('builds a deterministic 30-day canonical request from fixed nowMs', () => {
  const request = createReplayRequest(FIXED_NOW_MS);

  assert.deepEqual(request, {
    symbol: 'BTCUSDT',
    startTime: EXPECTED_START_TIME,
    endTime: EXPECTED_END_TIME,
  });
  assert.equal(request.endTime, Math.floor(FIXED_NOW_MS / HOUR_MS) * HOUR_MS);
  assert.equal(request.startTime, request.endTime - (30 * DAY_MS));
  assert.equal(request.startTime % HOUR_MS, 0);
  assert.equal(request.endTime % HOUR_MS, 0);
  assert.equal((request.endTime - request.startTime) / HOUR_MS, 720);
});

test('builds the exact canonical URL and query key set', () => {
  const url = buildUrl('', FIXED_NOW_MS);
  const parsed = new URL(url, 'http://localhost');

  assert.equal(parsed.pathname, '/api/strategy/replay/v2');
  assert.deepEqual([...parsed.searchParams.keys()], ['symbol', 'startTime', 'endTime']);
  assert.equal(parsed.searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(parsed.searchParams.get('startTime'), String(EXPECTED_START_TIME));
  assert.equal(parsed.searchParams.get('endTime'), String(EXPECTED_END_TIME));
  assert.equal(parsed.searchParams.has('timeframe'), false);
  assert.equal(parsed.searchParams.has('days'), false);
  assert.equal(url.includes('/api/strategy/replay?timeframe='), false);
});

test('preserves the same result for the same epoch regardless of timezone', () => {
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const Honolulu = createReplayRequest(FIXED_NOW_MS);
    process.env.TZ = 'Asia/Tokyo';
    const Tokyo = createReplayRequest(FIXED_NOW_MS);
    assert.deepEqual(Honolulu, Tokyo);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('keeps an exact-hour nowMs at that boundary', () => {
  const exactHour = Date.parse('2024-02-15T12:00:00.000Z');
  assert.equal(createReplayRequest(exactHour).endTime, exactHour);
});

test('floors one millisecond before the next hour to the prior boundary', () => {
  const beforeNextHour = Date.parse('2024-02-15T12:59:59.999Z');
  assert.equal(createReplayRequest(beforeNextHour).endTime, EXPECTED_END_TIME);
});

test('accepts a production caller supplied Date.now value without changing semantics', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW_MS;
  try {
    assert.equal(
      buildUrl('', Date.now()),
      buildUrl('', FIXED_NOW_MS),
    );
  } finally {
    Date.now = originalNow;
  }
});

test('rejects invalid nowMs values deterministically', () => {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    '1707990896789',
    null,
    undefined,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => createReplayRequest(value), /nowMs/);
  }
});

test('rejects nowMs values too early for the 30-day canonical range', () => {
  const tooEarly = (31 * DAY_MS) - 1;
  assert.throws(
    () => createReplayRequest(tooEarly),
    /too early for the canonical replay horizon/,
  );
});

test('rejects an invalid API base without changing request semantics', () => {
  assert.throws(() => buildUrl(null, FIXED_NOW_MS), /apiBase must be a string/);
});
