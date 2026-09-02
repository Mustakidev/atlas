const { normalizeReplayInput } = require('../engine/replayInput');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../engine/replayMultiTimeframeInput');
const { createReplayDependencies } = require('../engine/replayDependencies');
const { createReplayPipelineRunner } = require('../engine/replayPipelineRunner');

const HOUR_MS = REPLAY_MTF_DURATIONS_MS['1h'];
const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_APPLICATION_HORIZON = 99 * DAY_MS - HOUR_MS;
const REQUEST_KEYS = Object.freeze(['symbol', 'startTime', 'endTime']);
const DIAGNOSTIC_KEYS = new Set([
  'analyzedAt',
  'calculatedAt',
  'lastUpdated',
  'calculationTime',
  'analysisTime',
  'executionTime',
]);
const TRADE_KEYS = Object.freeze([
  'tradeId',
  'symbol',
  'timeframe',
  'direction',
  'entryPrice',
  'entryTime',
  'stopLoss',
  'takeProfit',
  'riskReward',
  'positionSize',
  'currentPrice',
  'status',
  'exitPrice',
  'exitTime',
  'exitReason',
  'duration',
  'pnl',
  'pnlPercent',
  'confidence',
  'reason',
  'timestamp',
]);
const STATS_KEYS = Object.freeze([
  'totalTrades',
  'openTrades',
  'closedTrades',
  'pendingTrades',
  'winRate',
  'lossRate',
  'breakevenRate',
  'totalPnl',
  'totalPnlPercent',
  'averagePnl',
  'averagePnlPercent',
  'grossProfit',
  'grossLoss',
  'profitFactor',
  'netReturnPct',
  'expectancy',
  'expectancyRatio',
  'rewardRisk',
  'averageWin',
  'averageLoss',
  'averageDuration',
  'maxWin',
  'maxLoss',
  'largestWin',
  'largestLoss',
  'maxDrawdown',
  'maxDrawdownPct',
  'maxConsecutiveWins',
  'maxConsecutiveLosses',
  'currentStreak',
  'currentStreakType',
  'balance',
  'initialBalance',
  'byDirection',
  'byTimeframe',
  'byExitReason',
]);
const PERFORMANCE_KEYS = Object.freeze([
  'profitFactor',
  'expectancy',
  'expectancyRatio',
  'maxDrawdown',
  'maxDrawdownPct',
  'largestWin',
  'largestLoss',
  'avgConsecutiveWins',
  'avgConsecutiveLosses',
  'currentStreak',
  'currentStreakType',
  'totalPnl',
  'netReturnPct',
  'sharpeRatio',
  'sortinoRatio',
]);
const RISK_KEYS = Object.freeze([
  'accountBalance',
  'riskPerTradePct',
  'dailyPnL',
  'dailyDrawdownPct',
  'maxDailyLossPct',
  'maxDailyDrawdownPct',
  'consecutiveLosses',
  'maxConsecutiveLosses',
  'lossPauseRemainingMs',
  'dailyLossLimitReached',
  'tradingEnabled',
  'session',
  'sessionMultipliers',
  'atrMultTrending',
  'atrMultRanging',
  'rrTrending',
  'rrRanging',
]);
const DECISION_KEYS = Object.freeze([
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
  'regimeDecision',
  'mtfConfirmation',
]);

class ProductionReplayApplicationError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProductionReplayApplicationError';
    this.code = code;

    for (const key of [
      'source',
      'phase',
      'field',
      'expected',
      'actual',
      'originalCode',
      'cause',
    ]) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}

function fail(code, message, details) {
  throw new ProductionReplayApplicationError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label, details = {}) {
  if (!isPlainObject(value)) {
    fail('SOURCE_MISMATCH', `${label} must be a plain object`, details);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || expectedKeys.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
    fail('INVALID_REQUEST', `${label} must contain exactly ${expectedKeys.join(', ')}`);
  }
}

function isValidTimestamp(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && Number.isFinite(new Date(value).getTime());
}

function normalizeRequest(request) {
  if (!isPlainObject(request)) fail('INVALID_REQUEST', 'request must be a plain object');
  assertExactKeys(request, REQUEST_KEYS, 'request');

  const { symbol, startTime, endTime } = request;
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,20}$/.test(symbol)) {
    fail('INVALID_REQUEST', 'request.symbol must be an uppercase alphanumeric Binance symbol');
  }
  if (!isValidTimestamp(startTime) || !isValidTimestamp(endTime)) {
    fail('INVALID_REQUEST', 'request.startTime and request.endTime must be valid timestamps');
  }
  if (endTime <= startTime) {
    fail('INVALID_REQUEST', 'request.endTime must be greater than request.startTime');
  }
  if (startTime % HOUR_MS !== 0 || endTime % HOUR_MS !== 0) {
    fail('INVALID_REQUEST', 'request.startTime and request.endTime must align to one-hour boundaries');
  }
  if (endTime - startTime > MAX_APPLICATION_HORIZON) {
    fail('INVALID_REQUEST', 'request horizon must not exceed 99 days minus one hour');
  }
  if (!isValidTimestamp(endTime + HOUR_MS)) {
    fail('INVALID_REQUEST', 'request.endTime leaves no room for the terminal Analyzer boundary');
  }

  return Object.freeze({ symbol, startTime, endTime });
}

function assertFetchSource(source, name) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.fetch !== 'function') {
    throw new TypeError(`${name}.fetch must be a function`);
  }
}

function assertApplicationDependencies({ logger, config, clock, riskPolicySource }) {
  if (!logger || typeof logger !== 'object' || Array.isArray(logger)
    || !['info', 'warn', 'error'].every(method => typeof logger[method] === 'function')) {
    throw new TypeError('logger must expose info(), warn(), and error()');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.get !== 'function') {
    throw new TypeError('config.get must be a function');
  }
  if (!clock || typeof clock !== 'object' || Array.isArray(clock)
    || typeof clock.nowMs !== 'function'
    || typeof clock.monotonicMs !== 'function') {
    throw new TypeError('clock must expose nowMs() and monotonicMs()');
  }
  if (!riskPolicySource || typeof riskPolicySource !== 'object'
    || Array.isArray(riskPolicySource)
    || typeof riskPolicySource.getPolicy !== 'function') {
    throw new TypeError('riskPolicySource.getPolicy must be a function');
  }
}

function sourceFailure(code, message, source, phase, error, details = {}) {
  return new ProductionReplayApplicationError(code, message, {
    ...details,
    source,
    phase,
    ...(typeof error?.code === 'string' ? { originalCode: error.code } : {}),
    cause: error,
  });
}

function compositionFailure(message, source, phase, details = {}) {
  fail('SOURCE_MISMATCH', message, { source, phase, ...details });
}

function assertMtfResult(result, request) {
  assertPlainObject(result, 'mtfResult', { source: 'mtf', phase: 'composition' });
  if (!Object.hasOwn(result, 'rawInput')) {
    compositionFailure('mtfResult.rawInput is required', 'mtf', 'composition', {
      field: 'rawInput',
    });
  }
  if (!Object.hasOwn(result, 'provenance')) {
    compositionFailure('mtfResult.provenance is required', 'mtf', 'composition', {
      field: 'provenance',
    });
  }
  assertPlainObject(result.provenance, 'mtfResult.provenance', {
    source: 'mtf',
    phase: 'composition',
    field: 'provenance',
  });

  const checks = [
    ['provider', 'binance-spot-klines'],
    ['symbol', request.symbol],
    ['requestedStartTime', request.startTime],
    ['requestedEndTime', request.endTime],
  ];
  for (const [field, expected] of checks) {
    if (result.provenance[field] !== expected) {
      compositionFailure(`mtfResult.provenance.${field} does not match the request`, 'mtf', 'composition', {
        field: `provenance.${field}`,
        expected,
        actual: result.provenance[field],
      });
    }
  }

  assertPlainObject(result.rawInput, 'mtfResult.rawInput', {
    source: 'mtf',
    phase: 'composition',
    field: 'rawInput',
  });
  if (result.rawInput.primaryTimeframe !== '1h') {
    compositionFailure('mtfResult.rawInput.primaryTimeframe must be 1h', 'mtf', 'composition', {
      field: 'rawInput.primaryTimeframe',
      expected: '1h',
      actual: result.rawInput.primaryTimeframe,
    });
  }
  if (result.rawInput.sourcePolicy !== 'independent') {
    compositionFailure('mtfResult.rawInput.sourcePolicy must be independent', 'mtf', 'composition', {
      field: 'rawInput.sourcePolicy',
      expected: 'independent',
      actual: result.rawInput.sourcePolicy,
    });
  }
}

function assertNormalizedMtfHorizon(normalizedMtfInput, request) {
  const primary = normalizedMtfInput.timeframes['1h'];
  const expectedCount = (request.endTime - request.startTime) / HOUR_MS;
  if (primary.length !== expectedCount) {
    compositionFailure('MTF primary count does not match the request', 'mtf', 'composition', {
      field: 'timeframes.1h.length',
      expected: expectedCount,
      actual: primary.length,
    });
  }
  if (primary[0].openTime !== request.startTime) {
    compositionFailure('MTF primary start does not match the request', 'mtf', 'composition', {
      field: 'timeframes.1h[0].openTime',
      expected: request.startTime,
      actual: primary[0].openTime,
    });
  }
  if (primary.at(-1).closeTime !== request.endTime) {
    compositionFailure('MTF primary close does not match the request', 'mtf', 'composition', {
      field: 'timeframes.1h[last].closeTime',
      expected: request.endTime,
      actual: primary.at(-1).closeTime,
    });
  }
}

function assertAnalyzerResult(result, request) {
  assertPlainObject(result, 'analyzerResult', { source: 'analyzer', phase: 'composition' });
  if (!Object.hasOwn(result, 'analyzerInput')) {
    compositionFailure('analyzerResult.analyzerInput is required', 'analyzer', 'composition', {
      field: 'analyzerInput',
    });
  }
  if (!Object.hasOwn(result, 'provenance')) {
    compositionFailure('analyzerResult.provenance is required', 'analyzer', 'composition', {
      field: 'provenance',
    });
  }
  assertPlainObject(result.analyzerInput, 'analyzerResult.analyzerInput', {
    source: 'analyzer',
    phase: 'composition',
    field: 'analyzerInput',
  });
  assertPlainObject(result.provenance, 'analyzerResult.provenance', {
    source: 'analyzer',
    phase: 'composition',
    field: 'provenance',
  });

  const provenanceChecks = [
    ['sourceType', 'production-replay-analyzer'],
    ['semanticMode', 'historical-equivalent'],
    ['provider', 'coingecko'],
    ['symbol', request.symbol],
    ['requestedStartTime', request.startTime],
    ['requestedEndTime', request.endTime + HOUR_MS],
  ];
  for (const [field, expected] of provenanceChecks) {
    if (result.provenance[field] !== expected) {
      compositionFailure(`analyzerResult.provenance.${field} does not match the request`, 'analyzer', 'composition', {
        field: `provenance.${field}`,
        expected,
        actual: result.provenance[field],
      });
    }
  }
  if (result.analyzerInput.schemaVersion !== 1
    || !Array.isArray(result.analyzerInput.snapshots)
    || !Object.isFrozen(result.analyzerInput.snapshots)) {
    compositionFailure('analyzerResult.analyzerInput must be normalized schema-v1 input', 'analyzer', 'composition', {
      field: 'analyzerInput',
    });
  }
  if (result.analyzerInput.symbol !== request.symbol) {
    compositionFailure('Analyzer input symbol does not match the request', 'analyzer', 'composition', {
      field: 'analyzerInput.symbol',
      expected: request.symbol,
      actual: result.analyzerInput.symbol,
    });
  }
}

function assertTemporalCoherence(normalizedMtfInput, analyzerInput, request) {
  const primary = normalizedMtfInput.timeframes['1h'];
  const snapshots = analyzerInput.snapshots;
  const expectedCount = (request.endTime - request.startTime) / HOUR_MS;

  if (primary.length !== expectedCount || snapshots.length !== expectedCount + 1) {
    compositionFailure('Primary and Analyzer counts violate the N/N+1 contract', 'analyzer', 'composition', {
      field: 'count',
      expected: { primary: expectedCount, analyzer: expectedCount + 1 },
      actual: { primary: primary.length, analyzer: snapshots.length },
    });
  }
  if (primary[0].openTime !== request.startTime) {
    compositionFailure('Primary first openTime does not match the request start', 'analyzer', 'composition', {
      field: 'primary[0].openTime',
      expected: request.startTime,
      actual: primary[0].openTime,
    });
  }
  if (primary.at(-1).openTime !== request.endTime - HOUR_MS) {
    compositionFailure('Primary terminal openTime does not match the request end', 'analyzer', 'composition', {
      field: 'primary[last].openTime',
      expected: request.endTime - HOUR_MS,
      actual: primary.at(-1).openTime,
    });
  }
  if (primary.at(-1).closeTime !== request.endTime) {
    compositionFailure('Primary terminal closeTime does not match the request end', 'analyzer', 'composition', {
      field: 'primary[last].closeTime',
      expected: request.endTime,
      actual: primary.at(-1).closeTime,
    });
  }

  for (let index = 0; index < expectedCount; index += 1) {
    const timestamp = Date.parse(snapshots[index].timestamp);
    if (!Number.isFinite(timestamp) || timestamp !== primary[index].openTime) {
      compositionFailure('Indexed primary and Analyzer timestamps disagree', 'analyzer', 'composition', {
        field: `snapshots[${index}].timestamp`,
        expected: primary[index].openTime,
        actual: timestamp,
      });
    }
  }

  const firstAnalyzerTimestamp = Date.parse(snapshots[0].timestamp);
  const terminalAnalyzerTimestamp = Date.parse(snapshots[expectedCount].timestamp);
  if (firstAnalyzerTimestamp !== request.startTime) {
    compositionFailure('Analyzer first timestamp does not match the request start', 'analyzer', 'composition', {
      field: 'snapshots[0].timestamp',
      expected: request.startTime,
      actual: firstAnalyzerTimestamp,
    });
  }
  if (terminalAnalyzerTimestamp !== request.endTime) {
    compositionFailure('Analyzer terminal timestamp does not match the request end', 'analyzer', 'composition', {
      field: `snapshots[${expectedCount}].timestamp`,
      expected: request.endTime,
      actual: terminalAnalyzerTimestamp,
    });
  }
}

function semanticClone(value, path = '$', ancestors = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (ancestors.has(value)) {
    throw new TypeError(`circular projection value at ${path}`);
  }

  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'length' && typeof key !== 'string') {
        throw new TypeError(`symbol projection key at ${path}`);
      }
    }
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`sparse projection array at ${path}`);
      result.push(semanticClone(value[index], `${path}[${index}]`, ancestors));
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`unsupported projection object at ${path}`);
    }
    result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError(`symbol projection key at ${path}`);
      if (DIAGNOSTIC_KEYS.has(key)) continue;
      if (key === 'timestamp' && path === '$.decision.mtfConfirmation') {
        continue;
      }
      result[key] = semanticClone(value[key], `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function projectKeys(value, keys) {
  const result = {};
  for (const key of keys) {
    result[key] = semanticClone(value?.[key] ?? null, `$[${key}]`);
  }
  return result;
}

function projectDecision(decision) {
  const semanticDecision = semanticClone(decision || {}, '$.decision');
  return projectKeys(semanticDecision, DECISION_KEYS);
}

function projectCycle(cycle) {
  return {
    index: cycle.index,
    openTime: cycle.openTime,
    timestamp: cycle.timestamp,
    price: cycle.price,
    decision: projectDecision(cycle.decision),
  };
}

function projectTrade(trade) {
  return projectKeys(trade, TRADE_KEYS);
}

function projectStats(stats) {
  return projectKeys(stats, STATS_KEYS);
}

function projectPerformance(performance) {
  const source = { ...performance, sortinoRatio: performance?.sortinoRatio ?? performance?.SortinoRatio };
  return projectKeys(source, PERFORMANCE_KEYS);
}

function projectRisk(risk) {
  return projectKeys(risk, RISK_KEYS);
}

function projectRunnerState(state) {
  return {
    status: state.status,
    cycleCount: state.cycleCount,
    failure: semanticClone(state.failure, '$.runnerState.failure'),
  };
}

function assertProjectionOwners(dependencies) {
  const paper = dependencies.paperTradeEngine;
  const risk = dependencies.advanceRiskEngine;
  for (const method of ['all', 'stats', 'performance']) {
    if (!paper || typeof paper[method] !== 'function') {
      throw new TypeError(`paperTradeEngine.${method} must be a function`);
    }
  }
  if (!risk || typeof risk.getState !== 'function') {
    throw new TypeError('advanceRiskEngine.getState must be a function');
  }
}

function buildProvenance(request, mtfProvenance, analyzerProvenance) {
  return {
    sourceType: 'production-replay-application',
    semanticMode: 'historical-equivalent',
    symbol: request.symbol,
    startTime: request.startTime,
    endTime: request.endTime,
    primaryTimeframe: '1h',
    mtf: semanticClone(mtfProvenance, '$.provenance.mtf'),
    analyzer: semanticClone(analyzerProvenance, '$.provenance.analyzer'),
  };
}

function createProductionReplayApplication(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be a plain object');
  assertFetchSource(options.mtfSource, 'mtfSource');
  assertFetchSource(options.analyzerSource, 'analyzerSource');
  assertApplicationDependencies(options);

  const {
    mtfSource,
    analyzerSource,
    logger,
    config,
    clock,
    riskPolicySource,
  } = options;

  async function run(request) {
    const normalizedRequest = normalizeRequest(request);

    let mtfResult;
    try {
      mtfResult = await mtfSource.fetch(normalizedRequest);
    } catch (error) {
      throw sourceFailure(
        'MTF_SOURCE_FAILURE',
        'Production MTF source acquisition failed',
        'mtf',
        'acquisition',
        error,
      );
    }

    assertMtfResult(mtfResult, normalizedRequest);

    let normalizedMtfInput;
    let normalizedInput;
    try {
      normalizedMtfInput = normalizeReplayMultiTimeframeInput(mtfResult.rawInput);
      assertNormalizedMtfHorizon(normalizedMtfInput, normalizedRequest);
      normalizedInput = normalizeReplayInput(normalizedMtfInput.timeframes['1h'], '1h');
    } catch (error) {
      if (error instanceof ProductionReplayApplicationError) throw error;
      throw sourceFailure(
        'MTF_SOURCE_FAILURE',
        'Production MTF source normalization failed',
        'mtf',
        'normalization',
        error,
      );
    }

    let analyzerResult;
    try {
      analyzerResult = await analyzerSource.fetch({
        symbol: normalizedRequest.symbol,
        startTime: normalizedRequest.startTime,
        endTime: normalizedRequest.endTime + HOUR_MS,
      });
    } catch (error) {
      throw sourceFailure(
        'ANALYZER_SOURCE_FAILURE',
        'Production Analyzer source acquisition failed',
        'analyzer',
        'acquisition',
        error,
      );
    }

    assertAnalyzerResult(analyzerResult, normalizedRequest);
    assertTemporalCoherence(
      normalizedMtfInput,
      analyzerResult.analyzerInput,
      normalizedRequest,
    );

    let dependencies;
    try {
      dependencies = createReplayDependencies({
        logger,
        symbol: normalizedRequest.symbol,
        config,
        normalizedInput,
        normalizedMtfInput,
        analyzerInput: analyzerResult.analyzerInput,
        riskPolicySource,
        clock,
      });
      assertProjectionOwners(dependencies);
    } catch (error) {
      throw sourceFailure(
        'DEPENDENCY_FAILURE',
        'Canonical replay dependency construction failed',
        'dependencies',
        'construction',
        error,
      );
    }

    let runner;
    try {
      runner = createReplayPipelineRunner({ dependencies, normalizedInput });
    } catch (error) {
      throw sourceFailure(
        'REPLAY_FAILURE',
        'Canonical replay runner construction failed',
        'runner',
        'construction',
        error,
      );
    }

    const rawCycles = [];
    let runnerState;
    try {
      while (runner.hasNext()) rawCycles.push(runner.runNextCycle());
      runnerState = runner.getState();
    } catch (error) {
      throw sourceFailure(
        'REPLAY_FAILURE',
        'Canonical replay execution failed',
        'runner',
        'execution',
        error,
      );
    }

    const expectedCycleCount = normalizedInput.candles.length;
    if (runnerState.status !== 'EXHAUSTED'
      || runnerState.failure !== null
      || runnerState.cycleCount !== expectedCycleCount) {
      throw new ProductionReplayApplicationError(
        'REPLAY_FAILURE',
        'Canonical replay did not reach a successful terminal state',
        {
          source: 'runner',
          phase: 'terminal',
          expected: { status: 'EXHAUSTED', failure: null, cycleCount: expectedCycleCount },
          actual: {
            status: runnerState.status,
            failure: runnerState.failure,
            cycleCount: runnerState.cycleCount,
          },
        },
      );
    }

    let replay;
    let provenance;
    try {
      replay = {
        cycles: rawCycles.map(projectCycle),
        runnerState: projectRunnerState(runnerState),
        trades: dependencies.paperTradeEngine.all().map(projectTrade),
        stats: projectStats(dependencies.paperTradeEngine.stats()),
        performance: projectPerformance(dependencies.paperTradeEngine.performance()),
        risk: projectRisk(dependencies.advanceRiskEngine.getState()),
      };
      provenance = buildProvenance(
        normalizedRequest,
        mtfResult.provenance,
        analyzerResult.provenance,
      );
    } catch (error) {
      throw sourceFailure(
        'REPLAY_FAILURE',
        'Canonical replay projection failed',
        'runner',
        'projection',
        error,
      );
    }

    return deepFreeze({ replay, provenance });
  }

  return Object.freeze({ run });
}

module.exports = {
  createProductionReplayApplication,
  ProductionReplayApplicationError,
};
