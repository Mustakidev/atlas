'use strict';

const { computeRawRsiFromCloses } = require('../engine/rsiCore');

const MOMENTUM_METHOD = 'LOG_RETURN';
const RSI_METHOD = 'WILDER';

function analyzeMomentumRsi(candles, policy) {
  const policyResult = validatePolicy(policy);
  if (policyResult.issue) {
    return result(null, 'INVALID_INPUT', null, policyResult.issue);
  }

  const candleIssue = validateCandles(candles, policyResult.context.timeframe.expectedIntervalMs);
  if (candleIssue) {
    return result(policyResult.context, 'INVALID_INPUT', null, candleIssue);
  }

  const asOf = candles.length === 0
    ? null
    : { index: candles.length - 1, timestamp: candles[candles.length - 1].timestamp };
  const { momentum, rsi } = policyResult.context;
  const baseMinimum = Math.max(momentum.window + 1, rsi.period + 1);

  if (candles.length < baseMinimum) {
    const issueCode = candles.length < momentum.window + 1
      ? 'INSUFFICIENT_MOMENTUM_HISTORY'
      : 'INSUFFICIENT_RSI_HISTORY';
    return result(
      policyResult.context,
      'INSUFFICIENT_DATA',
      asOf,
      issue(issueCode, 'Base evidence history is insufficient.', 'candles'),
    );
  }

  const closes = candles.map(candle => candle.close);
  const finalIndex = candles.length - 1;
  const currentMomentum = calculateMomentum(closes, finalIndex, momentum.window);
  if (!Number.isFinite(currentMomentum)) {
    return result(
      policyResult.context,
      'INVALID_INPUT',
      null,
      issue('NON_FINITE_MOMENTUM', 'Momentum calculation produced a non-finite value.', 'momentum.value'),
    );
  }

  const currentRsi = calculateRsi(closes, rsi.period);
  if (!Number.isFinite(currentRsi)) {
    return result(
      policyResult.context,
      'INVALID_INPUT',
      null,
      issue('NON_FINITE_RSI', 'RSI calculation produced a non-finite value.', 'rsi.value'),
    );
  }

  const currentMomentumState = classifyMomentum(currentMomentum, momentum.neutralBand);
  const currentMomentumStrength = classifyStrength(currentMomentum, momentum.strength);
  let priorMomentum = null;
  let momentumChange = 'UNKNOWN';

  if (candles.length >= momentum.window + momentum.change.comparisonWindow + 1) {
    const priorIndex = finalIndex - momentum.change.comparisonWindow;
    priorMomentum = calculateMomentum(closes, priorIndex, momentum.window);
    if (!Number.isFinite(priorMomentum)) {
      return result(
        policyResult.context,
        'INVALID_INPUT',
        null,
        issue('NON_FINITE_MOMENTUM', 'Prior momentum calculation produced a non-finite value.', 'momentum.evidence.priorValue'),
      );
    }
    momentumChange = classifyMomentumChange(
      priorMomentum,
      currentMomentum,
      currentMomentumState,
      momentum.neutralBand,
      momentum.change.flatTolerance,
    );
  }

  let priorRsi = null;
  let rsiSlope = 'UNKNOWN';
  if (candles.length >= rsi.period + rsi.slope.comparisonWindow + 1) {
    const priorIndex = finalIndex - rsi.slope.comparisonWindow;
    priorRsi = calculateRsi(closes.slice(0, priorIndex + 1), rsi.period);
    if (!Number.isFinite(priorRsi)) {
      return result(
        policyResult.context,
        'INVALID_INPUT',
        null,
        issue('NON_FINITE_RSI', 'Prior RSI calculation produced a non-finite value.', 'rsi.evidence.priorValue'),
      );
    }
    rsiSlope = classifySlope(currentRsi - priorRsi, rsi.slope.flatTolerance);
  }

  return result(policyResult.context, 'READY', asOf, null, {
    referenceIndex: finalIndex - momentum.window,
    referenceTimestamp: candles[finalIndex - momentum.window].timestamp,
    momentumValue: currentMomentum,
    momentumState: currentMomentumState,
    momentumStrength: currentMomentumStrength,
    momentumChange,
    momentumPriorValue: priorMomentum,
    rsiValue: currentRsi,
    rsiState: classifyRsi(currentRsi, rsi.bands),
    rsiSlope,
    rsiPriorValue: priorRsi,
  });
}

function validatePolicy(policy) {
  if (!isObject(policy) || !hasExactKeys(policy, ['schemaVersion', 'timeframe', 'momentum', 'rsi'])) {
    return { issue: policyIssue('Policy must match the required schema.', 'policy') };
  }
  if (policy.schemaVersion !== 1) {
    return { issue: policyIssue('schemaVersion must be 1.', 'policy.schemaVersion') };
  }

  const timeframe = policy.timeframe;
  if (!isObject(timeframe) || !hasExactKeys(timeframe, ['id', 'expectedIntervalMs'])) {
    return { issue: policyIssue('timeframe must match the required schema.', 'policy.timeframe') };
  }
  if (typeof timeframe.id !== 'string' || timeframe.id.trim().length === 0) {
    return { issue: policyIssue('timeframe.id must be a non-empty string.', 'policy.timeframe.id') };
  }
  if (timeframe.expectedIntervalMs !== null
    && !isPositiveSafeInteger(timeframe.expectedIntervalMs)) {
    return { issue: policyIssue('expectedIntervalMs must be null or a positive safe integer.', 'policy.timeframe.expectedIntervalMs') };
  }

  const momentum = policy.momentum;
  if (!isObject(momentum) || !hasExactKeys(momentum, ['window', 'neutralBand', 'strength', 'change'])) {
    return { issue: policyIssue('momentum must match the required schema.', 'policy.momentum') };
  }
  if (!isPositiveSafeInteger(momentum.window)) {
    return { issue: policyIssue('window must be a positive safe integer.', 'policy.momentum.window') };
  }
  if (!isFiniteNonNegative(momentum.neutralBand)) {
    return { issue: policyIssue('neutralBand must be finite and non-negative.', 'policy.momentum.neutralBand') };
  }

  const strength = momentum.strength;
  if (!isObject(strength) || !hasExactKeys(strength, ['weakMaxAbs', 'strongMinAbs'])) {
    return { issue: policyIssue('strength must match the required schema.', 'policy.momentum.strength') };
  }
  if (!Number.isFinite(strength.weakMaxAbs) || strength.weakMaxAbs < momentum.neutralBand) {
    return { issue: policyIssue('weakMaxAbs must be finite and at least neutralBand.', 'policy.momentum.strength.weakMaxAbs') };
  }
  if (!Number.isFinite(strength.strongMinAbs) || strength.strongMinAbs <= strength.weakMaxAbs) {
    return { issue: policyIssue('strongMinAbs must be finite and greater than weakMaxAbs.', 'policy.momentum.strength.strongMinAbs') };
  }

  const change = momentum.change;
  if (!isObject(change) || !hasExactKeys(change, ['comparisonWindow', 'flatTolerance'])) {
    return { issue: policyIssue('change must match the required schema.', 'policy.momentum.change') };
  }
  if (!isPositiveSafeInteger(change.comparisonWindow)) {
    return { issue: policyIssue('comparisonWindow must be a positive safe integer.', 'policy.momentum.change.comparisonWindow') };
  }
  if (!isFiniteNonNegative(change.flatTolerance)) {
    return { issue: policyIssue('flatTolerance must be finite and non-negative.', 'policy.momentum.change.flatTolerance') };
  }

  const rsi = policy.rsi;
  if (!isObject(rsi) || !hasExactKeys(rsi, ['period', 'bands', 'slope'])) {
    return { issue: policyIssue('rsi must match the required schema.', 'policy.rsi') };
  }
  if (!isPositiveSafeInteger(rsi.period)) {
    return { issue: policyIssue('period must be a positive safe integer.', 'policy.rsi.period') };
  }

  const bands = rsi.bands;
  if (!isObject(bands) || !hasExactKeys(bands, ['oversoldMax', 'lowMax', 'highMin', 'overboughtMin'])) {
    return { issue: policyIssue('bands must match the required schema.', 'policy.rsi.bands') };
  }
  if (!Number.isFinite(bands.oversoldMax) || bands.oversoldMax < 0) {
    return { issue: policyIssue('oversoldMax must be finite and non-negative.', 'policy.rsi.bands.oversoldMax') };
  }
  if (!Number.isFinite(bands.lowMax) || bands.lowMax <= bands.oversoldMax) {
    return { issue: policyIssue('lowMax must be finite and greater than oversoldMax.', 'policy.rsi.bands.lowMax') };
  }
  if (!Number.isFinite(bands.highMin) || bands.highMin <= bands.lowMax) {
    return { issue: policyIssue('highMin must be finite and greater than lowMax.', 'policy.rsi.bands.highMin') };
  }
  if (!Number.isFinite(bands.overboughtMin)
    || bands.overboughtMin <= bands.highMin
    || bands.overboughtMin > 100) {
    return { issue: policyIssue('overboughtMin must be greater than highMin and at most 100.', 'policy.rsi.bands.overboughtMin') };
  }

  const slope = rsi.slope;
  if (!isObject(slope) || !hasExactKeys(slope, ['comparisonWindow', 'flatTolerance'])) {
    return { issue: policyIssue('slope must match the required schema.', 'policy.rsi.slope') };
  }
  if (!isPositiveSafeInteger(slope.comparisonWindow)) {
    return { issue: policyIssue('comparisonWindow must be a positive safe integer.', 'policy.rsi.slope.comparisonWindow') };
  }
  if (!isFiniteNonNegative(slope.flatTolerance)) {
    return { issue: policyIssue('flatTolerance must be finite and non-negative.', 'policy.rsi.slope.flatTolerance') };
  }

  return {
    context: {
      timeframe: {
        id: timeframe.id,
        expectedIntervalMs: timeframe.expectedIntervalMs,
      },
      momentum: {
        window: momentum.window,
        neutralBand: momentum.neutralBand,
        strength: {
          weakMaxAbs: strength.weakMaxAbs,
          strongMinAbs: strength.strongMinAbs,
        },
        change: {
          comparisonWindow: change.comparisonWindow,
          flatTolerance: change.flatTolerance,
        },
      },
      rsi: {
        period: rsi.period,
        bands: {
          oversoldMax: bands.oversoldMax,
          lowMax: bands.lowMax,
          highMin: bands.highMin,
          overboughtMin: bands.overboughtMin,
        },
        slope: {
          comparisonWindow: slope.comparisonWindow,
          flatTolerance: slope.flatTolerance,
        },
      },
    },
  };
}

function validateCandles(candles, expectedIntervalMs) {
  if (!Array.isArray(candles)) return issue('INVALID_CANDLES', 'Candles must be an array.', 'candles');

  const requiredOhlc = ['open', 'high', 'low', 'close'];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const path = `candles[${index}]`;
    if (!isObject(candle) || !requiredOhlc.every(field => Object.hasOwn(candle, field))) {
      return issue('INVALID_CANDLES', 'Candle must contain the required OHLC fields.', path);
    }
    if (!requiredOhlc.every(field => Number.isFinite(candle[field]))) {
      return issue('NON_FINITE_OHLC', 'OHLC fields must be finite numbers.', path);
    }
    if (candle.close <= 0) {
      return issue('INVALID_CANDLES', 'close must be greater than zero.', `${path}.close`);
    }
    if (candle.high < candle.open || candle.high < candle.close || candle.high < candle.low
      || candle.low > candle.open || candle.low > candle.close || candle.low > candle.high) {
      return issue('INCONSISTENT_OHLC', 'OHLC values are inconsistent.', path);
    }
    if (candle.isFinalized === false || candle.active === true || candle.closed === false) {
      return issue('ACTIVE_CANDLE', 'Candle is not finalized.', path);
    }
    if (!Number.isSafeInteger(candle.openTime) || typeof candle.timestamp !== 'string') {
      return issue('INVALID_TIMESTAMP', 'openTime and timestamp are required.', `${path}.timestamp`);
    }
    let canonicalTimestamp;
    try {
      canonicalTimestamp = new Date(candle.openTime).toISOString();
    } catch (_error) {
      return issue('INVALID_TIMESTAMP', 'openTime does not represent a valid timestamp.', `${path}.openTime`);
    }
    if (canonicalTimestamp !== candle.timestamp) {
      return issue('INVALID_TIMESTAMP', 'timestamp does not match openTime.', `${path}.timestamp`);
    }
  }

  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].openTime === candles[index - 1].openTime) {
      return issue('DUPLICATE_TIMESTAMP', 'openTime must be unique.', `candles[${index}].openTime`);
    }
  }
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].openTime < candles[index - 1].openTime) {
      return issue('OUT_OF_ORDER_TIMESTAMP', 'openTime must be strictly increasing.', `candles[${index}].openTime`);
    }
  }
  if (expectedIntervalMs !== null) {
    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index].openTime - candles[index - 1].openTime !== expectedIntervalMs) {
        return issue('INVALID_CADENCE', 'Candle spacing does not match expectedIntervalMs.', `candles[${index}].openTime`);
      }
    }
  }
  return null;
}

function calculateMomentum(closes, index, window) {
  return Math.log(closes[index]) - Math.log(closes[index - window]);
}

function calculateRsi(closes, period) {
  try {
    return computeRawRsiFromCloses(closes, period);
  } catch (_error) {
    return null;
  }
}

function classifyMomentum(raw, neutralBand) {
  if (raw > neutralBand) return 'POSITIVE';
  if (raw < -neutralBand) return 'NEGATIVE';
  return 'NEUTRAL';
}

function classifyStrength(raw, policy) {
  const magnitude = Math.abs(raw);
  if (magnitude <= policy.weakMaxAbs) return 'WEAK';
  if (magnitude >= policy.strongMinAbs) return 'STRONG';
  return 'MODERATE';
}

function classifyMomentumChange(priorRaw, currentRaw, currentState, neutralBand, flatTolerance) {
  const priorState = classifyMomentum(priorRaw, neutralBand);
  if ((priorState === 'POSITIVE' && currentState === 'NEGATIVE')
    || (priorState === 'NEGATIVE' && currentState === 'POSITIVE')) {
    return 'REVERSING';
  }
  return classifySlope(Math.abs(currentRaw) - Math.abs(priorRaw), flatTolerance, 'ACCELERATING', 'DECELERATING', 'STABLE');
}

function classifySlope(delta, flatTolerance, rising = 'RISING', falling = 'FALLING', flat = 'FLAT') {
  if (delta > flatTolerance) return rising;
  if (delta < -flatTolerance) return falling;
  return flat;
}

function classifyRsi(value, bands) {
  if (value <= bands.oversoldMax) return 'OVERSOLD';
  if (value <= bands.lowMax) return 'LOW';
  if (value < bands.highMin) return 'NEUTRAL';
  if (value < bands.overboughtMin) return 'HIGH';
  return 'OVERBOUGHT';
}

function result(context, status, asOf, problem, observations = {}) {
  const safeContext = context || emptyContext();
  const hasReference = Number.isSafeInteger(observations.referenceIndex)
    && typeof observations.referenceTimestamp === 'string';
  const hasFinite = value => typeof value === 'number' && Number.isFinite(value);
  const momentumPriorValue = hasFinite(observations.momentumPriorValue)
    ? observations.momentumPriorValue
    : null;
  const rsiPriorValue = hasFinite(observations.rsiPriorValue) ? observations.rsiPriorValue : null;

  return {
    schemaVersion: 1,
    status,
    asOf: asOf || null,
    timeframe: {
      id: safeContext.timeframe.id,
      expectedIntervalMs: safeContext.timeframe.expectedIntervalMs,
    },
    momentum: {
      value: hasFinite(observations.momentumValue) ? observations.momentumValue : null,
      state: observations.momentumState || 'UNKNOWN',
      strength: observations.momentumStrength || 'UNKNOWN',
      change: observations.momentumChange || 'UNKNOWN',
      evidence: {
        method: MOMENTUM_METHOD,
        window: safeContext.momentum.window,
        referenceIndex: hasReference ? observations.referenceIndex : null,
        referenceTimestamp: hasReference ? observations.referenceTimestamp : null,
        priorValue: momentumPriorValue,
        comparisonWindow: safeContext.momentum.change.comparisonWindow,
        neutralBand: safeContext.momentum.neutralBand,
        weakMaxAbs: safeContext.momentum.strength.weakMaxAbs,
        strongMinAbs: safeContext.momentum.strength.strongMinAbs,
        flatTolerance: safeContext.momentum.change.flatTolerance,
      },
    },
    rsi: {
      value: hasFinite(observations.rsiValue) ? observations.rsiValue : null,
      state: observations.rsiState || 'UNKNOWN',
      slope: observations.rsiSlope || 'UNKNOWN',
      evidence: {
        method: RSI_METHOD,
        period: safeContext.rsi.period,
        priorValue: rsiPriorValue,
        comparisonWindow: safeContext.rsi.slope.comparisonWindow,
        bands: { ...safeContext.rsi.bands },
        flatTolerance: safeContext.rsi.slope.flatTolerance,
      },
    },
    issues: problem ? [problem] : [],
  };
}

function emptyContext() {
  return {
    timeframe: { id: null, expectedIntervalMs: null },
    momentum: {
      window: null,
      neutralBand: null,
      strength: { weakMaxAbs: null, strongMinAbs: null },
      change: { comparisonWindow: null, flatTolerance: null },
    },
    rsi: {
      period: null,
      bands: { oversoldMax: null, lowMax: null, highMin: null, overboughtMin: null },
      slope: { comparisonWindow: null, flatTolerance: null },
    },
  };
}

function policyIssue(message, path) {
  return issue('INVALID_POLICY', message, path);
}

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  const actualKeys = Reflect.ownKeys(value);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every(key => typeof key === 'string' && expectedKeys.includes(key))
    && expectedKeys.every(key => Object.hasOwn(value, key));
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

module.exports = { analyzeMomentumRsi };
