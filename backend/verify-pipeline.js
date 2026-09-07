#!/usr/bin/env node
/**
 * Atlas Pipeline End-to-End Verification Script
 * 
 * Runs the live pipeline for the configured observation window, records every evaluation cycle,
 * and generates a verification report.
 * 
 * Usage: node verify-pipeline.js [--duration <minutes>] [--interval <seconds>]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HTTP_TIMEOUT_MS = 5000;
const DEFAULT_DURATION_MIN = 10;
const MIN_DURATION_MIN = 10;
const MAX_DURATION_MIN = 1440;
const DEFAULT_POLL_INTERVAL_SEC = 3;
const MIN_POLL_INTERVAL_SEC = 1;
const MAX_POLL_INTERVAL_SEC = 30;
const EXPECTED_SOURCE_CADENCE_MS = 30000;
const MAX_SOURCE_STALL_MS = 90000;
const STARTUP_FIRST_SOURCE_DEADLINE_MS = 180000;
const MAX_ENDPOINT_OUTAGE_MS = 30000;
const MIN_POLL_COVERAGE_RATIO = 0.85;
const MIN_ENDPOINT_SUCCESS_RATIO = 0.90;
const POLL_SCHEDULING_TOLERANCE_MS = 5000;

const ARGS = parseArgs();
const DURATION_MIN = ARGS.duration ?? DEFAULT_DURATION_MIN;
const POLL_INTERVAL_SEC = ARGS.interval ?? DEFAULT_POLL_INTERVAL_SEC;
const TEST_MODE = process.env.NODE_ENV === 'test';
const DURATION_MS = TEST_MODE
  ? resolvePositiveIntegerOverride('ATLAS_VERIFY_DURATION_MS') ?? DURATION_MIN * 60 * 1000
  : DURATION_MIN * 60 * 1000;
const POLL_INTERVAL_MS = TEST_MODE
  ? resolvePositiveIntegerOverride('ATLAS_VERIFY_INTERVAL_MS') ?? POLL_INTERVAL_SEC * 1000
  : POLL_INTERVAL_SEC * 1000;
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

function parseArgs(argv = process.argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--duration') {
      args.duration = parseBoundedInteger(argv[i + 1], '--duration', MIN_DURATION_MIN, MAX_DURATION_MIN, 'whole minutes');
      i++;
    } else if (argv[i] === '--interval') {
      args.interval = parseBoundedInteger(argv[i + 1], '--interval', MIN_POLL_INTERVAL_SEC, MAX_POLL_INTERVAL_SEC, 'whole seconds');
      i++;
    } else {
      throw new Error(`Unknown or malformed verifier argument: ${argv[i]}`);
    }
  }
  return args;
}

function parseBoundedInteger(value, name, minimum, maximum, description) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a ${description} between ${minimum} and ${maximum}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a ${description} between ${minimum} and ${maximum}`);
  }

  return parsed;
}

function resolvePositiveIntegerOverride(name) {
  if (!Object.hasOwn(process.env, name)) return null;
  const value = process.env[name];
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(value);
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

function fetchJSON(urlPath, { allowHttpErrors = false } = {}) {
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
        if (!allowHttpErrors && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`HTTP ${res.statusCode} for ${urlPath}`));
          return;
        }
        try {
          const body = JSON.parse(data);
          resolve(allowHttpErrors ? { statusCode: res.statusCode, body } : body);
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
  'readinessEndpoint',
  'readinessContract',
  'statusEndpoint',
  'statusContract',
];

function createVerificationMetrics({ startTime, requestedDurationMs, pollIntervalMs, startMonotonicMs = startTime }) {
  const errors = {};
  VERIFICATION_ERROR_CATEGORIES.forEach(category => {
    errors[category] = { count: 0, firstMessage: null, firstTimestamp: null };
  });

  return {
    polling: {
      pollAttempts: 0,
      actualPollAttempts: 0,
      observationPollAttempts: 0,
      startupPollAttempts: 0,
      successfulInspectorPolls: 0,
      validInspectorResponses: 0,
      availableInspectorPolls: 0,
      unavailableInspectorPolls: 0,
      successfulPaperPolls: 0,
      expectedPollAttempts: pollIntervalMs > 0 ? Math.ceil(requestedDurationMs / pollIntervalMs) : 0,
      idealPollSlots: pollIntervalMs > 0 ? Math.floor(requestedDurationMs / pollIntervalMs) : 0,
      minimumPollAttempts: pollIntervalMs > 0
        ? Math.ceil(Math.floor(requestedDurationMs / pollIntervalMs) * MIN_POLL_COVERAGE_RATIO)
        : 0,
      maximumAcceptedPollLoopGapMs: pollIntervalMs + HTTP_TIMEOUT_MS + POLL_SCHEDULING_TOLERANCE_MS,
      pollingDriftMs: 0,
      maximumObservedPollLoopGapMs: 0,
      endpointStats: Object.fromEntries(['inspector', 'paper', 'readiness', 'status'].map(endpoint => [endpoint, {
        attempts: 0,
        successes: 0,
        failures: 0,
        successRatio: 0,
        maxConsecutiveFailureMs: 0,
        startupAttempts: 0,
        startupSuccesses: 0,
        startupFailures: 0,
      }])),
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
      sourceTimestampRegressions: 0,
      maximumObservedSourceStallMs: 0,
      finalSourceStallMs: null,
      expectedSourceCadenceMs: EXPECTED_SOURCE_CADENCE_MS,
      idealSourceSlots: Math.floor(requestedDurationMs / EXPECTED_SOURCE_CADENCE_MS),
      minimumRequiredSourceCycles: Math.max(
        2,
        Math.floor(Math.floor(requestedDurationMs / EXPECTED_SOURCE_CADENCE_MS) * MIN_ENDPOINT_SUCCESS_RATIO) - 2,
      ),
      maximumAcceptedSourceStallMs: MAX_SOURCE_STALL_MS,
      actualSourceCycles: 0,
      firstUniqueSourceObservedAt: null,
      lastUniqueSourceObservedAt: null,
    },
    runtime: {
      requestedDurationMs,
      actualElapsedMs: null,
      startupElapsedMs: null,
      observationDurationRequiredMs: requestedDurationMs,
      observationElapsedMs: null,
      totalElapsedMs: null,
      firstSourceObservedAt: null,
      runCompleted: false,
    },
    health: {
      readinessDrops: 0,
      durabilityFailures: 0,
      riskStateFailures: 0,
      riskSyncFailures: 0,
      pipelineFailures: 0,
      pipelineErrorBaseline: null,
      pipelineErrorFinal: null,
      sequenceRegressions: 0,
    },
    _startTime: startTime,
    _startMonotonicMs: startMonotonicMs,
    _pollIntervalMs: pollIntervalMs,
    _lastUniqueSourceObservedAt: null,
    _lastUniqueSourceObservedAtMonotonic: null,
    _lastSourceTimestampMs: null,
    _lastMutationSequence: null,
    _lastProcessUptime: null,
    _endpointFailureStartedAt: {},
  };
}

function recordPollAttempt(metrics, receiptTimestamp, phase = 'startup', monotonicTimestamp = receiptTimestamp) {
  const polling = metrics.polling;
  polling.pollAttempts++;
  if (phase === 'observation') polling.observationPollAttempts++;
  else polling.startupPollAttempts++;
  polling.actualPollAttempts = polling.observationPollAttempts;
  const plannedTimestamp = metrics._startTime + ((polling.pollAttempts - 1) * metrics._pollIntervalMs);
  polling.pollingDriftMs = Math.max(
    polling.pollingDriftMs,
    Math.max(0, receiptTimestamp - plannedTimestamp),
  );
  if (metrics._lastPollBatchStartMonotonicMs !== undefined) {
    const gap = monotonicTimestamp - metrics._lastPollBatchStartMonotonicMs;
    polling.maximumObservedPollLoopGapMs = Math.max(polling.maximumObservedPollLoopGapMs, gap);
  }
  metrics._lastPollBatchStartMonotonicMs = monotonicTimestamp;
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

function recordEndpointObservation(metrics, endpoint, success, monotonicTimestamp, phase) {
  const stats = metrics.polling.endpointStats[endpoint];
  if (!stats) throw new Error(`Unknown verification endpoint: ${endpoint}`);
  const observation = phase === 'observation';
  if (observation) {
    stats.attempts++;
    if (success) stats.successes++;
    else stats.failures++;
    stats.successRatio = stats.successes / stats.attempts;
  } else {
    stats.startupAttempts++;
    if (success) stats.startupSuccesses++;
    else stats.startupFailures++;
  }

  if (success) {
    const startedAt = metrics._endpointFailureStartedAt[endpoint];
    if (startedAt !== undefined) {
      stats.maxConsecutiveFailureMs = Math.max(stats.maxConsecutiveFailureMs, monotonicTimestamp - startedAt);
      delete metrics._endpointFailureStartedAt[endpoint];
    }
    return 0;
  }

  if (metrics._endpointFailureStartedAt[endpoint] === undefined) {
    metrics._endpointFailureStartedAt[endpoint] = monotonicTimestamp;
  }
  const outageMs = monotonicTimestamp - metrics._endpointFailureStartedAt[endpoint];
  stats.maxConsecutiveFailureMs = Math.max(stats.maxConsecutiveFailureMs, outageMs);
  return outageMs;
}

function validateReadinessResponse(response, statusCode = 200) {
  if (!isObject(response)
    || typeof response.status !== 'string'
    || typeof response.liveState !== 'string') {
    throw new Error('Invalid readiness response contract');
  }
  if (statusCode !== 200) return false;
  if (response.status !== 'ok' || response.liveState !== 'READY') return false;
  if (typeof response.durabilityHealthy !== 'boolean') throw new Error('Invalid readiness response contract');
  return response.durabilityHealthy === true;
}

function validateStatusResponse(response) {
  if (!isObject(response)
    || typeof response.liveStateReadiness !== 'string'
    || typeof response.durabilityHealthy !== 'boolean'
    || !isObject(response.pipeline)
    || !Number.isSafeInteger(response.pipeline.pipelineErrors)
    || response.pipeline.pipelineErrors < 0
    || typeof response.pipeline.riskSyncFailure !== 'boolean'
    || (response.pipeline.lastRunStatus !== null
      && (!isObject(response.pipeline.lastRunStatus) || typeof response.pipeline.lastRunStatus.status !== 'string'))
    || (response.mutationSequence !== null
      && (!Number.isSafeInteger(response.mutationSequence) || response.mutationSequence < 0))
    || typeof response.riskStateHealthy !== 'boolean'
    || !Number.isFinite(response.uptime)) {
    throw new Error('Invalid status response contract');
  }
  return response;
}

function hardCheckFailureCode(check) {
  const codes = {
    'Startup first source deadline': 'SOURCE_STARTUP_TIMEOUT',
    'Observation duration completed': 'OBSERVATION_DURATION_INCOMPLETE',
    'Minimum source cycles': 'SOURCE_CYCLE_COUNT',
    'Maximum source stall': 'SOURCE_STALL',
    'Minimum poll attempts': 'POLL_COVERAGE',
    'Maximum poll-loop gap': 'POLL_LOOP_STALL',
    'Source cycle continuity': 'SOURCE_CONTINUITY',
    'Inspector schema integrity': 'INSPECTOR_CONTRACT_INVALID',
    'Paper contract integrity': 'PAPER_CONTRACT_INVALID',
    'Readiness contract integrity': 'READINESS_CONTRACT_INVALID',
    'Status contract integrity': 'STATUS_CONTRACT_INVALID',
    'Readiness continuity': 'READINESS_UNSAFE',
    'Durability continuity': 'DURABILITY_UNHEALTHY',
    'Risk and pipeline health': 'PIPELINE_HEALTH_UNSAFE',
  };
  if (codes[check.name]) return codes[check.name];
  if (check.name.endsWith(' endpoint availability')) return 'ENDPOINT_SUCCESS_RATIO';
  return 'ACCEPTANCE_CHECK_FAILED';
}

function hardCheckFailureCode(check) {
  const codes = {
    'Startup first source deadline': 'SOURCE_STARTUP_TIMEOUT',
    'Observation duration completed': 'OBSERVATION_DURATION_INCOMPLETE',
    'Minimum source cycles': 'SOURCE_CYCLE_COUNT',
    'Maximum source stall': 'SOURCE_STALL',
    'Minimum poll attempts': 'POLL_COVERAGE',
    'Maximum poll-loop gap': 'POLL_LOOP_STALL',
    'Source cycle continuity': 'SOURCE_CONTINUITY',
    'Readiness continuity': 'READINESS_UNSAFE',
    'Durability continuity': 'DURABILITY_UNHEALTHY',
    'Risk and pipeline health': 'PIPELINE_HEALTH_UNSAFE',
  };
  if (codes[check.name]) return codes[check.name];
  if (check.name.endsWith(' endpoint availability')) return 'ENDPOINT_SUCCESS_RATIO';
  return 'ACCEPTANCE_CHECK_FAILED';
}

function processHealthResults({ readinessResult, statusResult, metrics, acceptance, phase, wallTimestamp, monotonicTimestamp }) {
  const endpointResults = [
    ['readiness', readinessResult],
    ['status', statusResult],
  ];
  for (const [endpoint, result] of endpointResults) {
    if (result.status === 'rejected') {
      const reason = result.reason;
      if (reason?.code === 'INVALID_JSON_RESPONSE') {
        recordEndpointObservation(metrics, endpoint, false, monotonicTimestamp, phase);
        recordVerificationFailure(metrics, `${endpoint}Contract`, reason.message, wallTimestamp);
        acceptance.fail(`${endpoint.toUpperCase()}_CONTRACT_INVALID`, reason.message, monotonicTimestamp);
        continue;
      }
      const outageMs = recordEndpointObservation(metrics, endpoint, false, monotonicTimestamp, phase);
      recordVerificationFailure(metrics, `${endpoint}Endpoint`, reason?.message || String(reason), wallTimestamp);
      if (outageMs > MAX_ENDPOINT_OUTAGE_MS) {
        acceptance.fail('ENDPOINT_OUTAGE_EXCEEDED', `${endpoint} endpoint outage exceeded ${MAX_ENDPOINT_OUTAGE_MS}ms`, monotonicTimestamp);
      }
      continue;
    }

    try {
      if (endpoint === 'readiness') {
        const readinessStatusCode = result.value?.statusCode ?? 200;
        const readinessBody = result.value?.body ?? result.value;
        const ready = validateReadinessResponse(readinessBody, readinessStatusCode);
        recordEndpointObservation(metrics, endpoint, ready, monotonicTimestamp, phase);
        if (!ready) {
          metrics.health.readinessDrops++;
          acceptance.fail('READINESS_DROP', 'Readiness response was not READY and durable', monotonicTimestamp);
        }
      } else {
        const status = validateStatusResponse(result.value?.body ?? result.value);
        const pipeline = status.pipeline;
        let statusHealthy = status.liveStateReadiness === 'READY'
          && status.durabilityHealthy === true
          && status.riskStateHealthy === true
          && pipeline.riskSyncFailure === false
          && pipeline.lastRunStatus?.status !== 'FAILED';
        if (metrics.health.pipelineErrorBaseline === null) {
          metrics.health.pipelineErrorBaseline = pipeline.pipelineErrors;
        } else if (pipeline.pipelineErrors > metrics.health.pipelineErrorBaseline) {
          metrics.health.pipelineFailures++;
          statusHealthy = false;
          acceptance.fail('PIPELINE_ERRORS_INCREASED', 'Pipeline error counter increased', monotonicTimestamp);
        } else if (pipeline.pipelineErrors < metrics.health.pipelineErrorBaseline) {
          metrics.health.sequenceRegressions++;
          statusHealthy = false;
          acceptance.fail('PIPELINE_ERRORS_REGRESSED', 'Pipeline error counter decreased', monotonicTimestamp);
        }
        metrics.health.pipelineErrorFinal = pipeline.pipelineErrors;

        if (status.liveStateReadiness !== 'READY') {
          metrics.health.readinessDrops++;
          statusHealthy = false;
          acceptance.fail('STATUS_READINESS_DROP', 'Status response was not READY', monotonicTimestamp);
        }
        if (status.durabilityHealthy !== true) {
          metrics.health.durabilityFailures++;
          statusHealthy = false;
          acceptance.fail('DURABILITY_UNHEALTHY', 'Durability health was false', monotonicTimestamp);
        }
        if (status.riskStateHealthy !== true) {
          metrics.health.riskStateFailures++;
          statusHealthy = false;
          acceptance.fail('RISK_STATE_UNHEALTHY', 'Risk state health was false', monotonicTimestamp);
        }
        if (pipeline.riskSyncFailure === true) {
          metrics.health.riskSyncFailures++;
          statusHealthy = false;
          acceptance.fail('RISK_SYNC_FAILURE', 'Risk synchronization failure latch was true', monotonicTimestamp);
        }
        if (pipeline.lastRunStatus?.status === 'FAILED') {
          metrics.health.pipelineFailures++;
          statusHealthy = false;
          acceptance.fail('PIPELINE_RUN_FAILED', 'Last pipeline run status was FAILED', monotonicTimestamp);
        }

        if (status.mutationSequence !== null) {
          if (metrics._lastMutationSequence !== null && status.mutationSequence < metrics._lastMutationSequence) {
            metrics.health.sequenceRegressions++;
            statusHealthy = false;
            acceptance.fail('MUTATION_SEQUENCE_REGRESSION', 'Mutation sequence decreased', monotonicTimestamp);
          }
          metrics._lastMutationSequence = status.mutationSequence;
        }
        if (metrics._lastProcessUptime !== null && status.uptime < metrics._lastProcessUptime) {
          metrics.health.sequenceRegressions++;
          statusHealthy = false;
          acceptance.fail('PROCESS_RESTART_DETECTED', 'Process uptime decreased', monotonicTimestamp);
        }
        metrics._lastProcessUptime = status.uptime;
        recordEndpointObservation(metrics, endpoint, statusHealthy, monotonicTimestamp, phase);
      }
    } catch (error) {
      recordEndpointObservation(metrics, endpoint, false, monotonicTimestamp, phase);
      acceptance.fail(`${endpoint.toUpperCase()}_CONTRACT_INVALID`, error.message, monotonicTimestamp);
      recordVerificationFailure(metrics, `${endpoint}Contract`, error.message, wallTimestamp);
    }
  }
}

function recordSuccessfulInspectorPoll(metrics) {
  metrics.polling.successfulInspectorPolls++;
}

function recordInspectorResponse(metrics, inspector, receiptTimestamp, receiptMonotonicTimestamp = receiptTimestamp) {
  metrics.polling.validInspectorResponses++;
  if (inspector.available) {
    metrics.polling.availableInspectorPolls++;
    return recordSourceObservation(metrics, inspector, receiptTimestamp, receiptMonotonicTimestamp);
  }
  metrics.polling.unavailableInspectorPolls++;
  return { type: 'unavailable' };
}

function recordSuccessfulPaperPoll(metrics) {
  metrics.polling.successfulPaperPolls++;
}

function recordSourceObservation(metrics, inspector, receiptTimestamp, receiptMonotonicTimestamp = receiptTimestamp) {
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

  const timestampMs = Date.parse(inspector.timestamp);
  if (source.lastSourceCycle !== null
    && Number.isFinite(timestampMs)
    && metrics._lastSourceTimestampMs !== null
    && timestampMs < metrics._lastSourceTimestampMs) {
    source.sourceTimestampRegressions = (source.sourceTimestampRegressions || 0) + 1;
    return { type: 'timestamp-regression', cycle, previousTimestamp: metrics._lastSourceTimestampMs, timestamp: timestampMs };
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
  source.actualSourceCycles = source.uniqueSourceCycles;
  if (source.firstSourceCycle === null) source.firstSourceCycle = cycle;
  source.lastSourceCycle = cycle;
  if (source.firstUniqueSourceObservedAt === null) {
    source.firstUniqueSourceObservedAt = receiptTimestamp;
  }
  if (metrics._lastUniqueSourceObservedAt !== null) {
    const stallMs = Math.max(0, receiptMonotonicTimestamp - metrics._lastUniqueSourceObservedAtMonotonic);
    source.maximumObservedSourceStallMs = Math.max(source.maximumObservedSourceStallMs, stallMs);
  }
  metrics._lastUniqueSourceObservedAt = receiptTimestamp;
  metrics._lastUniqueSourceObservedAtMonotonic = receiptMonotonicTimestamp;
  if (Number.isFinite(timestampMs)) metrics._lastSourceTimestampMs = timestampMs;
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

function monotonicNowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Number(process.hrtime.bigint()) / 1000000;
}

function createHardAcceptanceState({ metrics, startMonotonicMs, durationMs, pollIntervalMs }) {
  if (!metrics || typeof metrics !== 'object') throw new TypeError('metrics are required');
  if (!Number.isFinite(startMonotonicMs)) throw new TypeError('startMonotonicMs must be finite');

  const state = {
    phase: 'STARTING',
    failed: false,
    passed: false,
    failureReasons: [],
    startMonotonicMs,
    observationStartMonotonicMs: null,
    observationEndMonotonicMs: null,
    maximumAcceptedPollLoopGapMs: pollIntervalMs + HTTP_TIMEOUT_MS + POLL_SCHEDULING_TOLERANCE_MS,
  };

  metrics.hardAcceptance = state;

  function fail(code, detail, monotonicTimestamp = monotonicNowMs()) {
    if (state.failed || state.passed) return false;
    state.failed = true;
    state.phase = 'FAILED';
    state.failureReasons.push({ code, detail: detail || code, observedAtMonotonicMs: monotonicTimestamp });
    return true;
  }

  metrics._hardAcceptanceFail = fail;

  function observePollBatchStart(monotonicTimestamp, wallTimestamp) {
    if (state.failed || state.passed) return false;
    if (metrics._lastPollBatchStartMonotonicMs !== undefined) {
      const gap = monotonicTimestamp - metrics._lastPollBatchStartMonotonicMs;
      if (gap > state.maximumAcceptedPollLoopGapMs) {
        fail('POLL_LOOP_GAP_EXCEEDED', `Poll batch gap ${gap}ms exceeded ${state.maximumAcceptedPollLoopGapMs}ms`, monotonicTimestamp);
        return false;
      }
    }
    const phase = state.phase === 'OBSERVING' ? 'observation' : 'startup';
    recordPollAttempt(metrics, wallTimestamp, phase, monotonicTimestamp);
    return true;
  }

  function observeSource(inspector, wallTimestamp, monotonicTimestamp) {
    if (state.failed || state.passed) return { type: 'ignored' };
    const result = recordSourceObservation(metrics, inspector, wallTimestamp, monotonicTimestamp);
    if (result.type === 'regression') {
      fail('SOURCE_CYCLE_REGRESSION', `Cycle ${result.cycle} is below previous cycle ${result.previousCycle}`, monotonicTimestamp);
      return result;
    }
    if (result.type === 'timestamp-regression') {
      metrics.health.sequenceRegressions++;
      fail('SOURCE_TIMESTAMP_REGRESSION', 'Inspector timestamp regressed', monotonicTimestamp);
      return result;
    }
    if (result.type === 'unique' && state.phase === 'STARTING') {
      state.phase = 'OBSERVING';
      state.observationStartMonotonicMs = monotonicTimestamp;
      metrics.runtime.firstSourceObservedAt = wallTimestamp;
      metrics.runtime.startupElapsedMs = monotonicTimestamp - state.startMonotonicMs;
    }
    return result;
  }

  function acceptRecordedSource(result, wallTimestamp, monotonicTimestamp) {
    if (state.failed || state.passed || !result) return result;
    if (result.type === 'regression') {
      fail('SOURCE_CYCLE_REGRESSION', `Cycle ${result.cycle} is below previous cycle ${result.previousCycle}`, monotonicTimestamp);
    } else if (result.type === 'timestamp-regression') {
      metrics.health.sequenceRegressions++;
      fail('SOURCE_TIMESTAMP_REGRESSION', 'Inspector timestamp regressed', monotonicTimestamp);
    } else if (result.type === 'unique' && state.phase === 'STARTING') {
      state.phase = 'OBSERVING';
      state.observationStartMonotonicMs = monotonicTimestamp;
      metrics.runtime.firstSourceObservedAt = wallTimestamp;
      metrics.runtime.startupElapsedMs = monotonicTimestamp - state.startMonotonicMs;
    }
    return result;
  }

  function checkProgress(monotonicTimestamp) {
    if (state.failed || state.passed) return false;
    for (const [endpoint, startedAt] of Object.entries(metrics._endpointFailureStartedAt)) {
      if (monotonicTimestamp - startedAt > MAX_ENDPOINT_OUTAGE_MS) {
        fail('ENDPOINT_OUTAGE_EXCEEDED', `${endpoint} endpoint outage exceeded ${MAX_ENDPOINT_OUTAGE_MS}ms`, monotonicTimestamp);
        return false;
      }
    }
    if (state.phase === 'STARTING') {
      if (monotonicTimestamp - state.startMonotonicMs > STARTUP_FIRST_SOURCE_DEADLINE_MS) {
        fail('FIRST_SOURCE_DEADLINE_EXCEEDED', 'No valid unique source cycle appeared before the startup deadline', monotonicTimestamp);
      }
      return !state.failed;
    }

    const source = metrics.source;
    if (metrics._lastUniqueSourceObservedAtMonotonic !== null
      && monotonicTimestamp - metrics._lastUniqueSourceObservedAtMonotonic > MAX_SOURCE_STALL_MS) {
      fail('SOURCE_STALL_EXCEEDED', `Source gap exceeded ${MAX_SOURCE_STALL_MS}ms`, monotonicTimestamp);
      return false;
    }

    if (monotonicTimestamp - state.observationStartMonotonicMs >= durationMs) {
      state.observationEndMonotonicMs = state.observationStartMonotonicMs + durationMs;
    }
    return !state.failed;
  }

  function complete(monotonicTimestamp, wallTimestamp) {
    if (state.failed || state.passed) return state;
    checkProgress(monotonicTimestamp);
    if (state.failed) return state;
    if (state.phase !== 'OBSERVING' || state.observationEndMonotonicMs === null) {
      fail('OBSERVATION_INCOMPLETE', 'The full observation window did not complete', monotonicTimestamp);
      return state;
    }

    metrics.runtime.observationElapsedMs = Math.max(0, monotonicTimestamp - state.observationStartMonotonicMs);
    metrics.runtime.totalElapsedMs = Math.max(0, monotonicTimestamp - state.startMonotonicMs);
    metrics.runtime.actualElapsedMs = metrics.runtime.observationElapsedMs;
    metrics.runtime.runCompleted = metrics.runtime.observationElapsedMs >= durationMs;
    if (metrics._lastUniqueSourceObservedAtMonotonic !== null) {
      metrics.source.finalSourceStallMs = Math.max(0, monotonicTimestamp - metrics._lastUniqueSourceObservedAtMonotonic);
    }
    for (const [endpoint, startedAt] of Object.entries(metrics._endpointFailureStartedAt)) {
      metrics.polling.endpointStats[endpoint].maxConsecutiveFailureMs = Math.max(
        metrics.polling.endpointStats[endpoint].maxConsecutiveFailureMs,
        monotonicTimestamp - startedAt,
      );
    }
    if (metrics.source.finalSourceStallMs !== null && metrics.source.finalSourceStallMs > MAX_SOURCE_STALL_MS) {
      fail('FINAL_SOURCE_STALL_EXCEEDED', `Final source gap exceeded ${MAX_SOURCE_STALL_MS}ms`, monotonicTimestamp);
    }
    if (metrics.source.uniqueSourceCycles < metrics.source.minimumRequiredSourceCycles) {
      fail('INSUFFICIENT_SOURCE_CYCLES', `Observed ${metrics.source.uniqueSourceCycles}; required ${metrics.source.minimumRequiredSourceCycles}`, monotonicTimestamp);
    }
    return state;
  }

  return Object.freeze({
    fail,
    observePollBatchStart,
    observeSource,
    acceptRecordedSource,
    checkProgress,
    complete,
    getState: () => ({
      phase: state.phase,
      failed: state.failed,
      passed: state.passed,
      failureReasons: state.failureReasons.map(reason => ({ ...reason })),
      startMonotonicMs: state.startMonotonicMs,
      observationStartMonotonicMs: state.observationStartMonotonicMs,
      observationEndMonotonicMs: state.observationEndMonotonicMs,
      maximumAcceptedPollLoopGapMs: state.maximumAcceptedPollLoopGapMs,
    }),
  });
}

function calculateHardAcceptanceChecks(cycles, verificationState = {}) {
  const metrics = getVerificationMetrics(verificationState);
  const hardAcceptance = metrics?.hardAcceptance;
  if (!metrics || !hardAcceptance) {
    return { checks: [], allPass: false };
  }

  const endpointStats = metrics.polling.endpointStats;
  const endpointChecks = Object.entries(endpointStats).map(([endpoint, stats]) => ({
    id: `ENDPOINT_${endpoint.toUpperCase()}_SUCCESS_RATIO`,
    name: `${endpoint} endpoint availability`,
    pass: stats.attempts > 0
      && stats.successes >= Math.ceil(stats.attempts * MIN_ENDPOINT_SUCCESS_RATIO),
    observed: stats.successes,
    required: `>= ceil(${stats.attempts} * ${MIN_ENDPOINT_SUCCESS_RATIO})`,
    detail: `success ratio ${(stats.successes / Math.max(1, stats.attempts)).toFixed(3)}`,
  }));
  const checks = [
    {
      id: 'SOURCE_STARTUP_TIMEOUT',
      name: 'Startup first source deadline',
      pass: hardAcceptance.phase !== 'STARTING' && !hardAcceptance.failureReasons.some(reason => reason.code === 'FIRST_SOURCE_DEADLINE_EXCEEDED'),
      observed: metrics.runtime.startupElapsedMs ?? 'not observed',
      required: `<= ${STARTUP_FIRST_SOURCE_DEADLINE_MS}ms`,
    },
    {
      id: 'OBSERVATION_DURATION',
      name: 'Observation duration completed',
      pass: metrics.runtime.runCompleted,
      observed: metrics.runtime.observationElapsedMs ?? 'not completed',
      required: `>= ${metrics.runtime.observationDurationRequiredMs}ms`,
    },
    {
      id: 'INSPECTOR_SCHEMA',
      name: 'Inspector schema integrity',
      pass: metrics.errors.inspectorContract.count === 0,
      observed: metrics.errors.inspectorContract.count,
      required: '0 contract errors',
    },
    {
      id: 'PAPER_SCHEMA',
      name: 'Paper contract integrity',
      pass: metrics.errors.paperContract.count === 0,
      observed: metrics.errors.paperContract.count,
      required: '0 contract errors',
    },
    {
      id: 'READINESS_SCHEMA',
      name: 'Readiness contract integrity',
      pass: metrics.errors.readinessContract.count === 0,
      observed: metrics.errors.readinessContract.count,
      required: '0 contract errors',
    },
    {
      id: 'STATUS_SCHEMA',
      name: 'Status contract integrity',
      pass: metrics.errors.statusContract.count === 0,
      observed: metrics.errors.statusContract.count,
      required: '0 contract errors',
    },
    {
      id: 'SOURCE_PROGRESS',
      name: 'Source cycle progressed',
      pass: metrics.source.uniqueSourceCycles >= metrics.source.minimumRequiredSourceCycles
        && metrics.source.lastSourceCycle > metrics.source.firstSourceCycle,
      observed: metrics.source.uniqueSourceCycles,
      required: `>= ${metrics.source.minimumRequiredSourceCycles} strictly increasing unique cycles`,
      detail: metrics.source.uniqueSourceCycles === 0
        ? 'No unique available source cycles observed'
        : metrics.source.uniqueSourceCycles === 1
          ? 'Inconclusive: one unique source cycle is insufficient to prove progress'
        : `Observed ${metrics.source.uniqueSourceCycles} unique source cycles from ${metrics.source.firstSourceCycle} to ${metrics.source.lastSourceCycle}`,
    },
    {
      id: 'SOURCE_CYCLE_COUNT',
      name: 'Minimum source cycles',
      pass: metrics.source.uniqueSourceCycles >= metrics.source.minimumRequiredSourceCycles,
      observed: metrics.source.uniqueSourceCycles,
      required: `>= ${metrics.source.minimumRequiredSourceCycles}`,
    },
    {
      id: 'SOURCE_STALL',
      name: 'Maximum source stall',
      pass: metrics.source.maximumObservedSourceStallMs <= MAX_SOURCE_STALL_MS
        && (metrics.source.finalSourceStallMs === null || metrics.source.finalSourceStallMs <= MAX_SOURCE_STALL_MS),
      observed: Math.max(metrics.source.maximumObservedSourceStallMs, metrics.source.finalSourceStallMs || 0),
      required: `<= ${MAX_SOURCE_STALL_MS}ms`,
    },
    {
      id: 'POLL_COVERAGE',
      name: 'Minimum poll attempts',
      pass: metrics.polling.observationPollAttempts >= metrics.polling.minimumPollAttempts,
      observed: metrics.polling.observationPollAttempts,
      required: `>= ${metrics.polling.minimumPollAttempts}`,
    },
    {
      id: 'POLL_LOOP_STALL',
      name: 'Maximum poll-loop gap',
      pass: metrics.polling.maximumObservedPollLoopGapMs <= hardAcceptance.maximumAcceptedPollLoopGapMs,
      observed: metrics.polling.maximumObservedPollLoopGapMs,
      required: `<= ${hardAcceptance.maximumAcceptedPollLoopGapMs}ms`,
    },
    {
      id: 'SOURCE_CONTINUITY',
      name: 'Source cycle continuity',
      pass: metrics.source.sourceCycleRegressions === 0 && (metrics.source.sourceTimestampRegressions || 0) === 0,
      observed: metrics.source.sourceCycleRegressions + (metrics.source.sourceTimestampRegressions || 0),
      required: '0 cycle or timestamp regressions',
    },
    {
      id: 'READINESS_UNSAFE',
      name: 'Readiness continuity',
      pass: metrics.health.readinessDrops === 0,
      observed: metrics.health.readinessDrops,
      required: '0 readiness drops',
    },
    {
      id: 'DURABILITY_UNHEALTHY',
      name: 'Durability continuity',
      pass: metrics.health.durabilityFailures === 0,
      observed: metrics.health.durabilityFailures,
      required: '0 durability failures',
    },
    {
      id: 'PIPELINE_HEALTH_UNSAFE',
      name: 'Risk and pipeline health',
      pass: metrics.health.riskStateFailures === 0
        && metrics.health.riskSyncFailures === 0
        && metrics.health.pipelineFailures === 0,
      observed: metrics.health.riskStateFailures + metrics.health.riskSyncFailures + metrics.health.pipelineFailures,
      required: '0 health failures',
    },
    ...endpointChecks,
  ];
  const failedCheck = checks.find(check => !check.pass);
  if (failedCheck && !hardAcceptance.failed && !hardAcceptance.passed) {
    metrics._hardAcceptanceFail(hardCheckFailureCode(failedCheck), failedCheck.name);
  }
  const allPass = !hardAcceptance.failed && checks.every(check => check.pass);
  const failureReasons = hardAcceptance.failureReasons.map(reason => ({ ...reason }));
  return { checks, allPass, failureReasons };
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
    health: { ...metrics.health },
    ...(metrics.acceptance ? {
      acceptance: {
        ...metrics.acceptance,
        criteria: { ...metrics.acceptance.criteria },
        failureReasons: metrics.acceptance.failureReasons.map(reason => ({ ...reason })),
        checks: metrics.acceptance.checks.map(check => ({ ...check })),
      },
    } : {}),
  };
}

function buildAcceptanceReport(metrics, evaluation) {
  const hardAcceptance = metrics.hardAcceptance;
  if (!evaluation.allPass && !hardAcceptance.failed && !hardAcceptance.passed) {
    metrics._hardAcceptanceFail('ACCEPTANCE_CHECK_FAILED', evaluation.checks.find(check => !check.pass)?.name || 'Acceptance check failed');
  }
  const passed = evaluation.allPass && !hardAcceptance.failed;
  if (passed) {
    hardAcceptance.passed = true;
    hardAcceptance.phase = 'PASSED';
  } else {
    hardAcceptance.passed = false;
    hardAcceptance.phase = 'FAILED';
  }
  const failureReasons = hardAcceptance.failureReasons.map(reason => ({ ...reason }));
  evaluation.checks.filter(check => !check.pass).forEach(check => {
    if (!failureReasons.some(reason => reason.detail === check.name)) {
      failureReasons.push({ code: 'CHECK_FAILED', detail: check.name, observedAtMonotonicMs: null });
    }
  });
  return {
    passed,
    state: passed ? 'PASSED' : 'FAILED',
    failureReasons,
    criteria: {
      observationDurationRequiredMs: metrics.runtime.observationDurationRequiredMs,
      expectedSourceCadenceMs: EXPECTED_SOURCE_CADENCE_MS,
      idealSourceSlots: metrics.source.idealSourceSlots,
      minimumRequiredSourceCycles: metrics.source.minimumRequiredSourceCycles,
      maximumAcceptedSourceStallMs: MAX_SOURCE_STALL_MS,
      startupFirstSourceDeadlineMs: STARTUP_FIRST_SOURCE_DEADLINE_MS,
      maximumEndpointOutageMs: MAX_ENDPOINT_OUTAGE_MS,
      minimumPollCoverageRatio: MIN_POLL_COVERAGE_RATIO,
      idealPollSlots: metrics.polling.idealPollSlots,
      minimumPollAttempts: metrics.polling.minimumPollAttempts,
      minimumEndpointSuccessRatio: MIN_ENDPOINT_SUCCESS_RATIO,
      maximumAcceptedPollLoopGapMs: hardAcceptance.maximumAcceptedPollLoopGapMs,
    },
    checks: evaluation.checks,
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
  inspectorReceiptMonotonicTimestamp = inspectorReceiptTimestamp,
  paperReceiptMonotonicTimestamp = paperReceiptTimestamp,
}) {
  const errors = [];
  let inspectorValid = false;
  let paperValid = false;
  let inspectorContractFailed = false;
  let paperContractFailed = false;
  let sourceObservation = null;
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
    if (isParseFailure) {
      if (stateKey === 'inspectorFailed') inspectorContractFailed = true;
      if (stateKey === 'paperContractFailed') paperContractFailed = true;
    }
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
        inspectorValid = true;
      } else {
        const coverage = evaluateGateCoverage(inspector);
        if (!coverage.valid) throw inspectorError(`gate coverage failed: ${coverage.errors.join('; ')}`);

        sourceObservation = recordInspectorResponse(metrics, inspector, inspectorReceiptTimestamp, inspectorReceiptMonotonicTimestamp);
        inspectorValid = sourceObservation.type !== 'regression'
          && sourceObservation.type !== 'timestamp-regression';
        if (sourceObservation.type === 'unique') {
          cycles.push(buildCycleRecord(inspector));
        }
      }
    } catch (e) {
      inspectorContractFailed = true;
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
      paperValid = true;
      normalizedPaperTrades.open.forEach(trade => mergeTradeObservation(tradesById, trade));
      normalizedPaperTrades.closed.forEach(trade => mergeTradeObservation(tradesById, trade));
      recordSuccessfulPaperPoll(metrics);
    } catch (e) {
      paperContractFailed = true;
      verificationState.paperContractFailed = true;
      verificationState.firstPaperFailure = verificationState.firstPaperFailure || e.message;
      recordVerificationFailure(metrics, 'paperContract', e.message, paperReceiptTimestamp);
      errors.push(e.message);
    }
  }

  return {
    failed: errors.length > 0,
    errors,
    inspectorValid,
    paperValid,
    inspectorContractFailed,
    paperContractFailed,
    sourceObservation,
  };
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
  if (!metrics?.hardAcceptance && metrics?.acceptance) {
    return {
      checks: metrics.acceptance.checks.map(check => ({ ...check })),
      allPass: metrics.acceptance.passed === true && metrics.acceptance.state === 'PASSED',
    };
  }
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
    ? source.uniqueSourceCycles >= (metrics?.hardAcceptance
      ? source.minimumRequiredSourceCycles
      : 2) && source.lastSourceCycle > source.firstSourceCycle
    : totalCycles > 0;
  const sourceProgressDetail = source
    ? source.uniqueSourceCycles === 0
      ? 'No unique available source cycles observed'
      : source.uniqueSourceCycles === 1
        ? 'Inconclusive: one unique source cycle is insufficient to prove progress'
        : `Observed ${source.uniqueSourceCycles} unique source cycles from ${source.firstSourceCycle} to ${source.lastSourceCycle}`
    : 'Source telemetry was not provided to this direct helper call';
  const endpointPass = category => metrics?.hardAcceptance
    ? (() => {
      const endpoint = category === 'inspectorEndpoint' ? 'inspector' : 'paper';
      const stats = metrics.polling.endpointStats[endpoint];
      return stats.attempts > 0 && stats.successes >= Math.ceil(stats.attempts * MIN_ENDPOINT_SUCCESS_RATIO);
    })()
    : errors
      ? errors[category].count === 0
    : category === 'inspectorEndpoint' ? !verificationState.inspectorFailed : !verificationState.paperContractFailed;
  const schemaPass = category => errors
    ? errors[category].count === 0
    : category === 'inspectorContract' ? !verificationState.inspectorFailed : !verificationState.paperContractFailed;
  const runtimePass = runtime ? runtime.runCompleted : !metrics?.hardAcceptance;
  const checks = [
    { name: 'Pipeline running (cycles > 0)', pass: totalCycles > 0, observed: totalCycles, required: '> 0' },
    { name: 'Price data available', pass: cyclesWithPrice.length > 0, observed: cyclesWithPrice.length, required: '> 0' },
    { name: 'Confluence scores computed', pass: confluenceScores.length > 0, observed: confluenceScores.length, required: '> 0' },
    { name: 'Gate coverage contract', pass: gateCoverage.every(result => result.valid), observed: gateCoverage.filter(result => result.valid).length, required: `${gateCoverage.length} valid cycles` },
    { name: 'Bias distribution valid (no Unknown)', pass: !biasCounts.Unknown, observed: biasCounts.Unknown || 0, required: '0 Unknown cycles' },
    { name: 'Rejection reasons recorded', pass: Object.keys(rejectionReasons).length > 0, observed: Object.keys(rejectionReasons).length, required: '> 0 reasons' },
  ];

  if (metrics?.hardAcceptance) {
    const hardEvaluation = calculateHardAcceptanceChecks(cycles, verificationState);
    checks.push(...hardEvaluation.checks);
    return {
      checks,
      allPass: hardEvaluation.allPass && checks.every(check => check.pass),
    };
  }

  checks.push(
    { name: 'Observation duration completed', pass: runtimePass, observed: runtime?.observationElapsedMs ?? runtime?.actualElapsedMs ?? 'not measured', required: runtime ? `>= ${runtime.observationDurationRequiredMs ?? runtime.requestedDurationMs}ms` : 'run telemetry' },
    { name: 'Inspector endpoint integrity', pass: endpointPass('inspectorEndpoint'), observed: errors?.inspectorEndpoint.count ?? (verificationState.inspectorFailed ? 1 : 0), required: '0 endpoint errors' },
    { name: 'Inspector schema integrity', pass: schemaPass('inspectorContract'), observed: errors?.inspectorContract.count ?? (verificationState.inspectorFailed ? 1 : 0), required: '0 contract errors' },
    { name: 'Paper endpoint integrity', pass: endpointPass('paperEndpoint'), observed: errors?.paperEndpoint.count ?? 0, required: '0 endpoint errors' },
    { name: 'Paper contract integrity', pass: schemaPass('paperContract'), observed: errors?.paperContract.count ?? (verificationState.paperContractFailed ? 1 : 0), required: '0 contract errors' },
    { name: 'Source cycle progressed', pass: sourceProgress, observed: source?.uniqueSourceCycles ?? totalCycles, required: 'at least 2 strictly increasing unique cycles', detail: sourceProgressDetail },
    { name: 'Source cycle continuity', pass: source ? source.sourceCycleRegressions === 0 && (source.sourceTimestampRegressions || 0) === 0 : true, observed: (source?.sourceCycleRegressions ?? 0) + (source?.sourceTimestampRegressions || 0), required: '0 cycle or timestamp regressions' },
  );
  return { checks, allPass: checks.every(c => c.pass) };
}

function generateReport(cycles, trades, startTime, endTime, verificationState = {}) {
  const totalCycles = cycles.length;
  const durationMs = endTime - startTime;
  const metrics = getVerificationMetrics(verificationState);
  const observationDurationMs = metrics?.runtime?.observationElapsedMs ?? durationMs;
  const totalDurationMs = metrics?.runtime?.totalElapsedMs ?? durationMs;
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
  md += `**Observation Duration:** ${formatTime(observationDurationMs)} (${REPORT_DURATION_MIN} min target)\n`;
  md += `**Poll Interval:** ${REPORT_INTERVAL_SEC}s\n`;
  md += `**Symbol:** BTC/USDT\n\n`;
  md += `Source stalls, poll-loop gaps, endpoint availability, readiness, durability, and pipeline health are hard acceptance criteria. Missing intermediate cycle IDs and polling drift remain diagnostic.\n\n`;

  md += `## Verification Run Metrics\n\n`;
  if (serializedMetrics) {
    md += `| Metric | Value |\n|---|---|\n`;
     md += `| Startup Elapsed | ${serializedMetrics.runtime.startupElapsedMs ?? 'not observed'}ms |\n`;
     md += `| First Source Observed At | ${serializedMetrics.runtime.firstSourceObservedAt ? new Date(serializedMetrics.runtime.firstSourceObservedAt).toISOString() : 'not observed'} |\n`;
     md += `| Observation Duration Required | ${serializedMetrics.runtime.observationDurationRequiredMs}ms |\n`;
     md += `| Observation Elapsed | ${serializedMetrics.runtime.observationElapsedMs ?? 'not finalized'}ms |\n`;
     md += `| Total Elapsed | ${serializedMetrics.runtime.totalElapsedMs ?? 'not finalized'}ms |\n`;
     md += `| Run Completed | ${serializedMetrics.runtime.runCompleted} |\n`;
     md += `| Startup Poll Attempts | ${serializedMetrics.polling.startupPollAttempts} |\n`;
     md += `| Observation Poll Attempts | ${serializedMetrics.polling.observationPollAttempts} |\n`;
     md += `| Actual Poll Attempts | ${serializedMetrics.polling.actualPollAttempts} |\n`;
     md += `| Ideal Poll Slots | ${serializedMetrics.polling.idealPollSlots} |\n`;
     md += `| Minimum Poll Attempts | ${serializedMetrics.polling.minimumPollAttempts} |\n`;
     md += `| Maximum Poll-Loop Gap | ${serializedMetrics.polling.maximumObservedPollLoopGapMs}ms / ${serializedMetrics.acceptance?.criteria.maximumAcceptedPollLoopGapMs ?? 'N/A'}ms |\n`;
     md += `| Polling Drift (diagnostic) | ${serializedMetrics.polling.pollingDriftMs}ms |\n\n`;
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
     md += `| Endpoint | Attempts | Successes | Failures | Success Ratio | Max Consecutive Failure |\n|---|---:|---:|---:|---:|---:|\n`;
     Object.entries(serializedMetrics.polling.endpointStats).forEach(([endpoint, stats]) => {
       md += `| ${endpoint} | ${stats.attempts} | ${stats.successes} | ${stats.failures} | ${(stats.successRatio ?? 0).toFixed(3)} | ${stats.maxConsecutiveFailureMs}ms |\n`;
     });
     md += `\n`;
  } else {
    md += `Telemetry was not provided to this direct report call.\n\n`;
  }

  md += `## Source Progress and Continuity\n\n`;
  if (serializedMetrics) {
    md += `| Metric | Value |\n|---|---|\n`;
     md += `| Unique Source Cycles | ${serializedMetrics.source.uniqueSourceCycles} |\n`;
     md += `| Actual Source Cycles | ${serializedMetrics.source.actualSourceCycles} |\n`;
    md += `| Duplicate Source Observations | ${serializedMetrics.source.duplicateSourceObservations} |\n`;
    md += `| First Source Cycle | ${serializedMetrics.source.firstSourceCycle ?? 'N/A'} |\n`;
    md += `| Last Source Cycle | ${serializedMetrics.source.lastSourceCycle ?? 'N/A'} |\n`;
     md += `| Expected Source Cadence | ${serializedMetrics.source.expectedSourceCadenceMs}ms |\n`;
     md += `| Ideal Source Slots | ${serializedMetrics.source.idealSourceSlots} |\n`;
     md += `| Minimum Required Source Cycles | ${serializedMetrics.source.minimumRequiredSourceCycles} |\n`;
     md += `| Missing Source Cycle Count (diagnostic) | ${serializedMetrics.source.missingSourceCycleCount} |\n`;
     md += `| Missing Source Cycle Ranges (diagnostic) | ${JSON.stringify(serializedMetrics.source.missingSourceCycleRanges)} |\n`;
     md += `| Source Cycle Regressions | ${serializedMetrics.source.sourceCycleRegressions} |\n`;
     md += `| Maximum Accepted Source Stall | ${serializedMetrics.source.maximumAcceptedSourceStallMs}ms |\n`;
     md += `| Maximum Observed Source Stall | ${serializedMetrics.source.maximumObservedSourceStallMs}ms |\n`;
     md += `| Final Source Stall | ${serializedMetrics.source.finalSourceStallMs ?? 'N/A'}ms |\n\n`;
  } else {
    md += `Telemetry was not provided to this direct report call.\n\n`;
  }

  md += `## Runtime Health\n\n`;
  if (serializedMetrics) {
    md += `| Metric | Value |\n|---|---|\n`;
    Object.entries(serializedMetrics.health || {}).forEach(([name, value]) => {
      md += `| ${name} | ${typeof value === 'object' ? JSON.stringify(value) : value} |\n`;
    });
    md += `\n`;
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
   md += `| Observation Duration | ${formatTime(observationDurationMs)} |\n`;
   md += `| Total Duration | ${formatTime(totalDurationMs)} |\n\n`;

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
  const evaluation = serializedMetrics?.acceptance
    ? {
      checks: serializedMetrics.acceptance.checks,
      allPass: serializedMetrics.acceptance.passed === true
        && serializedMetrics.acceptance.state === 'PASSED',
    }
    : evaluateChecks(cycles, trades, verificationState);
  const { checks, allPass } = evaluation;

  if (serializedMetrics?.acceptance) {
    md += `**Acceptance State:** ${serializedMetrics.acceptance.state}\n`;
    md += `**Acceptance Passed:** ${serializedMetrics.acceptance.passed}\n`;
    if (serializedMetrics.acceptance.failureReasons.length > 0) {
      md += `**Failure Reasons:** ${JSON.stringify(serializedMetrics.acceptance.failureReasons)}\n`;
    }
    md += `\n`;
  }

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

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const startTime = Date.now();
  const startMonotonicMs = monotonicNowMs();
  const cycles = [];
  const tradesById = new Map();
  const verificationMetrics = createVerificationMetrics({
    startTime,
    requestedDurationMs: DURATION_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    startMonotonicMs,
  });
  const acceptance = createHardAcceptanceState({
    metrics: verificationMetrics,
    startMonotonicMs,
    durationMs: DURATION_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  const verificationState = {
    metrics: verificationMetrics,
    hardAcceptance: acceptance,
    paperContractFailed: false,
    inspectorFailed: false,
    firstPaperFailure: null,
    firstInspectorFailure: null,
  };

  console.log(`\nRecording started at ${new Date(startTime).toISOString()}`);
  console.log(`Output: ${OUTPUT_FILE}\n`);

  let lastProgressPrint = 0;
  while (!acceptance.getState().failed) {
    const beforePoll = monotonicNowMs();
    if (!acceptance.checkProgress(beforePoll)) break;
    const phase = acceptance.getState().phase === 'OBSERVING' ? 'observation' : 'startup';
    if (phase === 'OBSERVING'
      && beforePoll - acceptance.getState().observationStartMonotonicMs >= DURATION_MS) break;
    if (!acceptance.observePollBatchStart(beforePoll, Date.now())) break;

    const [inspectorResult, paperTradesResult, readinessResult, statusResult] = await Promise.allSettled([
      fetchJSON('/api/signal/inspector'),
      fetchJSON('/api/paper-trades'),
      fetchJSON('/readyz', { allowHttpErrors: true }),
      fetchJSON('/api/status'),
    ]);
    const receiptTimestamp = Date.now();
    const receiptMonotonicTimestamp = monotonicNowMs();
    const pollResult = processPollResults({
      inspectorResult,
      paperTradesResult,
      metrics: verificationMetrics,
      verificationState,
      cycles,
      tradesById,
      inspectorReceiptTimestamp: receiptTimestamp,
      paperReceiptTimestamp: receiptTimestamp,
      inspectorReceiptMonotonicTimestamp: receiptMonotonicTimestamp,
      paperReceiptMonotonicTimestamp: receiptMonotonicTimestamp,
    });

    const inspectorOutage = recordEndpointObservation(
      verificationMetrics,
      'inspector',
      pollResult.inspectorValid,
      receiptMonotonicTimestamp,
      phase,
    );
    const paperOutage = recordEndpointObservation(
      verificationMetrics,
      'paper',
      pollResult.paperValid,
      receiptMonotonicTimestamp,
      phase,
    );
    if (pollResult.inspectorContractFailed) {
      acceptance.fail('INSPECTOR_CONTRACT_INVALID', 'Inspector response contract failed', receiptMonotonicTimestamp);
    }
    if (pollResult.paperContractFailed) {
      acceptance.fail('PAPER_CONTRACT_INVALID', 'Paper response contract failed', receiptMonotonicTimestamp);
    }
    if (inspectorOutage > MAX_ENDPOINT_OUTAGE_MS || paperOutage > MAX_ENDPOINT_OUTAGE_MS) {
      acceptance.fail('ENDPOINT_OUTAGE_EXCEEDED', 'Inspector or paper endpoint outage exceeded the allowed budget', receiptMonotonicTimestamp);
    }

    processHealthResults({
      readinessResult,
      statusResult,
      metrics: verificationMetrics,
      acceptance,
      phase,
      wallTimestamp: receiptTimestamp,
      monotonicTimestamp: receiptMonotonicTimestamp,
    });

    if (!acceptance.checkProgress(receiptMonotonicTimestamp)) break;
    acceptance.acceptRecordedSource(pollResult.sourceObservation, receiptTimestamp, receiptMonotonicTimestamp);
    if (!acceptance.checkProgress(receiptMonotonicTimestamp)) break;

    const elapsed = receiptMonotonicTimestamp - startMonotonicMs;
    const elapsedMin = Math.floor(elapsed / 60000);
    if (elapsedMin > lastProgressPrint) {
      lastProgressPrint = elapsedMin;
      const pct = acceptance.getState().phase === 'OBSERVING'
        ? ((receiptMonotonicTimestamp - acceptance.getState().observationStartMonotonicMs) / DURATION_MS * 100).toFixed(1)
        : '0.0';
      console.log(`[${new Date(receiptTimestamp).toLocaleTimeString()}] ${pct}% | Phase: ${acceptance.getState().phase} | Cycles: ${cycles.length} | Trades: ${tradesById.size}`);
    }

    const current = acceptance.getState();
    if (!current.failed && current.phase === 'OBSERVING'
      && receiptMonotonicTimestamp - current.observationStartMonotonicMs >= DURATION_MS) break;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const actualEndTime = Date.now();
  const actualEndMonotonicMs = monotonicNowMs();
  acceptance.complete(actualEndMonotonicMs, actualEndTime);
  const runtime = verificationMetrics.runtime;
  runtime.totalElapsedMs = Math.max(0, actualEndMonotonicMs - startMonotonicMs);
  if (acceptance.getState().observationStartMonotonicMs !== null) {
    runtime.observationElapsedMs = Math.max(0, actualEndMonotonicMs - acceptance.getState().observationStartMonotonicMs);
    runtime.actualElapsedMs = runtime.observationElapsedMs;
    runtime.runCompleted = runtime.observationElapsedMs >= DURATION_MS;
  }
  const finalEvaluation = evaluateChecks(cycles, Array.from(tradesById.values()), verificationState);
  verificationMetrics.acceptance = buildAcceptanceReport(verificationMetrics, finalEvaluation);
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Recording complete: ${formatTime(runtime.totalElapsedMs)}`);
  const trades = Array.from(tradesById.values());
  console.log(`  Cycles: ${cycles.length} | Trades: ${trades.length}`);
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

  if (!verificationMetrics.acceptance.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  EXPECTED_SOURCE_CADENCE_MS,
  HTTP_TIMEOUT_MS,
  MAX_ENDPOINT_OUTAGE_MS,
  MAX_SOURCE_STALL_MS,
  STARTUP_FIRST_SOURCE_DEADLINE_MS,
  createVerificationMetrics,
  createHardAcceptanceState,
  calculateHardAcceptanceChecks,
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
  parseArgs,
  processPollResults,
  processHealthResults,
  recordEndpointObservation,
  recordInspectorResponse,
  recordPollAttempt,
  recordSuccessfulInspectorPoll,
  recordSuccessfulPaperPoll,
  recordSourceObservation,
  recordVerificationFailure,
  serializeVerificationMetrics,
  validateReadinessResponse,
  validateStatusResponse,
};
