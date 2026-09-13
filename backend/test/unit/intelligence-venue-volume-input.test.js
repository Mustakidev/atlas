'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeVenueVolumeInput } = require('../../src/intelligence/venueVolumeInput');

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;

function source(overrides = {}) {
  return {
    venue: 'binance',
    marketType: 'spot',
    symbol: 'btcusdt',
    baseAsset: 'btc',
    quoteAsset: 'usdt',
    ...overrides,
  };
}

function record(index = 0, overrides = {}) {
  const openTime = BASE_TIME + index * HOUR;
  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    quoteVolume: 1_000 + index,
    ...overrides,
  };
}

function input(records = [record()], sourceOverrides = {}) {
  return { source: source(sourceOverrides), records };
}

function resultFor(value) {
  return normalizeVenueVolumeInput(value);
}

function assertIssue(value, issue) {
  const result = resultFor(value);
  assert.equal(result.status, 'INVALID_INPUT');
  assert.deepEqual(result.issues, [issue]);
  assert.deepEqual(result.records, []);
  return result;
}

function assertReady(value) {
  const result = resultFor(value);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.issues, []);
  return result;
}

test('normalizes the exact public input and source schema', () => {
  const result = assertReady(input([]));

  assert.deepEqual(Object.keys(result), ['schemaVersion', 'status', 'source', 'records', 'issues']);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.source, {
    venue: 'BINANCE',
    marketType: 'SPOT',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
  });
  assert.deepEqual(result.records, []);
});

test('returns one stable invalid result for top-level failures', () => {
  for (const value of [null, undefined, [], 'input', 1]) {
    const result = assertIssue(value, 'INVALID_INPUT');
    assert.deepEqual(result.source, {
      venue: null,
      marketType: null,
      symbol: null,
      baseAsset: null,
      quoteAsset: null,
    });
  }

  assertIssue({ source: source(), records: [], extra: true }, 'UNKNOWN_FIELD');
  assertIssue({ records: [] }, 'INVALID_SOURCE');
  assertIssue({ source: source() }, 'INVALID_RECORDS');
});

test('rejects source unknown keys, missing fields, and invalid shapes', () => {
  assertIssue({ source: { ...source(), extra: true }, records: [] }, 'UNKNOWN_FIELD');
  for (const field of ['venue', 'marketType', 'symbol', 'baseAsset', 'quoteAsset']) {
    const value = source();
    delete value[field];
    const result = assertIssue({ source: value, records: [] }, 'INVALID_SOURCE');
    assert.deepEqual(result.source, {
      venue: null,
      marketType: null,
      symbol: null,
      baseAsset: null,
      quoteAsset: null,
    });
  }
  assertIssue({ source: null, records: [] }, 'INVALID_SOURCE');
  assertIssue({ source: [], records: [] }, 'INVALID_SOURCE');
});

test('rejects invalid source field types and empty values', () => {
  for (const field of ['venue', 'marketType', 'symbol', 'baseAsset', 'quoteAsset']) {
    for (const value of [null, undefined, 1, [], {}, '']) {
      const valueSource = source();
      if (value === undefined) delete valueSource[field];
      else valueSource[field] = value;
      assertIssue({ source: valueSource, records: [] }, 'INVALID_SOURCE');
    }
  }
});

test('rejects source whitespace before uppercase canonicalization', () => {
  for (const venue of [' Binance', 'BINANCE ', 'BIN ANCE', '\tBINANCE']) {
    assertIssue(input([], { venue }), 'INVALID_SOURCE');
  }
  assertIssue(input([], { symbol: 'BTC USDT' }), 'INVALID_SOURCE');
  assertIssue(input([], { baseAsset: 'BTC\n' }), 'INVALID_SOURCE');
});

test('accepts the locked source character sets and canonicalizes case', () => {
  const result = assertReady(input([], {
    venue: 'venue-1:spot',
    marketType: 'perpetual',
    symbol: 'btc/usdt:quarter_1',
    baseAsset: 'asset2.v1',
    quoteAsset: 'usd-coin_2',
  }));

  assert.deepEqual(result.source, {
    venue: 'VENUE-1:SPOT',
    marketType: 'PERPETUAL',
    symbol: 'BTC/USDT:QUARTER_1',
    baseAsset: 'ASSET2.V1',
    quoteAsset: 'USD-COIN_2',
  });
});

test('rejects non-ASCII and invalid source characters', () => {
  for (const venue of ['éxchange', '_BINANCE', '-BINANCE']) {
    assertIssue(input([], { venue }), 'INVALID_SOURCE');
  }
  for (const symbol of ['_BTCUSDT', '-BTCUSDT']) {
    assertIssue(input([], { symbol }), 'INVALID_SOURCE');
  }
  for (const assetField of ['baseAsset', 'quoteAsset']) {
    for (const value of ['BTC/USDT', '_BTC', '-BTC']) {
      assertIssue(input([], { [assetField]: value }), 'INVALID_SOURCE');
    }
  }
  for (const marketType of ['', 'future', 'spot/perpetual', ' SPOT']) {
    assertIssue(input([], { marketType }), 'INVALID_SOURCE');
  }
});

test('rejects aggregate venue identities and accepts unknown venue identities', () => {
  for (const venue of ['COINGECKO', 'AGGREGATE', 'MULTI_VENUE', 'MULTI-VENUE', 'ALL_VENUES']) {
    const result = assertIssue(input([], { venue }), 'INVALID_SOURCE');
    assert.deepEqual(result.source, {
      venue: null,
      marketType: null,
      symbol: null,
      baseAsset: null,
      quoteAsset: null,
    });
  }
  assert.equal(assertReady(input([], { venue: 'future.exchange' })).source.venue, 'FUTURE.EXCHANGE');
});

test('rejects invalid record containers and accepts empty records', () => {
  for (const records of [null, {}, 'records', 1]) {
    assertIssue({ source: source(), records }, 'INVALID_RECORDS');
  }
  assertReady(input([]));
  assertReady(input([record()]));
  assertReady(input([record(0), record(1)]));
});

test('rejects malformed records and unknown provider fields with precedence', () => {
  for (const value of [null, [], 'record', 1]) {
    assertIssue(input([value]), 'INVALID_RECORDS');
  }
  assertIssue(input([{ ...record(), volume: 10 }]), 'UNKNOWN_FIELD');
  assertIssue(input([{ ...record(), volume: 10, quoteVolume: undefined }]), 'UNKNOWN_FIELD');
});

test('maps missing required record fields to their exact issues', () => {
  const missingOpenTime = record();
  delete missingOpenTime.openTime;
  assertIssue(input([missingOpenTime]), 'INVALID_TIMESTAMP');

  const missingTimestamp = record();
  delete missingTimestamp.timestamp;
  assertIssue(input([missingTimestamp]), 'INVALID_TIMESTAMP');

  const missingQuoteVolume = record();
  delete missingQuoteVolume.quoteVolume;
  assertIssue(input([missingQuoteVolume]), 'INVALID_VOLUME');
});

test('validates required quote volume without coercion', () => {
  for (const value of [undefined, null, -1, NaN, Infinity, -Infinity, '100']) {
    const current = record();
    if (value === undefined) delete current.quoteVolume;
    else current.quoteVolume = value;
    assertIssue(input([current]), 'INVALID_VOLUME');
  }
  assert.equal(assertReady(input([record(0, { quoteVolume: 0 })])).records[0].quoteVolume, 0);
});

test('normalizes absent base volume and validates present values', () => {
  assert.equal(assertReady(input([record()])).records[0].baseVolume, null);
  assert.equal(assertReady(input([record(0, { baseVolume: 0 })])).records[0].baseVolume, 0);
  for (const value of [null, -1, NaN, Infinity, -Infinity, '100']) {
    assertIssue(input([record(0, { baseVolume: value })]), 'INVALID_VOLUME');
  }
});

test('normalizes absent trade count and validates safe integers', () => {
  assert.equal(assertReady(input([record()])).records[0].tradeCount, null);
  for (const value of [0, 42]) {
    assert.equal(assertReady(input([record(0, { tradeCount: value })])).records[0].tradeCount, value);
  }
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42', null, NaN]) {
    assertIssue(input([record(0, { tradeCount: value })]), 'INVALID_TRADE_COUNT');
  }
});

test('validates quote taker volume and zero-total semantics', () => {
  assert.equal(assertReady(input([record()])).records[0].takerBuyQuoteVolume, null);
  for (const value of [0, 10, 100]) {
    const result = assertReady(input([record(0, { quoteVolume: 100, takerBuyQuoteVolume: value })]));
    assert.equal(result.records[0].takerBuyQuoteVolume, value);
  }
  assertReady(input([record(0, { quoteVolume: 0, takerBuyQuoteVolume: 0 })]));
  for (const value of [-1, 101, NaN, Infinity, -Infinity, '10', null]) {
    assertIssue(input([record(0, { quoteVolume: 100, takerBuyQuoteVolume: value })]), 'INVALID_TAKER_VOLUME');
  }
  assertIssue(input([record(0, { quoteVolume: 0, takerBuyQuoteVolume: 1 })]), 'INVALID_TAKER_VOLUME');
});

test('validates base taker pairing independently from quote pairing', () => {
  assert.equal(assertReady(input([record()])).records[0].takerBuyBaseVolume, null);
  for (const value of [0, 10, 100]) {
    const result = assertReady(input([record(0, {
      baseVolume: 100,
      takerBuyBaseVolume: value,
    })]));
    assert.equal(result.records[0].takerBuyBaseVolume, value);
  }
  for (const value of [1, -1, NaN, Infinity, '10', null]) {
    assertIssue(input([record(0, { takerBuyBaseVolume: value })]), 'INVALID_TAKER_VOLUME');
  }
  assertIssue(input([record(0, { baseVolume: 100, takerBuyBaseVolume: 101 })]), 'INVALID_TAKER_VOLUME');
  assertIssue(input([record(0, { baseVolume: 100, takerBuyBaseVolume: null })]), 'INVALID_TAKER_VOLUME');
});

test('keeps quote taker fields valid without base fields', () => {
  const result = assertReady(input([record(0, {
    quoteVolume: 100,
    takerBuyQuoteVolume: 60,
  })]));
  assert.equal(result.records[0].baseVolume, null);
  assert.equal(result.records[0].takerBuyBaseVolume, null);
  assert.equal(result.records[0].takerBuyQuoteVolume, 60);
});

test('normalizes markers to null and preserves valid marker types', () => {
  const result = assertReady(input([record(0, {
    isFinalized: true,
    active: false,
    closed: true,
  })]));
  assert.deepEqual(result.records[0], {
    openTime: BASE_TIME,
    timestamp: '2026-01-01T00:00:00.000Z',
    quoteVolume: 1_000,
    baseVolume: null,
    tradeCount: null,
    takerBuyBaseVolume: null,
    takerBuyQuoteVolume: null,
    isFinalized: true,
    active: false,
    closed: true,
  });
  const missing = assertReady(input([record()])).records[0];
  for (const field of ['isFinalized', 'active', 'closed']) assert.equal(missing[field], null);
});

test('rejects marker type defects before active state checks', () => {
  for (const field of ['isFinalized', 'active', 'closed']) {
    for (const value of [null, 'false', 1]) {
      assertIssue(input([record(0, { [field]: value })]), 'INVALID_RECORDS');
    }
  }
});

test('rejects explicit active and unfinalized markers', () => {
  assertIssue(input([record(0, { isFinalized: false })]), 'ACTIVE_CANDLE');
  assertIssue(input([record(0, { active: true })]), 'ACTIVE_CANDLE');
  assertIssue(input([record(0, { closed: false })]), 'ACTIVE_CANDLE');
});

test('requires strict canonical timestamp identity', () => {
  assertIssue(input([record(0, { timestamp: undefined })]), 'INVALID_TIMESTAMP');
  assertIssue(input([record(0, { timestamp: '2026-01-01T00:00:00Z' })]), 'INVALID_TIMESTAMP');
  assertIssue(input([record(0, { timestamp: '2025-12-31T19:00:00.000-05:00' })]), 'INVALID_TIMESTAMP');
  assertIssue(input([record(0, { timestamp: 'not-a-date' })]), 'INVALID_TIMESTAMP');
  assertIssue(input([record(0, { openTime: Number.MAX_SAFE_INTEGER })]), 'INVALID_TIMESTAMP');
  assertReady(input([record(0, { timestamp: '2026-01-01T00:00:00.000Z' })]));
});

test('detects duplicates before ordering and rejects descending input', () => {
  assertIssue(input([record(0), record(1), record(0)]), 'DUPLICATE_TIMESTAMP');
  assertIssue(input([record(1), record(0)]), 'OUT_OF_ORDER_TIMESTAMP');
  assertReady(input([record(0), record(1), record(2)]));
});

test('suppresses normalized prefixes when a later record fails', () => {
  const result = assertIssue(input([record(0), { ...record(1), quoteVolume: -1 }]), 'INVALID_VOLUME');
  assert.deepEqual(result.source, {
    venue: 'BINANCE',
    marketType: 'SPOT',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
  });
});

test('does not mutate input and does not alias output objects', () => {
  const suppliedSource = source();
  const suppliedRecord = record(0, { baseVolume: 20 });
  const supplied = { source: suppliedSource, records: [suppliedRecord] };
  const before = structuredClone(supplied);
  const result = assertReady(supplied);

  assert.deepEqual(supplied, before);
  assert.notStrictEqual(result, supplied);
  assert.notStrictEqual(result.source, supplied.source);
  assert.notStrictEqual(result.records, supplied.records);
  assert.notStrictEqual(result.records[0], supplied.records[0]);

  result.source.venue = 'OTHER';
  result.records[0].quoteVolume = 2;
  assert.equal(supplied.source.venue, 'binance');
  assert.equal(supplied.records[0].quoteVolume, 1_000);

  suppliedSource.venue = 'COINBASE';
  suppliedRecord.quoteVolume = 3;
  assert.equal(result.source.venue, 'OTHER');
  assert.equal(result.records[0].quoteVolume, 2);
});

test('is deterministic, preserves precision, and emits no undefined values', () => {
  const supplied = input([record(0, {
    quoteVolume: Number.MAX_VALUE / 3,
    baseVolume: Number.MIN_VALUE,
    tradeCount: 1,
    takerBuyQuoteVolume: Number.MAX_VALUE / 3,
  })]);
  const first = resultFor(supplied);
  const second = resultFor(supplied);
  assert.deepEqual(first, second);
  assert.equal(first.records[0].quoteVolume, supplied.records[0].quoteVolume);
  assert.equal(first.records[0].baseVolume, supplied.records[0].baseVolume);
  assert.equal(first.records[0].takerBuyQuoteVolume, supplied.records[0].takerBuyQuoteVolume);
  assert.doesNotMatch(JSON.stringify(first), /NaN|Infinity/);
  for (const key of Object.keys(first.records[0])) assert.notEqual(first.records[0][key], undefined);
});
