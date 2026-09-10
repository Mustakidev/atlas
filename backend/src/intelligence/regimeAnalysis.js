'use strict';

const DIRECTIONS = Object.freeze(['BULLISH', 'BEARISH', 'MIXED', 'UNESTABLISHED']);
const CONDITIONS = Object.freeze(['TRENDING', 'RANGING', 'UNKNOWN']);
const VOLATILITY_LEVELS = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'UNKNOWN']);
const VOLATILITY_TRENDS = Object.freeze(['COMPRESSING', 'STABLE', 'EXPANDING', 'UNKNOWN']);

function analyzeRegime(input, policy) {
  const policyResult = validatePolicy(policy);
  if (policyResult.issue) return invalidResult(policyResult.context, policyResult.issue);

  if (!isObject(input)) {
    return invalidResult(
      policyResult.context,
      issue('INVALID_CANDLE_CONTEXT', 'Input must be an object.', 'input'),
    );
  }
  if (!Array.isArray(input.candles)) {
    return invalidResult(
      policyResult.context,
      issue('INVALID_CANDLE_CONTEXT', 'candles must be an array.', 'candles'),
    );
  }

  const structureResult = validateStructure(input.structure);
  if (structureResult.issue) return invalidResult(policyResult.context, structureResult.issue);
  if (structureResult.status !== 'READY') {
    return result({
      context: policyResult.context,
      status: 'INSUFFICIENT_DATA',
      issue: issue('INSUFFICIENT_STRUCTURE', 'StructureAnalysis is insufficient.', 'structure.status'),
    });
  }

  const volatilityResult = validateVolatility(input.volatility);
  if (volatilityResult.issue) return invalidResult(policyResult.context, volatilityResult.issue);
  if (volatilityResult.status !== 'READY') {
    return result({
      context: policyResult.context,
      status: 'INSUFFICIENT_DATA',
      issue: issue('INSUFFICIENT_VOLATILITY', 'VolatilityAnalysis is insufficient.', 'volatility.status'),
    });
  }

  const candleIssue = validateCandles(input.candles, policyResult.policy.timeframe.expectedIntervalMs);
  if (candleIssue) return invalidResult(policyResult.context, candleIssue);

  const boundaryIssue = validateBoundary(
    input.candles,
    structureResult.value,
    volatilityResult.value,
    policyResult.policy,
  );
  if (boundaryIssue) return invalidResult(policyResult.context, boundaryIssue);

  const finalIndex = input.candles.length - 1;
  const minimumHistory = Math.max(
    policyResult.policy.range.efficiencyWindow + 1,
    policyResult.policy.range.containment.window
      + policyResult.policy.range.containment.referenceWindow,
  );
  if (input.candles.length < minimumHistory) {
    return result({
      context: policyResult.context,
      status: 'INSUFFICIENT_DATA',
      asOf: input.candles[finalIndex].timestamp,
      direction: structureResult.value.structure.direction,
      volatility: volatilityResult.value.volatility,
      issue: issue(
        'INSUFFICIENT_RANGE_HISTORY',
        `At least ${minimumHistory} candles are required for regime evidence.`,
        'candles',
      ),
    });
  }

  const efficiencyResult = directionalEfficiency(
    input.candles,
    policyResult.policy.range.efficiencyWindow,
  );
  if (efficiencyResult.issue) return invalidResult(policyResult.context, efficiencyResult.issue);

  const containment = calculateContainment(input.candles, policyResult.policy.range.containment);
  const breakout = calculateBreakoutEvidence(
    structureResult.value.events,
    finalIndex,
    policyResult.policy.range.breakoutLookbackBars,
  );
  const compression = {
    level: volatilityResult.value.volatility.level,
    trend: volatilityResult.value.volatility.trend,
    supportive: volatilityResult.value.volatility.level === 'LOW'
      || volatilityResult.value.volatility.trend === 'COMPRESSING',
  };

  const rangeEvidence = buildRangeEvidence(
    structureResult.value.structure.direction,
    efficiencyResult.value,
    containment,
    breakout,
    compression,
    policyResult.policy,
  );
  const trendEvidence = buildTrendEvidence(
    structureResult.value.structure.direction,
    efficiencyResult.value,
    rangeEvidence.state,
    policyResult.policy.trend.minDirectionalEfficiency,
  );
  const decision = decideCondition(
    structureResult.value.structure.direction,
    rangeEvidence.state,
    trendEvidence.state,
  );

  return result({
    context: policyResult.context,
    status: 'READY',
    asOf: input.candles[finalIndex].timestamp,
    direction: structureResult.value.structure.direction,
    condition: decision.condition,
    volatility: volatilityResult.value.volatility,
    range: rangeEvidence,
    trend: trendEvidence,
    criteriaMet: decision.criteriaMet,
    criteriaMissing: decision.criteriaMissing,
    issue: decision.issue,
  });
}

function validatePolicy(policy) {
  const context = emptyPolicyContext();
  if (!isObject(policy)) return { context, issue: issue('INVALID_POLICY', 'Policy must be an object.', 'policy') };
  if (policy.schemaVersion !== 1) {
    return { context, issue: issue('INVALID_POLICY', 'schemaVersion must be 1.', 'policy.schemaVersion') };
  }
  if (!isObject(policy.timeframe)) {
    return { context, issue: issue('INVALID_POLICY', 'timeframe must be an object.', 'policy.timeframe') };
  }
  if (typeof policy.timeframe.id !== 'string' || policy.timeframe.id.trim().length === 0) {
    return { context, issue: issue('INVALID_POLICY', 'timeframe.id must be a non-empty string.', 'policy.timeframe.id') };
  }
  context.timeframe.id = policy.timeframe.id;
  if (policy.timeframe.expectedIntervalMs !== null
    && !isPositiveSafeInteger(policy.timeframe.expectedIntervalMs)) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'expectedIntervalMs must be null or a positive safe integer.',
        'policy.timeframe.expectedIntervalMs',
      ),
    };
  }
  context.timeframe.expectedIntervalMs = policy.timeframe.expectedIntervalMs;

  if (!isObject(policy.range)) {
    return { context, issue: issue('INVALID_POLICY', 'range must be an object.', 'policy.range') };
  }
  if (!isPositiveSafeInteger(policy.range.efficiencyWindow)) {
    return { context, issue: issue('INVALID_POLICY', 'efficiencyWindow must be a positive safe integer.', 'policy.range.efficiencyWindow') };
  }
  if (!isUnitInterval(policy.range.rangeMaxEfficiency)) {
    return { context, issue: issue('INVALID_POLICY', 'rangeMaxEfficiency must be finite in [0, 1].', 'policy.range.rangeMaxEfficiency') };
  }
  if (!isObject(policy.range.containment)) {
    return { context, issue: issue('INVALID_POLICY', 'containment must be an object.', 'policy.range.containment') };
  }
  if (!isPositiveSafeInteger(policy.range.containment.window)) {
    return { context, issue: issue('INVALID_POLICY', 'containment.window must be a positive safe integer.', 'policy.range.containment.window') };
  }
  if (!isPositiveSafeInteger(policy.range.containment.referenceWindow)) {
    return { context, issue: issue('INVALID_POLICY', 'referenceWindow must be a positive safe integer.', 'policy.range.containment.referenceWindow') };
  }
  if (!Number.isFinite(policy.range.containment.minContainedFraction)
    || policy.range.containment.minContainedFraction <= 0
    || policy.range.containment.minContainedFraction > 1) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'minContainedFraction must be finite in (0, 1].',
        'policy.range.containment.minContainedFraction',
      ),
    };
  }
  if (!isPositiveSafeInteger(policy.range.breakoutLookbackBars)) {
    return { context, issue: issue('INVALID_POLICY', 'breakoutLookbackBars must be a positive safe integer.', 'policy.range.breakoutLookbackBars') };
  }

  if (!isObject(policy.trend)) {
    return { context, issue: issue('INVALID_POLICY', 'trend must be an object.', 'policy.trend') };
  }
  if (!isUnitInterval(policy.trend.minDirectionalEfficiency)) {
    return { context, issue: issue('INVALID_POLICY', 'minDirectionalEfficiency must be finite in [0, 1].', 'policy.trend.minDirectionalEfficiency') };
  }
  if (policy.range.rangeMaxEfficiency >= policy.trend.minDirectionalEfficiency) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'rangeMaxEfficiency must be less than minDirectionalEfficiency.',
        'policy.range.rangeMaxEfficiency',
      ),
    };
  }

  const normalized = {
    schemaVersion: 1,
    timeframe: {
      id: policy.timeframe.id,
      expectedIntervalMs: policy.timeframe.expectedIntervalMs,
    },
    range: {
      efficiencyWindow: policy.range.efficiencyWindow,
      rangeMaxEfficiency: policy.range.rangeMaxEfficiency,
      containment: {
        window: policy.range.containment.window,
        referenceWindow: policy.range.containment.referenceWindow,
        minContainedFraction: policy.range.containment.minContainedFraction,
      },
      breakoutLookbackBars: policy.range.breakoutLookbackBars,
    },
    trend: {
      minDirectionalEfficiency: policy.trend.minDirectionalEfficiency,
    },
  };
  context.policy = normalized;
  return { context, policy: normalized };
}

function validateStructure(structure) {
  if (!isObject(structure)) return { issue: issue('INVALID_STRUCTURE', 'structure must be an object.', 'structure') };
  if (structure.status === 'INVALID_INPUT') {
    return { issue: issue('INVALID_STRUCTURE', 'StructureAnalysis is invalid.', 'structure.status') };
  }
  if (structure.status === 'INSUFFICIENT_DATA') return { status: 'INSUFFICIENT_DATA' };
  if (structure.status !== 'READY') {
    return { issue: issue('INVALID_STRUCTURE', 'structure.status is invalid.', 'structure.status') };
  }
  if (!isObject(structure.asOf)
    || !isPositiveOrZeroSafeInteger(structure.asOf.index)
    || !isCanonicalTimestamp(structure.asOf.timestamp)) {
    return { issue: issue('INVALID_STRUCTURE', 'structure.asOf is invalid.', 'structure.asOf') };
  }
  if (!isObject(structure.structure) || !DIRECTIONS.includes(structure.structure.direction)) {
    return { issue: issue('INVALID_STRUCTURE', 'structure.direction is invalid.', 'structure.structure.direction') };
  }
  if (!Array.isArray(structure.events)) {
    return { issue: issue('INVALID_STRUCTURE', 'structure.events must be an array.', 'structure.events') };
  }
  for (let index = 0; index < structure.events.length; index += 1) {
    const event = structure.events[index];
    if (!isObject(event) || typeof event.kind !== 'string' || !isObject(event.observedAt)
      || !isPositiveOrZeroSafeInteger(event.observedAt.index)
      || !isCanonicalTimestamp(event.observedAt.timestamp)
      || event.observedAt.index > structure.asOf.index) {
      return {
        issue: issue('INVALID_STRUCTURE', 'structure event boundary is invalid.', `structure.events[${index}]`),
      };
    }
  }
  let expectedIntervalMs = null;
  if (isObject(structure.policy) && Object.hasOwn(structure.policy, 'expectedIntervalMs')) {
    if (structure.policy.expectedIntervalMs !== null
      && !isPositiveSafeInteger(structure.policy.expectedIntervalMs)) {
      return { issue: issue('INVALID_STRUCTURE', 'structure expected interval is invalid.', 'structure.policy.expectedIntervalMs') };
    }
    expectedIntervalMs = structure.policy.expectedIntervalMs;
  }
  return {
    status: 'READY',
    value: {
      asOf: cloneValue(structure.asOf),
      policy: { expectedIntervalMs },
      structure: { direction: structure.structure.direction },
      events: structure.events,
    },
  };
}

function validateVolatility(volatility) {
  if (!isObject(volatility)) return { issue: issue('INVALID_VOLATILITY', 'volatility must be an object.', 'volatility') };
  if (volatility.status === 'INVALID_INPUT') {
    return { issue: issue('INVALID_VOLATILITY', 'VolatilityAnalysis is invalid.', 'volatility.status') };
  }
  if (volatility.status === 'INSUFFICIENT_DATA') return { status: 'INSUFFICIENT_DATA' };
  if (volatility.status !== 'READY') {
    return { issue: issue('INVALID_VOLATILITY', 'volatility.status is invalid.', 'volatility.status') };
  }
  if (!isCanonicalTimestamp(volatility.asOf)) {
    return { issue: issue('INVALID_VOLATILITY', 'volatility.asOf is invalid.', 'volatility.asOf') };
  }
  if (!isObject(volatility.timeframe)
    || typeof volatility.timeframe.id !== 'string'
    || volatility.timeframe.id.trim().length === 0
    || (volatility.timeframe.expectedIntervalMs !== null
      && !isPositiveSafeInteger(volatility.timeframe.expectedIntervalMs))) {
    return { issue: issue('INVALID_VOLATILITY', 'volatility.timeframe is invalid.', 'volatility.timeframe') };
  }
  if (!isObject(volatility.volatility)
    || !Number.isFinite(volatility.volatility.atr)
    || !Number.isFinite(volatility.volatility.atrPercent)
    || !VOLATILITY_LEVELS.includes(volatility.volatility.level)
    || !VOLATILITY_TRENDS.includes(volatility.volatility.trend)
    || !isObject(volatility.volatility.evidence)) {
    return { issue: issue('INVALID_VOLATILITY', 'volatility evidence is invalid.', 'volatility.volatility') };
  }
  return {
    status: 'READY',
    value: {
      asOf: volatility.asOf,
      timeframe: cloneValue(volatility.timeframe),
      volatility: cloneValue(volatility.volatility),
    },
  };
}

function validateCandles(candles, expectedIntervalMs) {
  if (candles.length === 0) return issue('INVALID_CANDLE_CONTEXT', 'At least one candle is required.', 'candles');
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const path = `candles[${index}]`;
    if (!isObject(candle)) return issue('INVALID_CANDLE_CONTEXT', 'Candle must be an object.', path);
    for (const field of ['open', 'high', 'low', 'close']) {
      if (!Number.isFinite(candle[field])) return issue('INVALID_CANDLE_CONTEXT', `${field} must be finite.`, `${path}.${field}`);
    }
    if (candle.close <= 0 || candle.high < candle.low || candle.high < candle.open
      || candle.high < candle.close || candle.low > candle.open || candle.low > candle.close) {
      return issue('INVALID_CANDLE_CONTEXT', 'OHLC values are inconsistent.', path);
    }
    if (!Number.isSafeInteger(candle.openTime) || typeof candle.timestamp !== 'string') {
      return issue('INVALID_CANDLE_CONTEXT', 'Candle timestamp fields are invalid.', `${path}.timestamp`);
    }
    if (!isCanonicalTimestamp(candle.timestamp, candle.openTime)) {
      return issue('INVALID_CANDLE_CONTEXT', 'timestamp does not match openTime.', `${path}.timestamp`);
    }
    if (candle.isFinalized === false || candle.active === true || candle.closed === false) {
      return issue('INVALID_CANDLE_CONTEXT', 'Candle is not finalized.', path);
    }
    if (index > 0) {
      const delta = candle.openTime - candles[index - 1].openTime;
      if (delta === 0) return issue('INVALID_CANDLE_CONTEXT', 'Duplicate candle timestamp.', `${path}.openTime`);
      if (delta < 0) return issue('INVALID_CANDLE_CONTEXT', 'Candle timestamps must increase.', `${path}.openTime`);
      if (expectedIntervalMs !== null && delta !== expectedIntervalMs) {
        return issue('INVALID_CANDLE_CONTEXT', 'Candle cadence does not match policy.', `${path}.openTime`);
      }
    }
  }
  return null;
}

function validateBoundary(candles, structure, volatility, policy) {
  const finalIndex = candles.length - 1;
  const finalTimestamp = candles[finalIndex].timestamp;
  if (structure.asOf.index !== finalIndex || structure.asOf.timestamp !== finalTimestamp
    || volatility.asOf !== finalTimestamp) {
    return issue('BOUNDARY_MISMATCH', 'Structure, volatility, and candles have different boundaries.', 'asOf');
  }
  if (policy.timeframe.id !== volatility.timeframe.id) {
    return issue('BOUNDARY_MISMATCH', 'Timeframe IDs do not match.', 'timeframe.id');
  }
  if (volatility.timeframe.expectedIntervalMs !== policy.timeframe.expectedIntervalMs) {
    return issue('BOUNDARY_MISMATCH', 'Volatility timeframe cadence does not match policy.', 'timeframe.expectedIntervalMs');
  }
  if (structure.policy.expectedIntervalMs !== null
    && structure.policy.expectedIntervalMs !== policy.timeframe.expectedIntervalMs) {
    return issue('BOUNDARY_MISMATCH', 'Structure cadence does not match policy.', 'structure.policy.expectedIntervalMs');
  }
  return null;
}

function directionalEfficiency(candles, window) {
  const start = candles.length - window - 1;
  const firstClose = candles[start].close;
  const lastClose = candles[candles.length - 1].close;
  let denominator = 0;
  for (let index = start + 1; index < candles.length; index += 1) {
    denominator += Math.abs(candles[index].close - candles[index - 1].close);
  }
  const value = denominator === 0 ? 0 : Math.abs(lastClose - firstClose) / denominator;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return { issue: issue('INVALID_CANDLE_CONTEXT', 'Directional efficiency is non-finite.', 'range.evidence.directionalEfficiency') };
  }
  return { value: { value, window, state: null } };
}

function calculateContainment(candles, policy) {
  const start = candles.length - policy.window;
  let containedCount = 0;
  for (let index = start; index < candles.length; index += 1) {
    const referenceStart = index - policy.referenceWindow;
    let high = -Infinity;
    let low = Infinity;
    for (let referenceIndex = referenceStart; referenceIndex < index; referenceIndex += 1) {
      high = Math.max(high, candles[referenceIndex].high);
      low = Math.min(low, candles[referenceIndex].low);
    }
    if (candles[index].close >= low && candles[index].close <= high) containedCount += 1;
  }
  const containedFraction = containedCount / policy.window;
  return {
    state: containedFraction >= policy.minContainedFraction ? 'SUPPORTED' : 'NOT_SUPPORTED',
    window: policy.window,
    referenceWindow: policy.referenceWindow,
    sampleCount: policy.window,
    containedCount,
    containedFraction,
    minContainedFraction: policy.minContainedFraction,
  };
}

function calculateBreakoutEvidence(events, finalIndex, lookbackBars) {
  const lowerBound = finalIndex - lookbackBars + 1;
  const recentCloseBreakCount = events.filter((event) => (
    event.kind === 'CLOSE_BREAK'
      && event.observedAt.index >= lowerBound
      && event.observedAt.index <= finalIndex
  )).length;
  return {
    state: recentCloseBreakCount === 0 ? 'NOT_PRESENT' : 'PRESENT',
    lookbackBars,
    recentCloseBreakCount,
  };
}

function buildRangeEvidence(direction, efficiency, containment, breakout, compression, policy) {
  const criteriaMet = [];
  const criteriaMissing = [];
  if (direction !== 'UNESTABLISHED') criteriaMet.push('ESTABLISHED_STRUCTURE_DIRECTION');
  else criteriaMissing.push('ESTABLISHED_STRUCTURE_DIRECTION');
  if (efficiency.value <= policy.range.rangeMaxEfficiency) criteriaMet.push('LOW_DIRECTIONAL_EFFICIENCY');
  else criteriaMissing.push('LOW_DIRECTIONAL_EFFICIENCY');
  if (containment.state === 'SUPPORTED') criteriaMet.push('CONTAINMENT_HELD');
  else criteriaMissing.push('CONTAINMENT_HELD');
  if (breakout.state === 'NOT_PRESENT') criteriaMet.push('NO_RECENT_CLOSE_BREAK');
  else criteriaMissing.push('NO_RECENT_CLOSE_BREAK');
  if (compression.supportive) criteriaMet.push('COMPRESSION_SUPPORT');

  const state = direction !== 'UNESTABLISHED'
    && efficiency.value <= policy.range.rangeMaxEfficiency
    && containment.state === 'SUPPORTED'
    && breakout.state === 'NOT_PRESENT'
    ? 'SUPPORTED'
    : 'NOT_SUPPORTED';
  return {
    state,
    evidence: {
      directionalEfficiency: {
        ...efficiency,
        state: efficiency.value <= policy.range.rangeMaxEfficiency ? 'SUPPORTED' : 'NOT_SUPPORTED',
      },
      containment,
      breakout,
      compression,
      criteriaMet,
      criteriaMissing,
    },
  };
}

function buildTrendEvidence(direction, efficiency, rangeState, threshold) {
  const criteriaMet = [];
  const criteriaMissing = [];
  if (direction === 'BULLISH' || direction === 'BEARISH') criteriaMet.push('ESTABLISHED_DIRECTION');
  else criteriaMissing.push('ESTABLISHED_DIRECTION');
  if (efficiency.value >= threshold) criteriaMet.push('HIGH_DIRECTIONAL_EFFICIENCY');
  else criteriaMissing.push('HIGH_DIRECTIONAL_EFFICIENCY');
  if (rangeState !== 'SUPPORTED') criteriaMet.push('RANGE_NOT_SUPPORTED');
  else criteriaMissing.push('RANGE_NOT_SUPPORTED');
  const state = (direction === 'BULLISH' || direction === 'BEARISH')
    && efficiency.value >= threshold
    && rangeState !== 'SUPPORTED'
    ? 'SUPPORTED'
    : 'NOT_SUPPORTED';
  return {
    state,
    evidence: {
      structureDirection: direction,
      directionalEfficiency: efficiency.value,
      minDirectionalEfficiency: threshold,
      contradictoryRangeEvidence: rangeState === 'SUPPORTED',
      criteriaMet,
      criteriaMissing,
    },
  };
}

function decideCondition(direction, rangeState, trendState) {
  if (direction === 'UNESTABLISHED') {
    return {
      condition: 'UNKNOWN',
      criteriaMet: [],
      criteriaMissing: ['ESTABLISHED_DIRECTION'],
      issue: issue('AMBIGUOUS_REGIME', 'Structure direction is unestablished.', 'condition'),
    };
  }
  if (trendState === 'SUPPORTED' && rangeState === 'NOT_SUPPORTED') {
    return { condition: 'TRENDING', criteriaMet: ['TREND_SUPPORTED'], criteriaMissing: [] };
  }
  if (rangeState === 'SUPPORTED' && trendState === 'NOT_SUPPORTED') {
    return { condition: 'RANGING', criteriaMet: ['RANGE_SUPPORTED'], criteriaMissing: [] };
  }
  if (trendState === 'SUPPORTED' && rangeState === 'SUPPORTED') {
    return {
      condition: 'UNKNOWN',
      criteriaMet: ['TREND_SUPPORTED', 'RANGE_SUPPORTED'],
      criteriaMissing: [],
      issue: issue('CONTRADICTORY_EVIDENCE', 'Trend and range evidence are both supported.', 'condition'),
    };
  }
  return {
    condition: 'UNKNOWN',
    criteriaMet: [],
    criteriaMissing: ['TREND_OR_RANGE_SUPPORTED'],
    issue: issue('AMBIGUOUS_REGIME', 'Evidence does not support a unique condition.', 'condition'),
  };
}

function result({
  context,
  status,
  asOf = null,
  direction = 'UNESTABLISHED',
  condition = 'UNKNOWN',
  volatility = null,
  range = null,
  trend = null,
  criteriaMet = [],
  criteriaMissing = [],
  issue: problem = null,
}) {
  return {
    schemaVersion: 1,
    status,
    asOf,
    timeframe: {
      id: context.timeframe.id,
      expectedIntervalMs: context.timeframe.expectedIntervalMs,
    },
    direction: {
      source: 'STRUCTURE',
      value: direction,
    },
    condition,
    volatility: volatility
      ? {
        atr: volatility.atr,
        atrPercent: volatility.atrPercent,
        level: volatility.level,
        trend: volatility.trend,
        evidence: cloneValue(volatility.evidence),
      }
      : emptyVolatility(),
    range: range || emptyRangeEvidence(),
    trend: trend || emptyTrendEvidence(),
    evidence: { criteriaMet, criteriaMissing },
    issues: problem ? [problem] : [],
  };
}

function invalidResult(context, problem) {
  return result({ context, status: 'INVALID_INPUT', issue: problem });
}

function emptyPolicyContext() {
  return {
    policy: null,
    timeframe: { id: null, expectedIntervalMs: null },
  };
}

function emptyVolatility() {
  return { atr: null, atrPercent: null, level: 'UNKNOWN', trend: 'UNKNOWN', evidence: null };
}

function emptyRangeEvidence() {
  return {
    state: 'UNKNOWN',
    evidence: {
      directionalEfficiency: { value: null, window: null, state: 'UNKNOWN' },
      containment: {
        state: 'UNKNOWN',
        window: null,
        referenceWindow: null,
        sampleCount: null,
        containedCount: null,
        containedFraction: null,
        minContainedFraction: null,
      },
      breakout: { state: 'UNKNOWN', lookbackBars: null, recentCloseBreakCount: null },
      compression: { level: 'UNKNOWN', trend: 'UNKNOWN', supportive: false },
      criteriaMet: [],
      criteriaMissing: [],
    },
  };
}

function emptyTrendEvidence() {
  return {
    state: 'UNKNOWN',
    evidence: {
      structureDirection: 'UNESTABLISHED',
      directionalEfficiency: null,
      minDirectionalEfficiency: null,
      contradictoryRangeEvidence: false,
      criteriaMet: [],
      criteriaMissing: [],
    },
  };
}

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isPositiveOrZeroSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isUnitInterval(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCanonicalTimestamp(timestamp, openTime = undefined) {
  if (typeof timestamp !== 'string') return false;
  try {
    const time = openTime === undefined ? Date.parse(timestamp) : openTime;
    return new Date(time).toISOString() === timestamp;
  } catch (_error) {
    return false;
  }
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, nested] of Object.entries(value)) copy[key] = cloneValue(nested);
  return copy;
}

module.exports = { analyzeRegime };
