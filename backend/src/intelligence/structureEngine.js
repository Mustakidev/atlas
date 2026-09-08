'use strict';

const DIRECTIONS = Object.freeze(['BULLISH', 'BEARISH', 'MIXED', 'UNESTABLISHED']);
const PIVOT_EQUALITY_POLICY = 'STRICT';
const BREAK_BASIS = 'CLOSE';

function analyzeStructure(candles, policy) {
  const normalizedPolicy = normalizePolicy(policy);
  const policyIssue = validatePolicy(policy, normalizedPolicy);

  if (policyIssue) {
    return invalidResult(policyIssue);
  }

  const inputIssue = validateCandles(candles, normalizedPolicy);
  if (inputIssue) {
    return invalidResult(inputIssue);
  }

  const baseResult = {
    schemaVersion: 1,
    status: candles.length < normalizedPolicy.leftBars + normalizedPolicy.rightBars + 1
      ? 'INSUFFICIENT_DATA'
      : 'READY',
    asOf: asOf(candles),
    policy: { ...normalizedPolicy },
    structure: {
      direction: 'UNESTABLISHED',
      latestHighRelationship: null,
      latestLowRelationship: null,
    },
    swings: { highs: [], lows: [], ordered: [] },
    references: { latestConfirmedHigh: null, latestConfirmedLow: null },
    events: [],
    issues: [],
  };

  if (baseResult.status === 'INSUFFICIENT_DATA') {
    return baseResult;
  }

  const highs = [];
  const lows = [];
  const eventState = new Map();
  const events = [];

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const highReference = highs[highs.length - 1] || null;
    const lowReference = lows[lows.length - 1] || null;
    const priorDirection = determineDirection(highs, lows);

    collectBreakEvents(
      candle,
      index,
      highReference,
      lowReference,
      priorDirection,
      eventState,
      events,
      candles[index - 1] || null,
    );

    const candidateIndex = index - normalizedPolicy.rightBars;
    if (candidateIndex < normalizedPolicy.leftBars) {
      continue;
    }

    const candidate = candles[candidateIndex];
    const isHigh = isStrictHigh(candles, candidateIndex, normalizedPolicy);
    const isLow = isStrictLow(candles, candidateIndex, normalizedPolicy);

    if (isHigh) {
      const previousHigh = highs[highs.length - 1] || null;
      const swing = createSwing('HIGH', candidateIndex, index, candidate.high, candidate, candle, previousHigh);
      highs.push(swing);
      eventState.set(swing.id, initialEventState(candle, swing));
    }

    if (isLow) {
      const previousLow = lows[lows.length - 1] || null;
      const swing = createSwing('LOW', candidateIndex, index, candidate.low, candidate, candle, previousLow);
      lows.push(swing);
      eventState.set(swing.id, initialEventState(candle, swing));
    }
  }

  const ordered = [...highs, ...lows].sort((left, right) => (
    left.pivotIndex - right.pivotIndex || (left.type === 'HIGH' ? -1 : 1)
  ));

  baseResult.structure = structureSummary(highs, lows);
  baseResult.swings = {
    highs: highs.map(copySwing),
    lows: lows.map(copySwing),
    ordered: ordered.map(copySwing),
  };
  baseResult.references = {
    latestConfirmedHigh: copySwing(highs[highs.length - 1]),
    latestConfirmedLow: copySwing(lows[lows.length - 1]),
  };
  baseResult.events = events;
  return baseResult;
}

function normalizePolicy(policy) {
  return {
    leftBars: policy && policy.leftBars,
    rightBars: policy && policy.rightBars,
    expectedIntervalMs: policy && policy.expectedIntervalMs == null
      ? null
      : policy && policy.expectedIntervalMs,
    pivotEqualityPolicy: policy && policy.pivotEqualityPolicy,
    breakBasis: policy && policy.breakBasis,
  };
}

function validatePolicy(policy, normalizedPolicy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return issue('INVALID_POLICY', 'Policy is required.');
  }

  if (!isPositiveSafeInteger(normalizedPolicy.leftBars)
    || !isPositiveSafeInteger(normalizedPolicy.rightBars)) {
    return issue('INVALID_POLICY', 'leftBars and rightBars must be positive safe integers.');
  }

  if (normalizedPolicy.pivotEqualityPolicy !== PIVOT_EQUALITY_POLICY
    || normalizedPolicy.breakBasis !== BREAK_BASIS) {
    return issue('INVALID_POLICY', 'Only STRICT pivot equality and CLOSE break basis are supported.');
  }

  if (normalizedPolicy.expectedIntervalMs !== null
    && !isPositiveSafeInteger(normalizedPolicy.expectedIntervalMs)) {
    return issue('INVALID_POLICY', 'expectedIntervalMs must be null or a positive safe integer.');
  }

  return null;
}

function validateCandles(candles, policy) {
  if (!Array.isArray(candles)) {
    return issue('INPUT_NOT_ARRAY', 'Candles must be an array.');
  }
  if (candles.length === 0) {
    return issue('EMPTY_CANDLES', 'At least one candle is required.');
  }

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle || typeof candle !== 'object' || Array.isArray(candle)) {
      return issue('INVALID_CANDLE', `Candle ${index} is invalid.`);
    }
    if (candle.isFinalized === false || candle.active === true || candle.closed === false) {
      return issue('ACTIVE_CANDLE_INPUT', `Candle ${index} is not finalized.`);
    }
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) {
      return issue('NON_FINITE_OHLC', `Candle ${index} contains non-finite OHLC data.`);
    }
    if (candle.high < Math.max(candle.open, candle.close, candle.low)
      || candle.low > Math.min(candle.open, candle.close, candle.high)) {
      return issue('INCONSISTENT_OHLC', `Candle ${index} has inconsistent OHLC data.`);
    }
    if (!isSafeInteger(candle.openTime) || typeof candle.timestamp !== 'string') {
      return issue('INVALID_TIMESTAMP', `Candle ${index} has an invalid timestamp.`);
    }

    let canonicalTimestamp;
    try {
      canonicalTimestamp = new Date(candle.openTime).toISOString();
    } catch (_error) {
      return issue('INVALID_TIMESTAMP', `Candle ${index} has an invalid timestamp.`);
    }
    if (canonicalTimestamp !== candle.timestamp) {
      return issue('INVALID_TIMESTAMP', `Candle ${index} timestamp does not match openTime.`);
    }
    if (index > 0) {
      const delta = candle.openTime - candles[index - 1].openTime;
      if (delta <= 0) {
        return issue(
          delta === 0 ? 'DUPLICATE_TIMESTAMP' : 'OUT_OF_ORDER_TIMESTAMP',
          `Candle ${index} is not strictly after the previous candle.`,
        );
      }
      if (policy.expectedIntervalMs !== null && delta !== policy.expectedIntervalMs) {
        return issue('GAP_DETECTED', `Candle ${index} does not match expected cadence.`);
      }
    }
  }

  return null;
}

function isStrictHigh(candles, index, policy) {
  const price = candles[index].high;
  for (let offset = 1; offset <= policy.leftBars; offset += 1) {
    if (candles[index - offset].high >= price) return false;
  }
  for (let offset = 1; offset <= policy.rightBars; offset += 1) {
    if (candles[index + offset].high >= price) return false;
  }
  return true;
}

function isStrictLow(candles, index, policy) {
  const price = candles[index].low;
  for (let offset = 1; offset <= policy.leftBars; offset += 1) {
    if (candles[index - offset].low <= price) return false;
  }
  for (let offset = 1; offset <= policy.rightBars; offset += 1) {
    if (candles[index + offset].low <= price) return false;
  }
  return true;
}

function createSwing(type, pivotIndex, confirmedAtIndex, price, pivotCandle, confirmationCandle, previous) {
  const initial = type === 'HIGH' ? 'INITIAL_HIGH' : 'INITIAL_LOW';
  let classification = initial;
  if (previous) {
    if (price > previous.price) {
      classification = type === 'HIGH' ? 'HIGHER_HIGH' : 'HIGHER_LOW';
    } else if (price < previous.price) {
      classification = type === 'HIGH' ? 'LOWER_HIGH' : 'LOWER_LOW';
    } else {
      classification = type === 'HIGH' ? 'EQUAL_HIGH' : 'EQUAL_LOW';
    }
  }

  return {
    id: `${type}:${pivotIndex}`,
    type,
    price,
    pivotIndex,
    pivotTimestamp: pivotCandle.timestamp,
    confirmedAtIndex,
    confirmedAtTimestamp: confirmationCandle.timestamp,
    classification,
  };
}

function initialEventState(candle, swing) {
  return {
    wickSeen: swing.type === 'HIGH' ? candle.high > swing.price : candle.low < swing.price,
    closeSeen: swing.type === 'HIGH' ? candle.close > swing.price : candle.close < swing.price,
  };
}

function collectBreakEvents(
  candle,
  index,
  highReference,
  lowReference,
  priorDirection,
  eventState,
  events,
  previousCandle,
) {
  const candidates = [
    { reference: highReference, direction: 'BULLISH' },
    { reference: lowReference, direction: 'BEARISH' },
  ].filter(({ reference }) => reference && reference.confirmedAtIndex < index);

  for (const { reference, direction } of candidates) {
    const state = eventState.get(reference.id) || { wickSeen: false, closeSeen: false };
    const wickCrossed = direction === 'BULLISH'
      ? candle.high > reference.price
      : candle.low < reference.price;
    const closeCrossed = direction === 'BULLISH'
      ? candle.close > reference.price
      : candle.close < reference.price;

    if (closeCrossed && !state.closeSeen) {
      events.push(createEvent('CLOSE_BREAK', direction, priorDirection, reference, candle, previousCandle, index));
      state.closeSeen = true;
      state.wickSeen = true;
    } else if (wickCrossed && !state.wickSeen) {
      events.push(createEvent('WICK_BREACH', direction, priorDirection, reference, candle, previousCandle, index));
      state.wickSeen = true;
    }

    eventState.set(reference.id, state);
  }
}

function createEvent(kind, direction, priorDirection, reference, candle, previousCandle, index) {
  let classification = 'UNCLASSIFIED';
  if (kind === 'CLOSE_BREAK') {
    if (priorDirection === direction) classification = 'BOS';
    else if (
      (priorDirection === 'BULLISH' && direction === 'BEARISH')
      || (priorDirection === 'BEARISH' && direction === 'BULLISH')
    ) {
      classification = 'CHOCH';
    }
  }

  return {
    kind,
    direction,
    classification,
    referenceSwing: copySwing(reference),
    observedAt: { index, timestamp: candle.timestamp },
    priceEvidence: {
      referencePrice: reference.price,
      candleHigh: candle.high,
      candleLow: candle.low,
      candleClose: candle.close,
      priorHigh: previousCandle ? previousCandle.high : null,
      priorLow: previousCandle ? previousCandle.low : null,
      priorClose: previousCandle ? previousCandle.close : null,
      wickCrossed: direction === 'BULLISH'
        ? candle.high > reference.price
        : candle.low < reference.price,
      closeCrossed: direction === 'BULLISH'
        ? candle.close > reference.price
        : candle.close < reference.price,
    },
  };
}

function determineDirection(highs, lows) {
  const high = highs[highs.length - 1];
  const low = lows[lows.length - 1];
  if (!high || !low
    || high.classification === 'INITIAL_HIGH'
    || low.classification === 'INITIAL_LOW') {
    return 'UNESTABLISHED';
  }

  if (high.classification === 'HIGHER_HIGH' && low.classification === 'HIGHER_LOW') {
    return 'BULLISH';
  }
  if (high.classification === 'LOWER_HIGH' && low.classification === 'LOWER_LOW') {
    return 'BEARISH';
  }
  return 'MIXED';
}

function structureSummary(highs, lows) {
  const high = highs[highs.length - 1];
  const low = lows[lows.length - 1];
  const highRelationship = high && high.classification !== 'INITIAL_HIGH'
    ? high.classification
    : null;
  const lowRelationship = low && low.classification !== 'INITIAL_LOW'
    ? low.classification
    : null;

  return {
    direction: determineDirection(highs, lows),
    latestHighRelationship: highRelationship,
    latestLowRelationship: lowRelationship,
  };
}

function copySwing(swing) {
  return swing ? { ...swing } : null;
}

function asOf(candles) {
  const candle = candles[candles.length - 1];
  return { index: candles.length - 1, timestamp: candle.timestamp };
}

function invalidResult(problem) {
  return {
    schemaVersion: 1,
    status: 'INVALID_INPUT',
    asOf: null,
    policy: null,
    structure: {
      direction: 'UNESTABLISHED',
      latestHighRelationship: null,
      latestLowRelationship: null,
    },
    swings: { highs: [], lows: [], ordered: [] },
    references: { latestConfirmedHigh: null, latestConfirmedLow: null },
    events: [],
    issues: [problem],
  };
}

function issue(code, message) {
  return { code, message };
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value);
}

module.exports = {
  analyzeStructure,
  BREAK_BASIS,
  DIRECTIONS,
  PIVOT_EQUALITY_POLICY,
};
