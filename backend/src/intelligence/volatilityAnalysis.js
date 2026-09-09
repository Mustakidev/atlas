'use strict';

const { computeRawAtr } = require('../engine/atrCore');

function analyzeVolatility(candles, policy) {
  const policyResult = validatePolicy(policy);
  if (policyResult.issue) {
    return invalidResult(policyResult.context, policyResult.issue);
  }

  const normalizedPolicy = policyResult.policy;
  if (!Array.isArray(candles)) {
    return invalidResult(
      policyResult.context,
      issue('INVALID_CANDLE', 'Candles must be an array.', 'candles'),
    );
  }

  const candleIssue = validateCandleFields(candles);
  if (candleIssue) return invalidResult(policyResult.context, candleIssue);

  const finalizationIssue = validateFinalizationMarkers(candles);
  if (finalizationIssue) return invalidResult(policyResult.context, finalizationIssue);

  const timestampIssue = validateTimestampIdentity(candles);
  if (timestampIssue) return invalidResult(policyResult.context, timestampIssue);

  const orderingIssue = validateOrdering(candles);
  if (orderingIssue) return invalidResult(policyResult.context, orderingIssue);

  const cadenceIssue = validateCadence(candles, normalizedPolicy.timeframe.expectedIntervalMs);
  if (cadenceIssue) return invalidResult(policyResult.context, cadenceIssue);

  const asOf = candles.length > 0 ? candles[candles.length - 1].timestamp : null;
  if (candles.length < normalizedPolicy.period + 1) {
    return result({
      context: policyResult.context,
      status: 'INSUFFICIENT_DATA',
      asOf,
      issue: issue(
        'INSUFFICIENT_ATR_HISTORY',
        `At least ${normalizedPolicy.period + 1} candles are required for ATR.`,
        'candles',
      ),
    });
  }

  const raw = calculateRawAtr(candles, normalizedPolicy.period);
  if (!raw || !Number.isFinite(raw.atr) || !Number.isFinite(raw.atrPercent)) {
    return invalidResult(
      policyResult.context,
      issue('NON_FINITE_ATR', 'ATR calculation produced a non-finite value.', 'volatility'),
    );
  }

  const level = classifyLevel(raw.atrPercent, normalizedPolicy.level);
  const priorAtrPercents = [];
  for (let offset = 1; offset <= normalizedPolicy.trend.comparisonWindow; offset += 1) {
    const prefixLength = candles.length - offset;
    if (prefixLength < normalizedPolicy.period + 1) break;

    const priorRaw = calculateRawAtr(
      candles.slice(0, prefixLength),
      normalizedPolicy.period,
    );
    if (!priorRaw || !Number.isFinite(priorRaw.atr) || !Number.isFinite(priorRaw.atrPercent)) {
      return result({
        context: policyResult.context,
        status: 'READY',
        asOf,
        atr: raw.atr,
        atrPercent: raw.atrPercent,
        level,
        observedAtrPercent: raw.atrPercent,
        sampleCount: priorAtrPercents.length,
        issue: issue(
          'NON_FINITE_ATR',
          'Prior ATR calculation produced a non-finite value.',
          'volatility.evidence.trend',
        ),
      });
    }
    priorAtrPercents.push(priorRaw.atrPercent);
  }

  if (priorAtrPercents.length < normalizedPolicy.trend.comparisonWindow) {
    return result({
      context: policyResult.context,
      status: 'READY',
      asOf,
      atr: raw.atr,
      atrPercent: raw.atrPercent,
      level,
      observedAtrPercent: raw.atrPercent,
      sampleCount: priorAtrPercents.length,
      issue: issue(
        'INSUFFICIENT_TREND_BASELINE',
        `Exactly ${normalizedPolicy.trend.comparisonWindow} prior ATR observations are required.`,
        'volatility.evidence.trend',
      ),
    });
  }

  const baselineAtrPercent = priorAtrPercents.reduce((sum, value) => sum + value, 0)
    / normalizedPolicy.trend.comparisonWindow;
  if (!Number.isFinite(baselineAtrPercent)) {
    return result({
      context: policyResult.context,
      status: 'READY',
      asOf,
      atr: raw.atr,
      atrPercent: raw.atrPercent,
      level,
      observedAtrPercent: raw.atrPercent,
      sampleCount: priorAtrPercents.length,
      issue: issue(
        'NON_FINITE_ATR',
        'ATR baseline produced a non-finite value.',
        'volatility.evidence.trend',
      ),
    });
  }
  if (baselineAtrPercent <= 0) {
    return result({
      context: policyResult.context,
      status: 'READY',
      asOf,
      atr: raw.atr,
      atrPercent: raw.atrPercent,
      level,
      observedAtrPercent: raw.atrPercent,
      sampleCount: priorAtrPercents.length,
      baselineAtrPercent,
    });
  }

  const ratio = raw.atrPercent / baselineAtrPercent;
  if (!Number.isFinite(ratio)) {
    return invalidResult(
      policyResult.context,
      issue('NON_FINITE_ATR', 'ATR trend ratio produced a non-finite value.', 'volatility.evidence.trend'),
    );
  }
  const trend = classifyTrend(ratio, normalizedPolicy.trend);
  return result({
    context: policyResult.context,
    status: 'READY',
    asOf,
    atr: raw.atr,
    atrPercent: raw.atrPercent,
    level,
    trend,
    observedAtrPercent: raw.atrPercent,
    sampleCount: priorAtrPercents.length,
    baselineAtrPercent,
    ratio,
  });
}

function validatePolicy(policy) {
  const context = emptyPolicyContext();
  if (!isObject(policy)) {
    return { context, issue: issue('INVALID_POLICY', 'Policy must be an object.', 'policy') };
  }
  if (policy.schemaVersion !== 1) {
    return {
      context,
      issue: issue('INVALID_POLICY', 'schemaVersion must be 1.', 'policy.schemaVersion'),
    };
  }
  if (!isPositiveSafeInteger(policy.period)) {
    return {
      context,
      issue: issue('INVALID_POLICY', 'period must be a positive safe integer.', 'policy.period'),
    };
  }

  if (!isObject(policy.timeframe)) {
    return {
      context,
      issue: issue('INVALID_POLICY', 'timeframe must be an object.', 'policy.timeframe'),
    };
  }
  if (typeof policy.timeframe.id !== 'string' || policy.timeframe.id.trim().length === 0) {
    return {
      context,
      issue: issue('INVALID_POLICY', 'timeframe.id must be a non-empty string.', 'policy.timeframe.id'),
    };
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

  if (!isObject(policy.level)) {
    return {
      context,
      issue: issue('INVALID_POLICY', 'level must be an object.', 'policy.level'),
    };
  }
  if (policy.level.method !== 'FIXED') {
    return {
      context,
      issue: issue(
        'UNSUPPORTED_LEVEL_METHOD',
        'Only the FIXED level method is supported.',
        'policy.level.method',
      ),
    };
  }
  context.level.method = 'FIXED';
  if (!Number.isFinite(policy.level.lowMaxAtrPercent) || policy.level.lowMaxAtrPercent < 0) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'lowMaxAtrPercent must be a finite number greater than or equal to zero.',
        'policy.level.lowMaxAtrPercent',
      ),
    };
  }
  context.level.lowMaxAtrPercent = policy.level.lowMaxAtrPercent;
  if (!Number.isFinite(policy.level.highMinAtrPercent)
    || policy.level.highMinAtrPercent <= policy.level.lowMaxAtrPercent) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'highMinAtrPercent must be finite and greater than lowMaxAtrPercent.',
        'policy.level.highMinAtrPercent',
      ),
    };
  }
  context.level.highMinAtrPercent = policy.level.highMinAtrPercent;

  if (!isObject(policy.trend)) {
    return {
      context,
      issue: issue('INVALID_POLICY', 'trend must be an object.', 'policy.trend'),
    };
  }
  if (!isPositiveSafeInteger(policy.trend.comparisonWindow)) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'comparisonWindow must be a positive safe integer.',
        'policy.trend.comparisonWindow',
      ),
    };
  }
  context.trend.comparisonWindow = policy.trend.comparisonWindow;
  if (!Number.isFinite(policy.trend.compressingRatio)
    || policy.trend.compressingRatio <= 0
    || policy.trend.compressingRatio >= 1) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'compressingRatio must be finite and strictly between zero and one.',
        'policy.trend.compressingRatio',
      ),
    };
  }
  context.trend.compressingRatio = policy.trend.compressingRatio;
  if (!Number.isFinite(policy.trend.expandingRatio) || policy.trend.expandingRatio <= 1) {
    return {
      context,
      issue: issue(
        'INVALID_POLICY',
        'expandingRatio must be finite and greater than one.',
        'policy.trend.expandingRatio',
      ),
    };
  }
  context.trend.expandingRatio = policy.trend.expandingRatio;

  return {
    context,
    policy: {
      period: policy.period,
      timeframe: {
        id: policy.timeframe.id,
        expectedIntervalMs: policy.timeframe.expectedIntervalMs,
      },
      level: {
        lowMaxAtrPercent: policy.level.lowMaxAtrPercent,
        highMinAtrPercent: policy.level.highMinAtrPercent,
      },
      trend: {
        comparisonWindow: policy.trend.comparisonWindow,
        compressingRatio: policy.trend.compressingRatio,
        expandingRatio: policy.trend.expandingRatio,
      },
    },
  };
}

function validateCandleFields(candles) {
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const path = `candles[${index}]`;
    if (!isObject(candle)) {
      return issue('INVALID_CANDLE', 'Candle must be an object.', path);
    }
    for (const field of ['open', 'high', 'low', 'close']) {
      if (!Number.isFinite(candle[field])) {
        return issue('INVALID_CANDLE', `${field} must be a finite number.`, `${path}.${field}`);
      }
    }
    if (candle.close <= 0) {
      return issue('INVALID_CANDLE', 'close must be greater than zero.', `${path}.close`);
    }
    if (candle.high < candle.open || candle.high < candle.close || candle.high < candle.low) {
      return issue('INVALID_CANDLE', 'high is inconsistent with OHLC values.', `${path}.high`);
    }
    if (candle.low > candle.open || candle.low > candle.close || candle.low > candle.high) {
      return issue('INVALID_CANDLE', 'low is inconsistent with OHLC values.', `${path}.low`);
    }
    if (!Number.isSafeInteger(candle.openTime) || typeof candle.timestamp !== 'string') {
      return issue('INVALID_TIMESTAMP', 'openTime and timestamp are required.', `${path}.timestamp`);
    }
  }
  return null;
}

function validateFinalizationMarkers(candles) {
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.isFinalized === false || candle.active === true || candle.closed === false) {
      return issue('ACTIVE_CANDLE', 'Candle is not finalized.', `candles[${index}]`);
    }
  }
  return null;
}

function validateTimestampIdentity(candles) {
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    let canonicalTimestamp;
    try {
      canonicalTimestamp = new Date(candle.openTime).toISOString();
    } catch (_error) {
      return issue('INVALID_TIMESTAMP', 'openTime does not represent a valid timestamp.', `candles[${index}].openTime`);
    }
    if (canonicalTimestamp !== candle.timestamp) {
      return issue('INVALID_TIMESTAMP', 'timestamp does not match openTime.', `candles[${index}].timestamp`);
    }
  }
  return null;
}

function validateOrdering(candles) {
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].openTime - candles[index - 1].openTime;
    if (delta === 0) {
      return issue('DUPLICATE_TIMESTAMP', 'openTime must be unique.', `candles[${index}].openTime`);
    }
    if (delta < 0) {
      return issue('OUT_OF_ORDER_TIMESTAMP', 'openTime must be strictly increasing.', `candles[${index}].openTime`);
    }
  }
  return null;
}

function validateCadence(candles, expectedIntervalMs) {
  if (expectedIntervalMs === null) return null;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].openTime - candles[index - 1].openTime;
    if (delta !== expectedIntervalMs) {
      return issue(
        'CADENCE_MISMATCH',
        'Candle spacing does not match expectedIntervalMs.',
        `candles[${index}].openTime`,
      );
    }
  }
  return null;
}

function calculateRawAtr(candles, period) {
  try {
    return computeRawAtr(candles, period);
  } catch (_error) {
    return null;
  }
}

function classifyLevel(atrPercent, levelPolicy) {
  if (atrPercent <= levelPolicy.lowMaxAtrPercent) return 'LOW';
  if (atrPercent >= levelPolicy.highMinAtrPercent) return 'HIGH';
  return 'NORMAL';
}

function classifyTrend(ratio, trendPolicy) {
  if (ratio >= trendPolicy.expandingRatio) return 'EXPANDING';
  if (ratio <= trendPolicy.compressingRatio) return 'COMPRESSING';
  return 'STABLE';
}

function result({
  context,
  status,
  asOf,
  atr = null,
  atrPercent = null,
  level = 'UNKNOWN',
  trend = 'UNKNOWN',
  observedAtrPercent = null,
  sampleCount = 0,
  baselineAtrPercent = null,
  ratio = null,
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
    volatility: {
      atr,
      atrPercent,
      level,
      trend,
      evidence: {
        level: {
          method: context.level.method,
          lowMaxAtrPercent: context.level.lowMaxAtrPercent,
          highMinAtrPercent: context.level.highMinAtrPercent,
          observedAtrPercent,
        },
        trend: {
          comparisonWindow: context.trend.comparisonWindow,
          sampleCount,
          baselineAtrPercent,
          ratio,
          compressingRatio: context.trend.compressingRatio,
          expandingRatio: context.trend.expandingRatio,
        },
      },
    },
    issues: problem ? [problem] : [],
  };
}

function invalidResult(context, problem) {
  return result({
    context,
    status: 'INVALID_INPUT',
    asOf: null,
    issue: problem,
  });
}

function emptyPolicyContext() {
  return {
    timeframe: { id: null, expectedIntervalMs: null },
    level: {
      method: null,
      lowMaxAtrPercent: null,
      highMinAtrPercent: null,
    },
    trend: {
      comparisonWindow: null,
      compressingRatio: null,
      expandingRatio: null,
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

module.exports = { analyzeVolatility };
