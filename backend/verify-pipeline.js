#!/usr/bin/env node
/**
 * Atlas Pipeline End-to-End Verification Script
 * 
 * Runs the live pipeline for 1 hour, records every evaluation cycle,
 * and generates a verification report.
 * 
 * Usage: node verify-pipeline.js [--duration <minutes>] [--interval <seconds>]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ARGS = parseArgs();
const DURATION_MIN = ARGS.duration || 60;
const POLL_INTERVAL_SEC = ARGS.interval || 3;
const DURATION_MS = resolvePositiveIntegerOverride('ATLAS_VERIFY_DURATION_MS')
  ?? DURATION_MIN * 60 * 1000;
const POLL_INTERVAL_MS = resolvePositiveIntegerOverride('ATLAS_VERIFY_INTERVAL_MS')
  ?? POLL_INTERVAL_SEC * 1000;
const REPORT_DURATION_MIN = DURATION_MS / (60 * 1000);
const REPORT_INTERVAL_SEC = POLL_INTERVAL_MS / 1000;
const BASE_URL = resolveBaseUrl();
const OUTPUT_DIR = resolveOutputDirectory();
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `verify-${TIMESTAMP}.json`);
const REPORT_FILE = path.join(OUTPUT_DIR, `verify-${TIMESTAMP}.md`);

const CANONICAL_GATE_NAMES = [
  'trend',
  'structure',
  'rsi',
  'ema',
  'macd',
  'atr',
  'bollinger',
  'confluenceBias',
  'regimeDecision',
  'mtfConfirmation',
  'advanceRisk',
];
const BASE_GATE_NAMES = CANONICAL_GATE_NAMES.slice(0, 7);
const AVAILABLE_INSPECTOR_FIELDS = [
  'available',
  'timestamp',
  'cycle',
  'price',
  'timeframe',
  'confluence',
  'thresholds',
  'gates',
  'engines',
  'marketRegime',
  'risk',
  'verdict',
];
const UNAVAILABLE_INSPECTOR_MESSAGE = 'No decision data yet — waiting for first pipeline cycle';

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--duration' && process.argv[i + 1]) {
      args.duration = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--interval' && process.argv[i + 1]) {
      args.interval = parseInt(process.argv[i + 1], 10);
      i++;
    }
  }
  return args;
}

function resolvePositiveIntegerOverride(name) {
  if (!Object.hasOwn(process.env, name)) return null;

  const value = process.env[name];
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

function resolveBaseUrl() {
  const value = Object.hasOwn(process.env, 'ATLAS_VERIFY_BASE_URL')
    ? process.env.ATLAS_VERIFY_BASE_URL
    : 'http://localhost:3000';

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('ATLAS_VERIFY_BASE_URL must be a valid HTTP or HTTPS URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error('ATLAS_VERIFY_BASE_URL must be a valid HTTP or HTTPS URL without query or hash components');
  }

  return parsed.toString().replace(/\/+$/, '');
}

function resolveOutputDirectory() {
  if (Object.hasOwn(process.env, 'ATLAS_VERIFY_OUTPUT_DIR')) {
    const value = process.env.ATLAS_VERIFY_OUTPUT_DIR;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('ATLAS_VERIFY_OUTPUT_DIR must be a non-empty path');
    }
    return path.resolve(value);
  }

  return path.join(__dirname, '..', 'verification-reports');
}

function getHttpTransport(url) {
  if (url.protocol === 'http:') return http;
  if (url.protocol === 'https:') return https;
  throw new Error(`Unsupported URL protocol: ${url.protocol}`);
}

function resolveVerifierApiKey() {
  const value = process.env.ATLAS_VERIFY_API_KEY;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('ATLAS_VERIFY_API_KEY must be configured for authenticated Atlas requests');
  }
  return value;
}

function fetchJSON(urlPath) {
  return new Promise((resolve, reject) => {
    let apiKey;
    try {
      apiKey = resolveVerifierApiKey();
    } catch (error) {
      reject(error);
      return;
    }

    const requestUrl = new URL(`${BASE_URL}${urlPath}`);
    const req = getHttpTransport(requestUrl).get(requestUrl, {
      timeout: 5000,
      headers: { 'X-API-Key': apiKey },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${urlPath}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          const error = new Error(`JSON parse error: ${e.message}`);
          error.code = 'INVALID_JSON_RESPONSE';
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

const IMMUTABLE_TRADE_FIELDS = ['side', 'entry', 'sl', 'tp', 'size', 'rr', 'openedAt'];
const CLOSURE_TRADE_FIELDS = ['exit', 'pnl', 'closedAt'];

function isValidTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function requireFiniteNumber(value, fieldName) {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid paper trade ${fieldName}`);
  }
}

function normalizeTrade(trade, collection) {
  if (!trade || typeof trade !== 'object' || Array.isArray(trade)) {
    throw new Error('Invalid paper trade entry');
  }

  if (typeof trade.tradeId !== 'string' || trade.tradeId.trim() === '') {
    throw new Error('Paper trade is missing tradeId');
  }
  if (!['BUY', 'SELL'].includes(trade.direction)) {
    throw new Error(`Invalid paper trade direction for ${trade.tradeId}`);
  }
  if (!['OPEN', 'ACTIVE', 'CLOSED'].includes(trade.status)) {
    throw new Error(`Invalid paper trade status for ${trade.tradeId}`);
  }
  if (collection === 'open' && trade.status === 'CLOSED') {
    throw new Error(`Closed paper trade present in open collection: ${trade.tradeId}`);
  }
  if (collection === 'closed' && trade.status !== 'CLOSED') {
    throw new Error(`Open paper trade present in closed collection: ${trade.tradeId}`);
  }

  for (const [field, value] of [
    ['entryPrice', trade.entryPrice],
    ['stopLoss', trade.stopLoss],
    ['takeProfit', trade.takeProfit],
    ['positionSize', trade.positionSize],
    ['riskReward', trade.riskReward],
  ]) {
    requireFiniteNumber(value, field);
  }
  if (!isValidTimestamp(trade.entryTime) || !isValidTimestamp(trade.timestamp)) {
    throw new Error(`Invalid paper trade timestamp for ${trade.tradeId}`);
  }

  const isClosed = trade.status === 'CLOSED';
  if (isClosed) {
    requireFiniteNumber(trade.exitPrice, 'exitPrice');
    requireFiniteNumber(trade.pnl, 'pnl');
    if (!isValidTimestamp(trade.exitTime)) {
      throw new Error(`Invalid paper trade exitTime for ${trade.tradeId}`);
    }
  } else {
    if (trade.exitPrice !== null && trade.exitPrice !== undefined) {
      requireFiniteNumber(trade.exitPrice, 'exitPrice');
    }
    if (trade.pnl !== null && trade.pnl !== undefined) {
      requireFiniteNumber(trade.pnl, 'pnl');
    }
    if (trade.exitTime !== null && trade.exitTime !== undefined && !isValidTimestamp(trade.exitTime)) {
      throw new Error(`Invalid paper trade exitTime for ${trade.tradeId}`);
    }
  }

  return {
    id: trade.tradeId,
    type: isClosed ? 'closed' : 'opened',
    side: trade.direction,
    entry: trade.entryPrice,
    exit: trade.exitPrice ?? null,
    sl: trade.stopLoss,
    tp: trade.takeProfit,
    size: trade.positionSize,
    rr: trade.riskReward,
    pnl: trade.pnl ?? null,
    openedAt: trade.entryTime,
    closedAt: trade.exitTime ?? null,
    timestamp: trade.timestamp,
  };
}

function normalizePaperTradeResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Invalid paper trades response object');
  }
  if (!Object.hasOwn(response, 'open') || !Object.hasOwn(response, 'closed')) {
    throw new Error('Paper trades response must contain open and closed arrays');
  }
  if (!Array.isArray(response.open) || !Array.isArray(response.closed)) {
    throw new Error('Paper trades response open and closed fields must be arrays');
  }

  return {
    open: response.open.map(trade => normalizeTrade(trade, 'open')),
    closed: response.closed.map(trade => normalizeTrade(trade, 'closed')),
  };
}

function assertCompatibleTrade(existing, incoming, fields) {
  for (const field of fields) {
    if (!Object.is(existing[field], incoming[field])) {
      throw new Error(`Conflicting paper trade ${field} for ${incoming.id}`);
    }
  }
}

function mergeTradeObservation(tradesById, observation) {
  const existing = tradesById.get(observation.id);
  if (!existing) {
    tradesById.set(observation.id, { ...observation });
    return;
  }

  assertCompatibleTrade(existing, observation, IMMUTABLE_TRADE_FIELDS);

  if (observation.type === 'closed') {
    if (existing.type === 'closed') {
      assertCompatibleTrade(existing, observation, CLOSURE_TRADE_FIELDS);
    } else {
      existing.type = 'closed';
      existing.exit = observation.exit;
      existing.pnl = observation.pnl;
      existing.closedAt = observation.closedAt;
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inspectorError(message) {
  return new Error(`Invalid inspector response: ${message}`);
}

function requireInspectorField(response, field) {
  if (!Object.hasOwn(response, field)) {
    throw inspectorError(`missing ${field}`);
  }
}

function validateInspectorTrade(trade) {
  if (!isObject(trade)) throw inspectorError('verdict.trade must be an object when a trade opens');
  if (typeof trade.tradeId !== 'string' || trade.tradeId.trim() === '') {
    throw inspectorError('verdict.trade.tradeId must be a non-empty string');
  }
  if (!['BUY', 'SELL'].includes(trade.direction)) {
    throw inspectorError(`verdict.trade.direction must be BUY or SELL for ${trade.tradeId}`);
  }
  for (const field of ['entryPrice', 'stopLoss', 'takeProfit', 'riskReward', 'positionSize', 'confidence']) {
    if (!Number.isFinite(trade[field])) {
      throw inspectorError(`verdict.trade.${field} must be finite for ${trade.tradeId}`);
    }
  }
  if (typeof trade.reason !== 'string') {
    throw inspectorError(`verdict.trade.reason must be a string for ${trade.tradeId}`);
  }
}

function validateInspectorGates(gates) {
  if (!isObject(gates)) throw inspectorError('gates must be an object');

  for (const gateName of Object.keys(gates)) {
    if (!CANONICAL_GATE_NAMES.includes(gateName)) {
      throw inspectorError(`unknown gate ${gateName}`);
    }

    const gate = gates[gateName];
    if (!isObject(gate) || typeof gate.pass !== 'boolean' || !Object.hasOwn(gate, 'value') || typeof gate.detail !== 'string') {
      throw inspectorError(`malformed gate ${gateName}`);
    }
  }
}

function normalizeInspectorResponse(response) {
  if (!isObject(response)) throw inspectorError('response must be an object');

  if (response.available === false) {
    if (Object.keys(response).length !== 2
      || response.message !== UNAVAILABLE_INSPECTOR_MESSAGE) {
      throw inspectorError('unavailable response does not match the canonical shape');
    }
    return { ...response };
  }

  if (response.available !== true) {
    throw inspectorError('available must be true or false');
  }
  if (Object.hasOwn(response, 'trade')) {
    throw inspectorError('top-level trade is not canonical; use verdict.trade');
  }

  for (const field of AVAILABLE_INSPECTOR_FIELDS) requireInspectorField(response, field);

  if (!isValidTimestamp(response.timestamp)) throw inspectorError('timestamp must be a valid timestamp');
  if (!Number.isSafeInteger(response.cycle) || response.cycle < 1) throw inspectorError('cycle must be a positive integer');
  if (response.price !== null && (!Number.isFinite(response.price) || response.price <= 0)) {
    throw inspectorError('price must be null or a positive finite number');
  }
  if (typeof response.timeframe !== 'string' || response.timeframe.trim() === '') {
    throw inspectorError('timeframe must be a non-empty string');
  }
  if (response.confluence !== null && !isObject(response.confluence)) {
    throw inspectorError('confluence must be an object or null');
  }
  if (!isObject(response.thresholds)
    || !Number.isFinite(response.thresholds.bullish)
    || !Number.isFinite(response.thresholds.bearish)) {
    throw inspectorError('thresholds must contain finite bullish and bearish values');
  }
  if (!isObject(response.engines)) throw inspectorError('engines must be an object');
  if (response.marketRegime !== null && !isObject(response.marketRegime)) {
    throw inspectorError('marketRegime must be an object or null');
  }
  if (response.risk !== null && !isObject(response.risk)) {
    throw inspectorError('risk must be an object or null');
  }
  if (Object.hasOwn(response, 'regimeDecision') && !isObject(response.regimeDecision)) {
    throw inspectorError('regimeDecision must be an object when present');
  }
  if (Object.hasOwn(response, 'mtfConfirmation') && !isObject(response.mtfConfirmation)) {
    throw inspectorError('mtfConfirmation must be an object when present');
  }

  validateInspectorGates(response.gates);

  if (!isObject(response.verdict) || typeof response.verdict.tradeOpened !== 'boolean') {
    throw inspectorError('verdict must contain boolean tradeOpened');
  }
  if (!Object.hasOwn(response.verdict, 'rejectionReason') || !Object.hasOwn(response.verdict, 'trade')) {
    throw inspectorError('verdict must contain rejectionReason and trade');
  }

  if (response.verdict.tradeOpened) {
    if (response.verdict.rejectionReason !== null) {
      throw inspectorError('tradeOpened true requires a null rejectionReason');
    }
    validateInspectorTrade(response.verdict.trade);
  } else {
    if (response.verdict.trade !== null) {
      throw inspectorError('tradeOpened false requires a null trade');
    }
    if (typeof response.verdict.rejectionReason !== 'string' || response.verdict.rejectionReason.trim() === '') {
      throw inspectorError('tradeOpened false requires a non-empty rejectionReason');
    }
  }

  return { ...response };
}

function gateIsExplicitlySkipped(gate) {
  return gate
    && gate.pass === false
    && gate.value === '--'
    && /^Skipped\b/.test(gate.detail);
}

function sameKeys(actual, expected) {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function copyJsonValue(value) {
  if (Array.isArray(value)) return value.map(copyJsonValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, copyJsonValue(nestedValue)]));
  }
  return value;
}

const VERIFICATION_ERROR_CATEGORIES = [
  'inspectorEndpoint',
  'inspectorContract',
  'paperEndpoint',
  'paperContract',
];

function createVerificationMetrics({ startTime, requestedDurationMs, pollIntervalMs }) {
  const errors = {};
  VERIFICATION_ERROR_CATEGORIES.forEach(category => {
    errors[category] = { count: 0, firstMessage: null, firstTimestamp: null };
  });

  return {
    polling: {
      pollAttempts: 0,
      successfulInspectorPolls: 0,
      validInspectorResponses: 0,
      availableInspectorPolls: 0,
      unavailableInspectorPolls: 0,
      successfulPaperPolls: 0,
      expectedPollAttempts: pollIntervalMs > 0 ? Math.ceil(requestedDurationMs / pollIntervalMs) : 0,
      pollingDriftMs: 0,
    },
    errors,
    source: {
      uniqueSourceCycles: 0,
      duplicateSourceObservations: 0,
      firstSourceCycle: null,
      lastSourceCycle: null,
      missingSourceCycleCount: 0,
      missingSourceCycleRanges: [],
      sourceCycleRegressions: 0,
      sourceCycleRegressionDetails: [],
      maximumObservedSourceStallMs: 0,
      finalSourceStallMs: null,
      firstUniqueSourceObservedAt: null,
      lastUniqueSourceObservedAt: null,
    },
    runtime: {
      requestedDurationMs,
      actualElapsedMs: null,
      runCompleted: false,
    },
    _startTime: startTime,
    _pollIntervalMs: pollIntervalMs,
    _lastUniqueSourceObservedAt: null,
  };
}

function recordPollAttempt(metrics, receiptTimestamp) {
  const polling = metrics.polling;
  polling.pollAttempts++;
  const plannedTimestamp = metrics._startTime + ((polling.pollAttempts - 1) * metrics._pollIntervalMs);
  polling.pollingDriftMs = Math.max(
    polling.pollingDriftMs,
    Math.max(0, receiptTimestamp - plannedTimestamp),
  );
}

function recordVerificationFailure(metrics, category, message, timestamp) {
  const failure = metrics.errors[category];
  if (!failure) throw new Error(`Unknown verification failure category: ${category}`);
  failure.count++;
  if (failure.firstMessage === null) {
    failure.firstMessage = message;
    failure.firstTimestamp = timestamp;
  }
}

function recordSuccessfulInspectorPoll(metrics) {
  metrics.polling.successfulInspectorPolls++;
}

function recordInspectorResponse(metrics, inspector, receiptTimestamp) {
  metrics.polling.validInspectorResponses++;
  if (inspector.available) {
    metrics.polling.availableInspectorPolls++;
    return recordSourceObservation(metrics, inspector, receiptTimestamp);
  }
  metrics.polling.unavailableInspectorPolls++;
  return { type: 'unavailable' };
}

function recordSuccessfulPaperPoll(metrics) {
  metrics.polling.successfulPaperPolls++;
}

function recordSourceObservation(metrics, inspector, receiptTimestamp) {
  const source = metrics.source;
  const cycle = inspector.cycle;
  if (!Number.isSafeInteger(cycle) || cycle < 1) {
    throw inspectorError('cycle must be a positive safe integer');
  }

  if (source.lastSourceCycle === cycle) {
    source.duplicateSourceObservations++;
    return { type: 'duplicate', cycle };
  }

  if (source.lastSourceCycle !== null && cycle < source.lastSourceCycle) {
    source.sourceCycleRegressions++;
    source.sourceCycleRegressionDetails.push({
      previousCycle: source.lastSourceCycle,
      cycle,
      observedAt: receiptTimestamp,
    });
    return { type: 'regression', cycle, previousCycle: source.lastSourceCycle };
  }

  const previousCycle = source.lastSourceCycle;
  if (previousCycle !== null && cycle > previousCycle + 1) {
    const from = previousCycle + 1;
    const to = cycle - 1;
    const count = to - from + 1;
    source.missingSourceCycleCount += count;
    source.missingSourceCycleRanges.push({ from, to, count });
  }

  source.uniqueSourceCycles++;
  if (source.firstSourceCycle === null) source.firstSourceCycle = cycle;
  source.lastSourceCycle = cycle;
  if (source.firstUniqueSourceObservedAt === null) {
    source.firstUniqueSourceObservedAt = receiptTimestamp;
  }
  if (metrics._lastUniqueSourceObservedAt !== null) {
    const stallMs = Math.max(0, receiptTimestamp - metrics._lastUniqueSourceObservedAt);
    source.maximumObservedSourceStallMs = Math.max(source.maximumObservedSourceStallMs, stallMs);
  }
  metrics._lastUniqueSourceObservedAt = receiptTimestamp;
  source.lastUniqueSourceObservedAt = receiptTimestamp;

  return { type: 'unique', cycle, previousCycle };
}

function finalizeVerificationMetrics(metrics, endTime) {
  const runtime = metrics.runtime;
  runtime.actualElapsedMs = endTime - metrics._startTime;
  runtime.runCompleted = runtime.actualElapsedMs >= runtime.requestedDurationMs;
  if (metrics._lastUniqueSourceObservedAt !== null) {
    metrics.source.finalSourceStallMs = Math.max(0, endTime - metrics._lastUniqueSourceObservedAt);
  }
  return metrics;
}

function serializeVerificationMetrics(metrics) {
  return {
    polling: { ...metrics.polling },
    errors: Object.fromEntries(Object.entries(metrics.errors).map(([category, failure]) => [category, { ...failure }])),
    source: {
      ...metrics.source,
      missingSourceCycleRanges: metrics.source.missingSourceCycleRanges.map(range => ({ ...range })),
      sourceCycleRegressionDetails: metrics.source.sourceCycleRegressionDetails.map(detail => ({ ...detail })),
    },
    runtime: { ...metrics.runtime },
  };
}

function getVerificationMetrics(verificationState = {}) {
  return verificationState.metrics || verificationState.verification || null;
}

function processPollResults({
  inspectorResult,
  paperTradesResult,
  metrics,
  verificationState,
  cycles,
  tradesById,
  inspectorReceiptTimestamp,
  paperReceiptTimestamp,
}) {
  const errors = [];
  if (inspectorResult.status === 'fulfilled') recordSuccessfulInspectorPoll(metrics);
  const recordFailure = (result, endpointCategory, contractCategory, stateKey, firstFailureKey, timestamp) => {
    const reason = result.reason;
    const isParseFailure = reason?.code === 'INVALID_JSON_RESPONSE';
    const category = isParseFailure ? contractCategory : endpointCategory;
    const message = reason?.message || String(reason);
    verificationState[stateKey] = true;
    verificationState[firstFailureKey] = verificationState[firstFailureKey] || message;
    recordVerificationFailure(metrics, category, message, timestamp);
    errors.push(message);
  };

  if (inspectorResult.status === 'rejected') {
    recordFailure(
      inspectorResult,
      'inspectorEndpoint',
      'inspectorContract',
      'inspectorFailed',
      'firstInspectorFailure',
      inspectorReceiptTimestamp,
    );
  } else {
    try {
      const inspector = normalizeInspectorResponse(inspectorResult.value);
      if (!inspector.available) {
        recordInspectorResponse(metrics, inspector, inspectorReceiptTimestamp);
      } else {
        const coverage = evaluateGateCoverage(inspector);
        if (!coverage.valid) throw inspectorError(`gate coverage failed: ${coverage.errors.join('; ')}`);

        const sourceObservation = recordInspectorResponse(metrics, inspector, inspectorReceiptTimestamp);
        if (sourceObservation.type === 'unique') {
          cycles.push(buildCycleRecord(inspector));
        }
      }
    } catch (e) {
      verificationState.inspectorFailed = true;
      verificationState.firstInspectorFailure = verificationState.firstInspectorFailure || e.message;
      recordVerificationFailure(metrics, 'inspectorContract', e.message, inspectorReceiptTimestamp);
      errors.push(e.message);
    }
  }

  if (paperTradesResult.status === 'rejected') {
    recordFailure(
      paperTradesResult,
      'paperEndpoint',
      'paperContract',
      'paperContractFailed',
      'firstPaperFailure',
      paperReceiptTimestamp,
    );
  } else {
    try {
      const normalizedPaperTrades = normalizePaperTradeResponse(paperTradesResult.value);
      normalizedPaperTrades.open.forEach(trade => mergeTradeObservation(tradesById, trade));
      normalizedPaperTrades.closed.forEach(trade => mergeTradeObservation(tradesById, trade));
      recordSuccessfulPaperPoll(metrics);
    } catch (e) {
      verificationState.paperContractFailed = true;
      verificationState.firstPaperFailure = verificationState.firstPaperFailure || e.message;
      recordVerificationFailure(metrics, 'paperContract', e.message, paperReceiptTimestamp);
      errors.push(e.message);
    }
  }

  return { failed: errors.length > 0, errors };
}

function coverageError(result, message) {
  result.errors.push(message);
  return result;
}

function evaluateGateCoverage(inspector) {
  const result = {
    valid: true,
    path: null,
    statuses: {},
    errors: [],
  };
  const gates = inspector.gates || {};
  const gateKeys = Object.keys(gates);
  const verdict = inspector.verdict || {
    tradeOpened: inspector.tradeOpened,
    rejectionReason: inspector.rejectionReason,
    trade: inspector.tradeDetails,
  };
  const confluence = inspector.confluence || (
    Object.hasOwn(inspector, 'confluenceScore') && inspector.confluenceScore != null
      ? { score: inspector.confluenceScore, bias: inspector.bias }
      : null
  );

  for (const gateName of gateKeys) {
    if (!CANONICAL_GATE_NAMES.includes(gateName)) {
      result.statuses[gateName] = 'unknown';
      coverageError(result, `Unknown gate ${gateName}`);
    } else if (!isObject(gates[gateName]) || typeof gates[gateName].pass !== 'boolean') {
      result.statuses[gateName] = 'malformed';
      coverageError(result, `Malformed gate ${gateName}`);
    } else if (gateIsExplicitlySkipped(gates[gateName])) {
      result.statuses[gateName] = 'skipped';
    } else if (gates[gateName].pass) {
      result.statuses[gateName] = 'evaluated-pass';
    } else {
      result.statuses[gateName] = 'evaluated-fail';
    }
  }

  if (gateKeys.length === 0) {
    const engines = isObject(inspector.engines) ? inspector.engines : {};
    const hasProgressedState = confluence !== null
      || inspector.marketRegime != null
      || inspector.risk != null
      || Object.keys(engines).length > 0
      || Object.hasOwn(inspector, 'regimeDecision')
      || Object.hasOwn(inspector, 'mtfConfirmation');

    result.path = 'early-rejection';
    if (verdict.tradeOpened !== false) coverageError(result, 'Early rejection must not open a trade');
    if (verdict.trade !== null) coverageError(result, 'Early rejection requires a null trade');
    if (typeof verdict.rejectionReason !== 'string' || verdict.rejectionReason.trim() === '') {
      coverageError(result, 'Early rejection requires a non-empty rejectionReason');
    }
    if (hasProgressedState) coverageError(result, 'Early rejection contains progressed decision state');
    result.valid = result.errors.length === 0;
    return result;
  }

  const baseAndConfluence = [...BASE_GATE_NAMES, 'confluenceBias'];
  for (const gateName of baseAndConfluence) {
    if (!Object.hasOwn(gates, gateName)) {
      result.statuses[gateName] = 'missing';
      coverageError(result, `Missing mandatory gate ${gateName}`);
    }
  }

  if (!Object.hasOwn(gates, 'regimeDecision')) {
    result.statuses.regimeDecision = 'missing';
    coverageError(result, 'Missing mandatory gate regimeDecision');
  }

  const confluenceGate = gates.confluenceBias;
  const regimeGate = gates.regimeDecision;
  const neutral = confluenceGate?.value === 'Neutral' && confluenceGate.pass === false;

  if (neutral) {
    result.path = 'neutral';
    if (!gateIsExplicitlySkipped(gates.mtfConfirmation)) {
      result.statuses.mtfConfirmation = Object.hasOwn(gates, 'mtfConfirmation') ? 'evaluated-fail' : 'missing';
      coverageError(result, 'Neutral path requires explicitly skipped mtfConfirmation');
    }
    if (!gateIsExplicitlySkipped(gates.advanceRisk)) {
      result.statuses.advanceRisk = Object.hasOwn(gates, 'advanceRisk') ? 'evaluated-fail' : 'missing';
      coverageError(result, 'Neutral path requires explicitly skipped advanceRisk');
    }
    if (!regimeGate || regimeGate.value !== 'NEUTRAL' || !regimeGate.pass) {
      coverageError(result, 'Neutral path requires a passing NEUTRAL regimeDecision');
    }
    if (verdict.tradeOpened) coverageError(result, 'Neutral path cannot open a trade');
  } else if (confluenceGate?.pass === true && ['Bullish', 'Bearish'].includes(confluenceGate.value)) {
    if (!regimeGate) {
      result.path = 'directional-invalid';
    } else if (!regimeGate.pass) {
      result.path = 'regime-rejection';
      result.statuses.mtfConfirmation = 'legitimately-absent';
      result.statuses.advanceRisk = 'legitimately-absent';
      if (Object.hasOwn(gates, 'mtfConfirmation') || Object.hasOwn(gates, 'advanceRisk')) {
        coverageError(result, 'Regime rejection must not evaluate downstream gates');
      }
      if (verdict.tradeOpened) coverageError(result, 'Regime rejection cannot open a trade');
    } else if (!Object.hasOwn(gates, 'mtfConfirmation')) {
      result.path = 'mtf-missing';
      coverageError(result, 'Passing regimeDecision requires mtfConfirmation');
    } else if (!gates.mtfConfirmation.pass) {
      result.path = 'mtf-rejection';
      result.statuses.advanceRisk = 'legitimately-absent';
      if (Object.hasOwn(gates, 'advanceRisk')) coverageError(result, 'MTF rejection must not evaluate advanceRisk');
      if (verdict.tradeOpened) coverageError(result, 'MTF rejection cannot open a trade');
    } else if (!Object.hasOwn(gates, 'advanceRisk')) {
      result.path = 'advance-risk-missing';
      coverageError(result, 'Passing mtfConfirmation requires advanceRisk');
    } else {
      result.path = 'advance-risk';
      if (!gates.advanceRisk.pass && verdict.tradeOpened) {
        coverageError(result, 'Rejected advanceRisk cannot open a trade');
      }
    }
  } else {
    result.path = 'invalid-direction-path';
    coverageError(result, 'confluenceBias does not describe a recognized neutral or directional path');
  }

  const expectedKeys = {
    neutral: [...baseAndConfluence, 'mtfConfirmation', 'advanceRisk', 'regimeDecision'],
    'regime-rejection': [...baseAndConfluence, 'regimeDecision'],
    'mtf-rejection': [...baseAndConfluence, 'regimeDecision', 'mtfConfirmation'],
    'advance-risk': [...baseAndConfluence, 'regimeDecision', 'mtfConfirmation', 'advanceRisk'],
  }[result.path];
  if (expectedKeys && !sameKeys(gateKeys, expectedKeys)) {
    coverageError(result, `Gate order or set mismatch for ${result.path}`);
  }

  result.valid = result.errors.length === 0;
  return result;
}

function buildCycleRecord(inspector) {
  const record = {
    cycle: inspector.cycle,
    timestamp: inspector.timestamp,
    price: inspector.price,
    confluenceScore: inspector.confluence?.score,
    bias: inspector.confluence?.bias,
    confidence: inspector.confluence?.confidence,
    gates: copyJsonValue(inspector.gates || {}),
    verdict: copyJsonValue(inspector.verdict || {}),
    tradeOpened: inspector.verdict?.tradeOpened || false,
    rejectionReason: inspector.verdict?.rejectionReason || null,
    tradeDetails: inspector.verdict?.trade ? copyJsonValue(inspector.verdict.trade) : null,
  };
  return record;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function evaluateChecks(cycles, trades, verificationState = {}) {
  const totalCycles = cycles.length;
  const cyclesWithPrice = cycles.filter(c => c.price != null);
  const confluenceScores = cyclesWithPrice.map(c => c.confluenceScore).filter(s => s != null);
  const gateCoverage = cycles.map(c => evaluateGateCoverage(c));
  const metrics = getVerificationMetrics(verificationState);
  const source = metrics?.source;
  const runtime = metrics?.runtime;
  const errors = metrics?.errors;
  const biasCounts = {};
  const rejectionReasons = {};
  cycles.forEach(c => {
    const bias = c.bias || 'Unknown';
    biasCounts[bias] = (biasCounts[bias] || 0) + 1;
    if (!c.tradeOpened) {
      const reason = c.rejectionReason || 'Unknown';
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    }
  });
  const gateNotEval = {};
  const gateNames = CANONICAL_GATE_NAMES;
  gateNames.forEach(g => { gateNotEval[g] = 0; });
  cycles.forEach((c, index) => {
    gateNames.forEach(g => {
      const status = gateCoverage[index].statuses[g];
      if (!status || status === 'skipped' || status === 'legitimately-absent' || status === 'missing') {
        gateNotEval[g]++;
      }
    });
  });

  const sourceProgress = source
    ? source.uniqueSourceCycles >= 2 && source.lastSourceCycle > source.firstSourceCycle
    : totalCycles > 0;
  const sourceProgressDetail = source
    ? source.uniqueSourceCycles === 0
      ? 'No unique available source cycles observed'
      : source.uniqueSourceCycles === 1
        ? 'Inconclusive: one unique source cycle is insufficient to prove progress'
        : `Observed ${source.uniqueSourceCycles} unique source cycles from ${source.firstSourceCycle} to ${source.lastSourceCycle}`
    : 'Source telemetry was not provided to this direct helper call';
  const endpointPass = category => errors
    ? errors[category].count === 0
    : category === 'inspectorEndpoint' ? !verificationState.inspectorFailed : !verificationState.paperContractFailed;
  const schemaPass = category => errors
    ? errors[category].count === 0
    : category === 'inspectorContract' ? !verificationState.inspectorFailed : !verificationState.paperContractFailed;
  const runtimePass = runtime ? runtime.runCompleted : true;
  const checks = [
    { name: 'Pipeline running (cycles > 0)', pass: totalCycles > 0, observed: totalCycles, required: '> 0' },
    { name: 'Price data available', pass: cyclesWithPrice.length > 0, observed: cyclesWithPrice.length, required: '> 0' },
    { name: 'Confluence scores computed', pass: confluenceScores.length > 0, observed: confluenceScores.length, required: '> 0' },
    { name: 'Gate coverage contract', pass: gateCoverage.every(result => result.valid), observed: gateCoverage.filter(result => result.valid).length, required: `${gateCoverage.length} valid cycles` },
    { name: 'Bias distribution valid (no Unknown)', pass: !biasCounts.Unknown, observed: biasCounts.Unknown || 0, required: '0 Unknown cycles' },
    { name: 'Rejection reasons recorded', pass: Object.keys(rejectionReasons).length > 0, observed: Object.keys(rejectionReasons).length, required: '> 0 reasons' },
    { name: 'Requested runtime completed', pass: runtimePass, observed: runtime?.actualElapsedMs ?? 'not measured', required: runtime ? `>= ${runtime.requestedDurationMs}ms` : 'run telemetry' },
    { name: 'Inspector endpoint integrity', pass: endpointPass('inspectorEndpoint'), observed: errors?.inspectorEndpoint.count ?? (verificationState.inspectorFailed ? 1 : 0), required: '0 endpoint errors' },
    { name: 'Inspector schema integrity', pass: schemaPass('inspectorContract'), observed: errors?.inspectorContract.count ?? (verificationState.inspectorFailed ? 1 : 0), required: '0 contract errors' },
    { name: 'Paper endpoint integrity', pass: endpointPass('paperEndpoint'), observed: errors?.paperEndpoint.count ?? 0, required: '0 endpoint errors' },
    { name: 'Paper contract integrity', pass: schemaPass('paperContract'), observed: errors?.paperContract.count ?? (verificationState.paperContractFailed ? 1 : 0), required: '0 contract errors' },
    { name: 'Source cycle progressed', pass: sourceProgress, observed: source?.uniqueSourceCycles ?? totalCycles, required: 'at least 2 strictly increasing unique cycles', detail: sourceProgressDetail },
    { name: 'Source cycle continuity', pass: source ? source.sourceCycleRegressions === 0 : true, observed: source?.sourceCycleRegressions ?? 0, required: '0 cycle regressions' },
  ];

  return { checks, allPass: checks.every(c => c.pass) };
}

function generateReport(cycles, trades, startTime, endTime, verificationState = {}) {
  const totalCycles = cycles.length;
  const durationMs = endTime - startTime;
  const metrics = getVerificationMetrics(verificationState);
  const serializedMetrics = metrics
    ? (verificationState.verification ? metrics : serializeVerificationMetrics(metrics))
    : null;

  const cyclesWithPrice = cycles.filter(c => c.price != null);
  const cyclesNoPrice = cycles.filter(c => c.price == null);

  const biasCounts = {};
  cycles.forEach(c => {
    const bias = c.bias || 'Unknown';
    biasCounts[bias] = (biasCounts[bias] || 0) + 1;
  });

  const rejectionReasons = {};
  cycles.forEach(c => {
    if (!c.tradeOpened) {
      const reason = c.rejectionReason || 'Unknown';
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    }
  });

  const gatePassCounts = {};
  const gateFailCounts = {};
  const gateNotEval = {};
  const gateNames = CANONICAL_GATE_NAMES;
  gateNames.forEach(g => { gatePassCounts[g] = 0; gateFailCounts[g] = 0; gateNotEval[g] = 0; });

  cycles.forEach(c => {
    const coverage = evaluateGateCoverage(c);
    gateNames.forEach(g => {
      const status = coverage.statuses[g];
      if (status === 'evaluated-pass') {
        gatePassCounts[g]++;
      } else if (status === 'evaluated-fail') {
        gateFailCounts[g]++;
      } else {
        gateNotEval[g]++;
      }
    });
  });

  const prices = cyclesWithPrice.map(c => c.price);
  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;
  const priceStart = prices.length ? prices[0] : 0;
  const priceEnd = prices.length ? prices[prices.length - 1] : 0;
  const priceChange = priceStart ? ((priceEnd - priceStart) / priceStart * 100).toFixed(2) : '0';

  const confluenceScores = cyclesWithPrice.map(c => c.confluenceScore).filter(s => s != null);
  const avgConfluence = confluenceScores.length
    ? (confluenceScores.reduce((a, b) => a + b, 0) / confluenceScores.length).toFixed(1)
    : 'N/A';
  const minConfluence = confluenceScores.length ? Math.min(...confluenceScores) : 'N/A';
  const maxConfluence = confluenceScores.length ? Math.max(...confluenceScores) : 'N/A';

  const tradesOpened = trades;
  const tradesClosed = trades.filter(t => t.type === 'closed');
  const totalTradesOpened = tradesOpened.length;
  const totalTradesClosed = tradesClosed.length;

  let wins = 0, losses = 0, totalPnL = 0, grossProfit = 0, grossLoss = 0;
  const pnls = [];
  tradesClosed.forEach(t => {
    const pnl = t.pnl || 0;
    pnls.push(pnl);
    totalPnL += pnl;
    if (pnl > 0) { wins++; grossProfit += pnl; }
    else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); }
  });
  const winRate = totalTradesClosed > 0 ? (wins / totalTradesClosed * 100).toFixed(1) : 'N/A';
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : 'N/A');
  const expectancy = totalTradesClosed > 0 ? (totalPnL / totalTradesClosed).toFixed(2) : 'N/A';
  const avgWin = wins > 0 ? (grossProfit / wins).toFixed(2) : 'N/A';
  const avgLoss = losses > 0 ? (grossLoss / losses).toFixed(2) : 'N/A';
  const largestWin = pnls.length ? Math.max(...pnls).toFixed(2) : 'N/A';
  const largestLoss = pnls.length ? Math.min(...pnls).toFixed(2) : 'N/A';

  const tradesBySide = { BUY: 0, SELL: 0 };
  tradesOpened.forEach(t => { tradesBySide[t.side] = (tradesBySide[t.side] || 0) + 1; });

  let md = `# Atlas Pipeline Verification Report\n\n`;
  md += `**Generated:** ${new Date(endTime).toISOString()}\n`;
  md += `**Duration:** ${formatTime(durationMs)} (${REPORT_DURATION_MIN} min target)\n`;
  md += `**Poll Interval:** ${REPORT_INTERVAL_SEC}s\n`;
  md += `**Symbol:** BTC/USDT\n\n`;
  md += `Gap, stall, and polling-drift values are telemetry only. They do not independently fail verification, and no configured hard threshold currently applies.\n\n`;

  md += `## Verification Run Metrics\n\n`;
  if (serializedMetrics) {
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Requested Duration | ${serializedMetrics.runtime.requestedDurationMs}ms |\n`;
    md += `| Actual Elapsed | ${serializedMetrics.runtime.actualElapsedMs ?? 'not finalized'}ms |\n`;
    md += `| Run Completed | ${serializedMetrics.runtime.runCompleted} |\n`;
    md += `| Poll Attempts | ${serializedMetrics.polling.pollAttempts} |\n`;
    md += `| Expected Poll Attempts | ${serializedMetrics.polling.expectedPollAttempts} |\n`;
    md += `| Polling Drift (diagnostic only) | ${serializedMetrics.polling.pollingDriftMs}ms |\n\n`;
  } else {
    md += `Telemetry was not provided to this direct report call.\n\n`;
  }

  md += `## Polling Health\n\n`;
  if (serializedMetrics) {
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Successful Inspector Polls | ${serializedMetrics.polling.successfulInspectorPolls} |\n`;
    md += `| Valid Inspector Responses | ${serializedMetrics.polling.validInspectorResponses} |\n`;
    md += `| Available Inspector Polls | ${serializedMetrics.polling.availableInspectorPolls} |\n`;
    md += `| Unavailable Inspector Polls | ${serializedMetrics.polling.unavailableInspectorPolls} |\n`;
    md += `| Successful Paper Polls | ${serializedMetrics.polling.successfulPaperPolls} |\n\n`;
  } else {
    md += `Telemetry was not provided to this direct report call.\n\n`;
  }

  md += `## Source Progress and Continuity\n\n`;
  if (serializedMetrics) {
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Unique Source Cycles | ${serializedMetrics.source.uniqueSourceCycles} |\n`;
    md += `| Duplicate Source Observations | ${serializedMetrics.source.duplicateSourceObservations} |\n`;
    md += `| First Source Cycle | ${serializedMetrics.source.firstSourceCycle ?? 'N/A'} |\n`;
    md += `| Last Source Cycle | ${serializedMetrics.source.lastSourceCycle ?? 'N/A'} |\n`;
    md += `| Missing Source Cycle Count (diagnostic only) | ${serializedMetrics.source.missingSourceCycleCount} |\n`;
    md += `| Missing Source Cycle Ranges (diagnostic only) | ${JSON.stringify(serializedMetrics.source.missingSourceCycleRanges)} |\n`;
    md += `| Source Cycle Regressions | ${serializedMetrics.source.sourceCycleRegressions} |\n`;
    md += `| Maximum Observed Source Stall (diagnostic only) | ${serializedMetrics.source.maximumObservedSourceStallMs}ms |\n`;
    md += `| Final Source Stall (diagnostic only) | ${serializedMetrics.source.finalSourceStallMs ?? 'N/A'}ms |\n\n`;
  } else {
    md += `Telemetry was not provided to this direct report call.\n\n`;
  }

  md += `## Failure Summary\n\n`;
  if (serializedMetrics) {
    md += `| Category | Count | First Message | First Timestamp |\n|---|---:|---|---|\n`;
    Object.entries(serializedMetrics.errors).forEach(([category, failure]) => {
      md += `| ${category} | ${failure.count} | ${failure.firstMessage || 'N/A'} | ${failure.firstTimestamp ?? 'N/A'} |\n`;
    });
    md += `\n`;
  } else {
    md += `Telemetry was not provided to this direct report call.\n\n`;
  }

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Total Cycles Recorded | ${totalCycles} |\n`;
  md += `| Cycles with Price | ${cyclesWithPrice.length} |\n`;
  md += `| Cycles without Price | ${cyclesNoPrice.length} |\n`;
  md += `| Duration | ${formatTime(durationMs)} |\n\n`;

  md += `## Price Action\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Start Price | $${priceStart.toLocaleString()} |\n`;
  md += `| End Price | $${priceEnd.toLocaleString()} |\n`;
  md += `| Change | ${priceChange}% |\n`;
  md += `| Low | $${priceMin.toLocaleString()} |\n`;
  md += `| High | $${priceMax.toLocaleString()} |\n\n`;

  md += `## Confluence\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Average Score | ${avgConfluence} |\n`;
  md += `| Min Score | ${minConfluence} |\n`;
  md += `| Max Score | ${maxConfluence} |\n`;
  md += `| Bullish Threshold | ≥65 |\n`;
  md += `| Bearish Threshold | ≤35 |\n\n`;

  md += `## Bias Distribution\n\n`;
  md += `| Bias | Count | % |\n`;
  md += `|---|---|---|\n`;
  Object.entries(biasCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([bias, count]) => {
      md += `| ${bias} | ${count} | ${(count / totalCycles * 100).toFixed(1)}% |\n`;
    });
  md += `\n`;

  md += `## Gate Evaluation Summary\n\n`;
  md += `| Gate | Pass | Fail | Not Evaluated | Evaluated % |\n`;
  md += `|---|---|---|---|---|\n`;
  gateNames.forEach(g => {
    const total = gatePassCounts[g] + gateFailCounts[g] + gateNotEval[g];
    const evaluated = gatePassCounts[g] + gateFailCounts[g];
    const evalPct = total > 0 ? (evaluated / total * 100).toFixed(1) : '0';
    const passPct = evaluated > 0 ? (gatePassCounts[g] / evaluated * 100).toFixed(1) : '0';
    md += `| ${g} | ${gatePassCounts[g]} (${passPct}% of evaluated) | ${gateFailCounts[g]} | ${gateNotEval[g]} | ${evalPct}% |\n`;
  });
  md += `\n`;

  md += `## Trade Decision Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Total Trade Opened | ${totalTradesOpened} |\n`;
  md += `| Total Rejected | ${totalCycles - totalTradesOpened - cyclesNoPrice.length} |\n`;
  md += `| BUY Trades | ${tradesBySide.BUY || 0} |\n`;
  md += `| SELL Trades | ${tradesBySide.SELL || 0} |\n\n`;

  md += `## Rejection Reasons\n\n`;
  md += `| Reason | Count | % |\n`;
  md += `|---|---|---|\n`;
  Object.entries(rejectionReasons)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      md += `| ${reason} | ${count} | ${(count / (totalCycles - totalTradesOpened) * 100).toFixed(1)}% |\n`;
    });
  md += `\n`;

  if (totalTradesClosed > 0) {
    md += `## Trade Performance\n\n`;
    md += `| Metric | Value |\n`;
    md += `|---|---|\n`;
    md += `| Total Closed | ${totalTradesClosed} |\n`;
    md += `| Wins | ${wins} |\n`;
    md += `| Losses | ${losses} |\n`;
    md += `| Win Rate | ${winRate}% |\n`;
    md += `| Profit Factor | ${profitFactor} |\n`;
    md += `| Expectancy | ${expectancy} |\n`;
    md += `| Avg Win | $${avgWin} |\n`;
    md += `| Avg Loss | $${avgLoss} |\n`;
    md += `| Largest Win | $${largestWin} |\n`;
    md += `| Largest Loss | $${largestLoss} |\n`;
    md += `| Total PnL | $${totalPnL.toFixed(2)} |\n\n`;

    md += `## Trade Log\n\n`;
    md += `| # | Time | Side | Entry | Exit | SL | TP | Size | R:R | PnL |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|\n`;
    tradesClosed.forEach((t, i) => {
      md += `| ${i + 1} | ${t.closedAt || t.openedAt || t.timestamp} | ${t.side} | $${t.entry} | $${t.exit || '--'} | $${t.sl || '--'} | $${t.tp || '--'} | $${t.size} | ${t.rr || '--'} | $${(t.pnl || 0).toFixed(2)} |\n`;
    });
    md += `\n`;
  } else {
    md += `## Trade Performance\n\n`;
    md += `No trades were closed during the verification period.\n\n`;
  }

  md += `## Verification Checks\n\n`;
  const { checks, allPass } = evaluateChecks(cycles, trades, verificationState);

  md += `| Check | Status | Observed | Required | Detail |\n`;
  md += `|---|---|---|---|---|\n`;
  checks.forEach(c => {
    md += `| ${c.name} | ${c.pass ? '✅ PASS' : '❌ FAIL'} | ${c.observed ?? 'N/A'} | ${c.required ?? 'N/A'} | ${c.detail || ''} |\n`;
  });
  md += `\n**Overall:** ${allPass ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'}\n`;

  md += `\n---\n*Report generated by Atlas Pipeline Verification Script*\n`;

  return md;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Atlas Pipeline End-to-End Verification');
  console.log(`  Duration: ${REPORT_DURATION_MIN} min | Interval: ${REPORT_INTERVAL_SEC}s`);
  console.log('═══════════════════════════════════════════════\n');

  try {
    resolveVerifierApiKey();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // Check server is running
  try {
    const inspector = await fetchJSON('/api/signal/inspector');
    console.log(`✅ Server running — inspector available: ${inspector.available}`);
  } catch (e) {
    console.error('❌ Server not reachable. Start it with: node server.js');
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const startTime = Date.now();
  const cycles = [];
  const tradesById = new Map();
  const verificationMetrics = createVerificationMetrics({
    startTime,
    requestedDurationMs: DURATION_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  let errorCount = 0;
  const verificationState = {
    metrics: verificationMetrics,
    paperContractFailed: false,
    inspectorFailed: false,
    firstPaperFailure: null,
    firstInspectorFailure: null,
  };

  console.log(`\nRecording started at ${new Date(startTime).toISOString()}`);
  console.log(`Output: ${OUTPUT_FILE}\n`);

  const endTime = startTime + DURATION_MS;
  let lastProgressPrint = 0;

  while (Date.now() < endTime) {
    recordPollAttempt(verificationMetrics, Date.now());
    try {
      const [inspectorResult, paperTradesResult] = await Promise.allSettled([
        fetchJSON('/api/signal/inspector'),
        fetchJSON('/api/paper-trades')
      ]);

      const pollResult = processPollResults({
        inspectorResult,
        paperTradesResult,
        metrics: verificationMetrics,
        verificationState,
        cycles,
        tradesById,
        inspectorReceiptTimestamp: Date.now(),
        paperReceiptTimestamp: Date.now(),
      });
      if (pollResult.failed) throw new Error(pollResult.errors.join('; '));

      const elapsed = Date.now() - startTime;
      const elapsedMin = Math.floor(elapsed / 60000);
      if (elapsedMin > lastProgressPrint) {
        lastProgressPrint = elapsedMin;
        const pct = (elapsed / DURATION_MS * 100).toFixed(1);
        console.log(`[${new Date().toLocaleTimeString()}] ${pct}% | Cycles: ${cycles.length} | Trades: ${tradesById.size} | Errors: ${errorCount}`);
      }
    } catch (e) {
      errorCount++;
      if (errorCount <= 5) {
        console.error(`  ⚠ Poll error: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const actualEndTime = Date.now();
  finalizeVerificationMetrics(verificationMetrics, actualEndTime);
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Recording complete: ${formatTime(actualEndTime - startTime)}`);
  const trades = Array.from(tradesById.values());
  console.log(`  Cycles: ${cycles.length} | Trades: ${trades.length} | Errors: ${errorCount}`);
  console.log(`═══════════════════════════════════════════════\n`);

  // Save raw data
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    startTime,
    endTime: actualEndTime,
    cycles,
    trades,
    verification: serializeVerificationMetrics(verificationMetrics),
  }, null, 2));
  console.log(`Raw data saved: ${OUTPUT_FILE}`);

  // Generate and save report
  const report = generateReport(cycles, trades, startTime, actualEndTime, verificationState);
  fs.writeFileSync(REPORT_FILE, report);
  console.log(`Report saved: ${REPORT_FILE}\n`);

  // Print report to console
  console.log(report);

  const { allPass } = evaluateChecks(cycles, trades, verificationState);
  if (!allPass) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  createVerificationMetrics,
  evaluateChecks,
  evaluateGateCoverage,
  fetchJSON,
  buildCycleRecord,
  finalizeVerificationMetrics,
  generateReport,
  mergeTradeObservation,
  normalizeInspectorResponse,
  normalizePaperTradeResponse,
  normalizeTrade,
  processPollResults,
  recordInspectorResponse,
  recordPollAttempt,
  recordSuccessfulInspectorPoll,
  recordSuccessfulPaperPoll,
  recordSourceObservation,
  recordVerificationFailure,
  serializeVerificationMetrics,
};
