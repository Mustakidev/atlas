const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeStructure } = require('../../src/intelligence/structureEngine');

const HOUR_MS = 60 * 60 * 1000;
const POLICY = {
  leftBars: 1,
  rightBars: 1,
  pivotEqualityPolicy: 'STRICT',
  breakBasis: 'CLOSE',
  expectedIntervalMs: HOUR_MS,
};

function candlesFrom(highs, lows, closes = null) {
  const start = Date.UTC(2024, 0, 1);
  return highs.map((high, index) => {
    const low = lows[index];
    const close = closes ? closes[index] : (high + low) / 2;
    const openTime = start + index * HOUR_MS;
    return {
      open: close,
      high,
      low,
      close,
      openTime,
      timestamp: new Date(openTime).toISOString(),
    };
  });
}

function availableFacts(result, prefixLength) {
  return {
    swings: result.swings.ordered.filter((swing) => swing.confirmedAtIndex < prefixLength),
    events: result.events.filter((event) => event.observedAt.index < prefixLength),
  };
}

test('proves bullish structure from higher highs and higher lows', () => {
  const candles = candlesFrom(
    [10, 12, 10, 14, 10, 16, 10],
    [5, 4, 5, 6, 5, 7, 5],
  );
  const result = analyzeStructure(candles, POLICY);

  assert.ok(result.swings.highs.length >= 2);
  assert.equal(result.swings.highs.at(-1).classification, 'HIGHER_HIGH');
  assert.ok(result.swings.lows.length >= 2);
  assert.equal(result.swings.lows.at(-1).classification, 'HIGHER_LOW');
  assert.equal(result.structure.direction, 'BULLISH');
});

test('proves bearish structure from lower highs and lower lows', () => {
  const candles = candlesFrom(
    [10, 14, 12, 13, 11, 12, 10],
    [5, 4, 6, 3, 5, 2, 4],
  );
  const result = analyzeStructure(candles, POLICY);

  assert.ok(result.swings.highs.length >= 2);
  assert.equal(result.swings.highs.at(-1).classification, 'LOWER_HIGH');
  assert.ok(result.swings.lows.length >= 2);
  assert.equal(result.swings.lows.at(-1).classification, 'LOWER_LOW');
  assert.equal(result.structure.direction, 'BEARISH');
});

test('distinguishes mixed and unestablished direction states', () => {
  const mixed = analyzeStructure(candlesFrom(
    [10, 12, 10, 14, 10, 15, 10],
    [5, 4, 5, 3, 5, 2, 5],
  ), POLICY);
  const unestablished = analyzeStructure(candlesFrom(
    [10, 12, 10, 14, 10],
    [4, 5, 4, 5, 4],
  ), POLICY);

  assert.equal(mixed.swings.highs.at(-1).classification, 'HIGHER_HIGH');
  assert.equal(mixed.swings.lows.at(-1).classification, 'LOWER_LOW');
  assert.equal(mixed.structure.direction, 'MIXED');
  assert.equal(unestablished.structure.latestLowRelationship, null);
  assert.equal(unestablished.structure.direction, 'UNESTABLISHED');
});

test('classifies independently confirmed equal highs and equal lows', () => {
  const equalHighs = analyzeStructure(candlesFrom(
    [10, 12, 10, 12, 10],
    [5, 4, 5, 6, 5],
  ), POLICY);
  const equalLows = analyzeStructure(candlesFrom(
    [10, 11, 10, 11, 10],
    [5, 3, 5, 3, 5],
  ), POLICY);

  assert.deepEqual(equalHighs.swings.highs.map((swing) => swing.classification), [
    'INITIAL_HIGH',
    'EQUAL_HIGH',
  ]);
  assert.deepEqual(equalLows.swings.lows.map((swing) => swing.classification), [
    'INITIAL_LOW',
    'EQUAL_LOW',
  ]);
});

test('rejects strict neighbor equality for both pivot types', () => {
  const result = analyzeStructure(candlesFrom(
    [10, 12, 12, 10],
    [5, 4, 4, 5],
  ), POLICY);

  assert.equal(result.swings.highs.length, 0);
  assert.equal(result.swings.lows.length, 0);
});

test('records one isolated spike with exact pivot and confirmation metadata', () => {
  const candles = candlesFrom([10, 20, 10], [5, 6, 5]);
  const result = analyzeStructure(candles, POLICY);

  assert.deepEqual(result.swings.highs.map((swing) => ({
    type: swing.type,
    price: swing.price,
    pivotIndex: swing.pivotIndex,
    confirmedAtIndex: swing.confirmedAtIndex,
  })), [{
    type: 'HIGH',
    price: 20,
    pivotIndex: 1,
    confirmedAtIndex: 2,
  }]);
  assert.equal(result.swings.lows.length, 0);
});

test('emits a bullish wick breach only', () => {
  const result = analyzeStructure(candlesFrom(
    [10, 12, 10, 13],
    [5, 4, 5, 4],
    [7.5, 8, 7.5, 11],
  ), POLICY);
  const event = result.events[0];

  assert.equal(result.events.length, 1);
  assert.equal(event.kind, 'WICK_BREACH');
  assert.equal(event.direction, 'BULLISH');
  assert.equal(event.referenceSwing.id, 'HIGH:1');
  assert.equal(event.referenceSwing.price, 12);
  assert.equal(event.priceEvidence.wickCrossed, true);
  assert.equal(event.priceEvidence.closeCrossed, false);
  assert.notEqual(event.kind, 'CLOSE_BREAK');
  assert.notEqual(event.classification, 'BOS');
  assert.notEqual(event.classification, 'CHOCH');
});

test('emits a bearish wick breach only when the close remains at the level', () => {
  const result = analyzeStructure(candlesFrom(
    [10, 11, 10, 11],
    [5, 3, 5, 2],
    [7.5, 7, 7.5, 3],
  ), POLICY);
  const event = result.events[0];

  assert.equal(result.events.length, 1);
  assert.equal(event.kind, 'WICK_BREACH');
  assert.equal(event.direction, 'BEARISH');
  assert.equal(event.referenceSwing.id, 'LOW:1');
  assert.equal(event.referenceSwing.price, 3);
  assert.equal(event.priceEvidence.wickCrossed, true);
  assert.equal(event.priceEvidence.closeCrossed, false);
  assert.notEqual(event.classification, 'BOS');
  assert.notEqual(event.classification, 'CHOCH');
});

test('emits explicit bullish and bearish close breaks with exact references', () => {
  const bullish = analyzeStructure(candlesFrom(
    [10, 12, 10, 13],
    [5, 4, 5, 4],
    [7.5, 8, 7.5, 13],
  ), POLICY);
  const bearish = analyzeStructure(candlesFrom(
    [10, 11, 10, 11],
    [5, 3, 5, 2],
    [7.5, 7, 7.5, 2],
  ), POLICY);

  assert.equal(bullish.events.length, 1);
  assert.equal(bullish.events[0].kind, 'CLOSE_BREAK');
  assert.equal(bullish.events[0].direction, 'BULLISH');
  assert.equal(bullish.events[0].referenceSwing.id, 'HIGH:1');
  assert.equal(bullish.events[0].referenceSwing.price, 12);
  assert.equal(bullish.events[0].priceEvidence.closeCrossed, true);

  assert.equal(bearish.events.length, 1);
  assert.equal(bearish.events[0].kind, 'CLOSE_BREAK');
  assert.equal(bearish.events[0].direction, 'BEARISH');
  assert.equal(bearish.events[0].referenceSwing.id, 'LOW:1');
  assert.equal(bearish.events[0].referenceSwing.price, 3);
  assert.equal(bearish.events[0].priceEvidence.closeCrossed, true);
});

test('classifies bullish and bearish BOS from pre-break structure', () => {
  const bullishCandles = candlesFrom(
    [10, 12, 10, 14, 10, 16, 10, 18],
    [5, 4, 5, 6, 5, 7, 5, 5],
    [7.5, 8, 7.5, 9, 7.5, 10, 7.5, 17],
  );
  const bearishCandles = candlesFrom(
    [10, 14, 12, 13, 11, 12, 10, 11],
    [5, 4, 6, 3, 5, 2, 4, 1],
    [7.5, 9, 9, 8, 8, 7, 7, 1],
  );
  const bullishBefore = analyzeStructure(bullishCandles.slice(0, 7), POLICY);
  const bearishBefore = analyzeStructure(bearishCandles.slice(0, 7), POLICY);
  const bullish = analyzeStructure(bullishCandles, POLICY);
  const bearish = analyzeStructure(bearishCandles, POLICY);

  assert.equal(bullishBefore.structure.direction, 'BULLISH');
  assert.equal(bullish.events.at(-1).kind, 'CLOSE_BREAK');
  assert.equal(bullish.events.at(-1).direction, 'BULLISH');
  assert.equal(bullish.events.at(-1).classification, 'BOS');
  assert.equal(bullish.events.at(-1).referenceSwing.id, 'HIGH:5');
  assert.equal(bullish.events.at(-1).observedAt.index, 7);
  assert.equal(bullish.events.at(-1).priceEvidence.closeCrossed, true);

  assert.equal(bearishBefore.structure.direction, 'BEARISH');
  assert.equal(bearish.events.at(-1).kind, 'CLOSE_BREAK');
  assert.equal(bearish.events.at(-1).direction, 'BEARISH');
  assert.equal(bearish.events.at(-1).classification, 'BOS');
  assert.equal(bearish.events.at(-1).referenceSwing.id, 'LOW:5');
  assert.equal(bearish.events.at(-1).observedAt.index, 7);
  assert.equal(bearish.events.at(-1).priceEvidence.closeCrossed, true);
});

test('classifies bullish and bearish CHOCH without forcing a direction flip', () => {
  const bullishChoch = analyzeStructure(candlesFrom(
    [10, 14, 12, 13, 11, 12, 10, 15],
    [5, 4, 6, 3, 5, 2, 4, 4],
    [7.5, 9, 9, 8, 8, 7, 7, 15],
  ), POLICY);
  const bearishChoch = analyzeStructure(candlesFrom(
    [10, 12, 10, 14, 10, 16, 10, 12],
    [5, 4, 5, 6, 5, 7, 5, 2],
    [7.5, 8, 7.5, 9, 7.5, 10, 7.5, 2],
  ), POLICY);

  assert.equal(bullishChoch.structure.direction, 'BEARISH');
  assert.equal(bullishChoch.events.at(-1).kind, 'CLOSE_BREAK');
  assert.equal(bullishChoch.events.at(-1).direction, 'BULLISH');
  assert.equal(bullishChoch.events.at(-1).classification, 'CHOCH');
  assert.equal(bullishChoch.events.at(-1).referenceSwing.id, 'HIGH:5');
  assert.equal(bullishChoch.events.at(-1).observedAt.index, 7);
  assert.equal(bullishChoch.events.at(-1).priceEvidence.closeCrossed, true);

  assert.equal(bearishChoch.structure.direction, 'BULLISH');
  assert.equal(bearishChoch.events.at(-1).kind, 'CLOSE_BREAK');
  assert.equal(bearishChoch.events.at(-1).direction, 'BEARISH');
  assert.equal(bearishChoch.events.at(-1).classification, 'CHOCH');
  assert.equal(bearishChoch.events.at(-1).referenceSwing.id, 'LOW:4');
  assert.equal(bearishChoch.events.at(-1).observedAt.index, 7);
  assert.equal(bearishChoch.events.at(-1).priceEvidence.closeCrossed, true);
});

test('classifies MIXED and UNESTABLISHED close breaks as UNCLASSIFIED', () => {
  const mixedCandles = candlesFrom(
    [10, 12, 10, 14, 10, 15, 10, 17],
    [5, 4, 5, 3, 5, 2, 5, 5],
    [7.5, 8, 7.5, 9, 7.5, 10, 7.5, 17],
  );
  const unestablishedCandles = candlesFrom(
    [10, 12, 10, 14, 10, 16],
    [5, 4, 5, 5, 5, 5],
    [7.5, 8, 7.5, 9, 7.5, 15],
  );
  const mixedBefore = analyzeStructure(mixedCandles.slice(0, 7), POLICY);
  const unestablishedBefore = analyzeStructure(unestablishedCandles.slice(0, 5), POLICY);
  const mixed = analyzeStructure(mixedCandles, POLICY);
  const unestablished = analyzeStructure(unestablishedCandles, POLICY);

  assert.equal(mixedBefore.structure.direction, 'MIXED');
  assert.equal(mixed.events.at(-1).kind, 'CLOSE_BREAK');
  assert.equal(mixed.events.at(-1).classification, 'UNCLASSIFIED');
  assert.notEqual(mixed.events.at(-1).classification, 'BOS');
  assert.notEqual(mixed.events.at(-1).classification, 'CHOCH');

  assert.equal(unestablishedBefore.structure.direction, 'UNESTABLISHED');
  assert.equal(unestablished.events.at(-1).kind, 'CLOSE_BREAK');
  assert.equal(unestablished.events.at(-1).classification, 'UNCLASSIFIED');
  assert.notEqual(unestablished.events.at(-1).classification, 'BOS');
  assert.notEqual(unestablished.events.at(-1).classification, 'CHOCH');
});

test('deduplicates repeated wick and close breaches on one reference', () => {
  const result = analyzeStructure(candlesFrom(
    [10, 12, 10, 13, 14, 15, 16],
    [5, 4, 5, 5, 5, 5, 5],
    [7.5, 8, 7.5, 11, 11, 13, 14],
  ), POLICY);
  const highEvents = result.events.filter((event) => event.referenceSwing.id === 'HIGH:1');

  assert.equal(highEvents.filter((event) => event.kind === 'WICK_BREACH').length, 1);
  assert.equal(highEvents.filter((event) => event.kind === 'CLOSE_BREAK').length, 1);
  assert.deepEqual(highEvents.map((event) => event.kind), ['WICK_BREACH', 'CLOSE_BREAK']);
});

test('allows a new same-type reference to emit a new break', () => {
  const result = analyzeStructure(candlesFrom(
    [10, 12, 10, 13, 14, 10, 15],
    [5, 4, 5, 5, 5, 5, 5],
    [7.5, 8, 7.5, 13, 10, 8, 15],
  ), POLICY);
  const closeBreaks = result.events.filter((event) => event.kind === 'CLOSE_BREAK');

  assert.deepEqual(closeBreaks.map((event) => event.referenceSwing.id), ['HIGH:1', 'HIGH:4']);
  assert.equal(closeBreaks[1].referenceSwing.price, 14);
});

test('exposes a pivot exactly at right-bar confirmation with exact timestamps', () => {
  const policy = { ...POLICY, leftBars: 2, rightBars: 2 };
  const candles = candlesFrom(
    [10, 11, 15, 12, 10],
    [5, 5, 5, 5, 5],
  );
  const before = analyzeStructure(candles.slice(0, 4), policy);
  const atConfirmation = analyzeStructure(candles, policy);
  const pivot = atConfirmation.swings.highs[0];

  assert.equal(before.swings.highs.length, 0);
  assert.equal(pivot.pivotIndex, 2);
  assert.equal(pivot.confirmedAtIndex, 4);
  assert.equal(pivot.pivotTimestamp, candles[2].timestamp);
  assert.equal(pivot.confirmedAtTimestamp, candles[4].timestamp);
});

test('uses the mathematical minimum rather than the legacy minimum', () => {
  const policy = { ...POLICY, leftBars: 2, rightBars: 2 };
  const result = analyzeStructure(candlesFrom(
    [10, 11, 15, 12],
    [5, 5, 5, 5],
  ), policy);

  assert.equal(policy.leftBars + policy.rightBars + 1, 5);
  assert.equal(result.status, 'INSUFFICIENT_DATA');
});

test('flat valid candles produce no pivots or events', () => {
  const result = analyzeStructure(candlesFrom(
    [10, 10, 10, 10, 10],
    [10, 10, 10, 10, 10],
    [10, 10, 10, 10, 10],
  ), POLICY);

  assert.equal(result.status, 'READY');
  assert.equal(result.swings.ordered.length, 0);
  assert.equal(result.events.length, 0);
  assert.equal(result.structure.direction, 'UNESTABLISHED');
});

test('handles a fixed high-volatility noisy series with deterministic strict facts', () => {
  const candles = candlesFrom(
    [100, 150, 110, 180, 120, 160, 90, 200, 130],
    [80, 60, 90, 70, 100, 50, 85, 40, 95],
  );
  const result = analyzeStructure(candles, POLICY);

  assert.equal(result.status, 'READY');
  assert.deepEqual(result.swings.highs.map((swing) => [swing.pivotIndex, swing.price, swing.classification]), [
    [1, 150, 'INITIAL_HIGH'],
    [3, 180, 'HIGHER_HIGH'],
    [5, 160, 'LOWER_HIGH'],
    [7, 200, 'HIGHER_HIGH'],
  ]);
  assert.deepEqual(result.swings.lows.map((swing) => [swing.pivotIndex, swing.price, swing.classification]), [
    [1, 60, 'INITIAL_LOW'],
    [3, 70, 'HIGHER_LOW'],
    [5, 50, 'LOWER_LOW'],
    [7, 40, 'LOWER_LOW'],
  ]);
  assert.deepEqual(result.events.map((event) => [
    event.kind,
    event.direction,
    event.referenceSwing.id,
    event.observedAt.index,
  ]), [
    ['WICK_BREACH', 'BULLISH', 'HIGH:1', 3],
    ['WICK_BREACH', 'BEARISH', 'LOW:3', 5],
    ['WICK_BREACH', 'BULLISH', 'HIGH:5', 7],
    ['WICK_BREACH', 'BEARISH', 'LOW:5', 7],
  ]);
});

test('rejects duplicate and out-of-order timestamps without sorting or deduping', () => {
  const candles = candlesFrom([10, 12, 10, 14, 10], [5, 4, 5, 6, 5]);
  const original = structuredClone(candles);
  const duplicate = structuredClone(candles);
  duplicate[2] = { ...duplicate[1] };
  const outOfOrder = structuredClone(candles);
  outOfOrder[2].openTime = outOfOrder[0].openTime;
  outOfOrder[2].timestamp = outOfOrder[0].timestamp;

  assert.equal(analyzeStructure(duplicate, POLICY).status, 'INVALID_INPUT');
  assert.equal(analyzeStructure(duplicate, POLICY).issues[0].code, 'DUPLICATE_TIMESTAMP');
  assert.equal(analyzeStructure(outOfOrder, POLICY).status, 'INVALID_INPUT');
  assert.equal(analyzeStructure(outOfOrder, POLICY).issues[0].code, 'OUT_OF_ORDER_TIMESTAMP');
  assert.deepEqual(candles, original);
});

test('enforces configured cadence but does not claim cadence when omitted', () => {
  const candles = candlesFrom([10, 12, 10, 14, 10], [5, 4, 5, 6, 5]);
  const gap = structuredClone(candles);
  for (let index = 2; index < gap.length; index += 1) {
    gap[index].openTime += HOUR_MS;
    gap[index].timestamp = new Date(gap[index].openTime).toISOString();
  }
  const configured = analyzeStructure(gap, POLICY);
  const omitted = analyzeStructure(gap, { ...POLICY, expectedIntervalMs: null });

  assert.equal(configured.status, 'INVALID_INPUT');
  assert.equal(configured.issues[0].code, 'GAP_DETECTED');
  assert.notEqual(omitted.status, 'INVALID_INPUT');
  assert.equal(omitted.policy.expectedIntervalMs, null);
});

test('rejects each malformed OHLC relationship structurally', () => {
  const base = candlesFrom([10, 12, 10], [5, 4, 5]);
  const highBelowLow = structuredClone(base);
  highBelowLow[1].high = 3;
  const highBelowClose = structuredClone(base);
  highBelowClose[1].high = 7;
  highBelowClose[1].close = 8;
  const lowAboveOpen = structuredClone(base);
  lowAboveOpen[1].low = 9;
  lowAboveOpen[1].open = 8;

  for (const candles of [highBelowLow, highBelowClose, lowAboveOpen]) {
    const result = analyzeStructure(candles, POLICY);
    assert.equal(result.status, 'INVALID_INPUT');
    assert.equal(result.issues[0].code, 'INCONSISTENT_OHLC');
  }
});

test('rejects NaN and Infinity as non-finite OHLC', () => {
  const base = candlesFrom([10, 12, 10], [5, 4, 5]);
  const nan = structuredClone(base);
  nan[1].high = Number.NaN;
  const infinity = structuredClone(base);
  infinity[1].low = Number.POSITIVE_INFINITY;

  assert.equal(analyzeStructure(nan, POLICY).status, 'INVALID_INPUT');
  assert.equal(analyzeStructure(nan, POLICY).issues[0].code, 'NON_FINITE_OHLC');
  assert.equal(analyzeStructure(infinity, POLICY).status, 'INVALID_INPUT');
  assert.equal(analyzeStructure(infinity, POLICY).issues[0].code, 'NON_FINITE_OHLC');
});

test('uses caller-declared finalized candles and rejects explicit active markers', () => {
  const ordinary = candlesFrom([10, 12, 10], [5, 4, 5]);
  const isFinalizedFalse = structuredClone(ordinary);
  isFinalizedFalse[2].isFinalized = false;
  const active = structuredClone(ordinary);
  active[2].active = true;
  const closedFalse = structuredClone(ordinary);
  closedFalse[2].closed = false;

  assert.notEqual(analyzeStructure(ordinary, POLICY).status, 'INVALID_INPUT');
  for (const candles of [isFinalizedFalse, active, closedFalse]) {
    const result = analyzeStructure(candles, POLICY);
    assert.equal(result.status, 'INVALID_INPUT');
    assert.equal(result.issues[0].code, 'ACTIVE_CANDLE_INPUT');
  }
});

test('records deterministic dual high and low pivots on one candle', () => {
  const result = analyzeStructure(candlesFrom([10, 12, 10], [5, 3, 5]), POLICY);

  assert.deepEqual(result.swings.ordered.map((swing) => ({
    type: swing.type,
    pivotIndex: swing.pivotIndex,
  })), [
    { type: 'HIGH', pivotIndex: 1 },
    { type: 'LOW', pivotIndex: 1 },
  ]);
});

test('preserves historical facts when only future candles are mutated', () => {
  const candles = candlesFrom(
    [10, 12, 10, 14, 10, 16, 10, 18],
    [5, 4, 5, 6, 5, 7, 5, 8],
    [7.5, 8, 7.5, 11, 7.5, 10, 7.5, 17],
  );
  const cutoff = 5;
  const mutated = structuredClone(candles);
  mutated[6] = { ...mutated[6], high: 30, low: 4, close: 20, open: 20 };
  mutated[7] = { ...mutated[7], high: 31, low: 3, close: 30, open: 30 };
  const originalFacts = availableFacts(analyzeStructure(candles, POLICY), cutoff + 1);
  const mutatedFacts = availableFacts(analyzeStructure(mutated, POLICY), cutoff + 1);

  assert.deepStrictEqual(mutatedFacts, originalFacts);
  assert.ok(originalFacts.swings.length > 0);
  assert.ok(originalFacts.events.length > 0);
});

test('proves prefix equivalence using complete historical records', () => {
  const candles = candlesFrom(
    [10, 12, 10, 14, 10, 16, 10, 18],
    [5, 4, 5, 6, 5, 7, 5, 8],
    [7.5, 8, 7.5, 11, 7.5, 10, 7.5, 17],
  );
  const complete = analyzeStructure(candles, POLICY);

  for (let prefixLength = 1; prefixLength <= candles.length; prefixLength += 1) {
    const prefix = analyzeStructure(candles.slice(0, prefixLength), POLICY);
    assert.deepStrictEqual(
      availableFacts(prefix, prefixLength),
      availableFacts(complete, prefixLength),
      `historical record mismatch at prefix ${prefixLength}`,
    );
  }
});

test('does not mutate candles or policy inputs', () => {
  const candles = candlesFrom([10, 12, 10, 14, 10], [5, 4, 5, 6, 5]);
  const policy = { ...POLICY };
  const originalCandles = structuredClone(candles);
  const originalPolicy = structuredClone(policy);

  analyzeStructure(candles, policy);

  assert.deepStrictEqual(candles, originalCandles);
  assert.deepStrictEqual(policy, originalPolicy);
});

test('returns complete structurally identical results for repeated calls', () => {
  const candles = candlesFrom(
    [100, 150, 110, 180, 120, 160, 90, 200, 130],
    [80, 60, 90, 70, 100, 50, 85, 40, 95],
  );
  const first = analyzeStructure(candles, POLICY);
  const second = analyzeStructure(candles, POLICY);
  const third = analyzeStructure(candles, POLICY);

  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual(third, first);
});

test('uses only an old eligible reference when a new swing confirms on the break candle', () => {
  const candles = candlesFrom(
    [10, 15, 10, 12, 20, 16],
    [5, 5, 5, 5, 5, 5],
    [7, 8, 7, 8, 10, 16],
  );
  const result = analyzeStructure(candles, POLICY);
  const breakEvent = result.events.find((event) => event.observedAt.index === 5);
  const newReference = result.swings.highs.find((swing) => swing.id === 'HIGH:4');

  assert.ok(breakEvent);
  assert.equal(breakEvent.kind, 'CLOSE_BREAK');
  assert.equal(breakEvent.referenceSwing.id, 'HIGH:1');
  assert.equal(newReference.confirmedAtIndex, 5);
  assert.equal(breakEvent.observedAt.index, newReference.confirmedAtIndex);
  assert.notEqual(breakEvent.referenceSwing.id, newReference.id);
});

test('wick-only breaches in both directions are never close breaks or structure labels', () => {
  const bullish = analyzeStructure(candlesFrom(
    [10, 12, 10, 13],
    [5, 4, 5, 4],
    [7.5, 8, 7.5, 11],
  ), POLICY);
  const bearish = analyzeStructure(candlesFrom(
    [10, 11, 10, 11],
    [5, 3, 5, 2],
    [7.5, 7, 7.5, 3],
  ), POLICY);

  for (const result of [bullish, bearish]) {
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].kind, 'WICK_BREACH');
    assert.equal(result.events[0].priceEvidence.closeCrossed, false);
    assert.notEqual(result.events[0].kind, 'CLOSE_BREAK');
    assert.notEqual(result.events[0].classification, 'BOS');
    assert.notEqual(result.events[0].classification, 'CHOCH');
  }
});
