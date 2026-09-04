const crypto = require('node:crypto');
const {
  DEFAULT_MAX_TRADES,
  RECENT_CLOSED_TRADES_LIMIT,
} = require('../engine/paperTrading');

const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
const STATE_TYPE = 'live-execution-state';
const MAX_DATE_MS = 8640000000000000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TRADE_STATES = new Set(['PENDING', 'OPEN', 'ACTIVE', 'CLOSED']);

const ROOT_FIELDS = [
  'schemaVersion', 'stateType', 'symbol', 'savedAt', 'mutationSequence',
  'configFingerprint', 'paperTrading', 'advanceRisk', 'executionPipeline',
];
const PAPER_FIELDS = [
  'tradeCounter', 'lastPrice', 'balance', 'initialBalance', 'peakEquity',
  'trades', 'closedTrades',
];
const V2_PAPER_FIELDS = [...PAPER_FIELDS, 'lifetimeSummary'];
const SUMMARY_FIELDS = [
  'totalClosedTrades', 'winningTrades', 'losingTrades', 'breakevenTrades',
  'grossProfit', 'lossPnlSum', 'totalPnl', 'totalPnlPercent', 'totalDuration',
  'maxPnl', 'minPnl', 'bestTrade', 'worstTrade', 'drawdownPeakEquity',
  'maxDrawdown', 'maxDrawdownPct', 'maxConsecutiveWins', 'maxConsecutiveLosses',
  'winningStreakCount', 'losingStreakCount', 'currentStreak', 'currentStreakType',
  'returnMean', 'returnM2', 'downsideReturnCount', 'downsideReturnSumSquares',
  'byDirection', 'byTimeframe', 'byExitReason',
];
const SUMMARY_TRADE_FIELDS = ['tradeId', 'pnlPercent'];
const DIRECTION_SUMMARY_FIELDS = ['total', 'wins', 'losses', 'totalPnl'];
const TIMEFRAME_SUMMARY_FIELDS = ['total', 'wins', 'losses', 'totalPnl'];
const EXIT_SUMMARY_FIELDS = ['count', 'totalPnl'];
const TRADE_FIELDS = [
  'tradeId', 'symbol', 'timeframe', 'direction', 'entryPrice', 'entryTime',
  'stopLoss', 'takeProfit', 'riskReward', 'positionSize', 'currentPrice',
  'status', 'exitPrice', 'exitTime', 'exitReason', 'duration', 'pnl',
  'pnlPercent', 'confidence', 'reason', 'timestamp',
];
const RISK_FIELDS = [
  'accountBalance', 'dailyPnL', 'dailyHighWater', 'consecutiveLosses',
  'lossPauseUntil', 'dailyLossLimitReached', 'tradingEnabled',
  'lastResetDay', 'riskStateHealthy',
];
const PIPELINE_FIELDS = ['lastSignalTime', 'riskSyncFailure'];

class LiveStateError extends Error {
  constructor(code, message, { cause = null, phase = null, durability = null, recovery = null } = {}) {
    super(message, { cause: cause || undefined });
    this.name = 'LiveStateError';
    this.code = code;
    this.cause = cause;
    this.phase = phase;
    this.durability = durability;
    this.recovery = recovery;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactObject(value, fields, label) {
  if (!isPlainObject(value)) invalid(label);

  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
    invalid(`${label} shape`);
  }
}

function invalid(label) {
  throw new LiveStateError(
    'STATE_VALIDATION_FAILED',
    `Invalid live execution state field: ${label}`,
    { phase: 'validation' },
  );
}

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(label);
}

function assertSafeCounter(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(label);
}

function parseCanonicalIso(value, label) {
  if (typeof value !== 'string') invalid(label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) invalid(label);
  if (new Date(timestamp).toISOString() !== value) invalid(label);
  return timestamp;
}

function assertEpoch(value, label) {
  assertFiniteNumber(value, label);
  if (value < 0 || value > MAX_DATE_MS) invalid(label);
}

function parseDateKey(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(label);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) invalid(label);
  return value;
}

function assertFinitePositive(value, label) {
  assertFiniteNumber(value, label);
  if (!(value > 0)) invalid(label);
}

function assertNonNegativeFinite(value, label) {
  assertFiniteNumber(value, label);
  if (value < 0) invalid(label);
}

function validateTrade(trade, rootSymbol, tradeCounter, label) {
  assertExactObject(trade, TRADE_FIELDS, label);

  if (typeof trade.tradeId !== 'string') invalid(`${label}.tradeId`);
  const idMatch = /^PT-([1-9]\d*)$/.exec(trade.tradeId);
  if (!idMatch || !Number.isSafeInteger(Number(idMatch[1])) || Number(idMatch[1]) > tradeCounter) {
    invalid(`${label}.tradeId`);
  }
  if (trade.symbol !== rootSymbol) invalid(`${label}.symbol`);
  if (typeof trade.timeframe !== 'string' || trade.timeframe.length === 0) invalid(`${label}.timeframe`);
  if (trade.direction !== 'BUY' && trade.direction !== 'SELL') invalid(`${label}.direction`);

  assertFinitePositive(trade.entryPrice, `${label}.entryPrice`);
  assertFiniteNumber(trade.stopLoss, `${label}.stopLoss`);
  assertFiniteNumber(trade.takeProfit, `${label}.takeProfit`);
  if (trade.direction === 'BUY'
    ? !(trade.stopLoss < trade.entryPrice && trade.entryPrice < trade.takeProfit)
    : !(trade.takeProfit < trade.entryPrice && trade.entryPrice < trade.stopLoss)) {
    invalid(`${label}.price levels`);
  }
  assertNonNegativeFinite(trade.riskReward, `${label}.riskReward`);
  assertNonNegativeFinite(trade.positionSize, `${label}.positionSize`);
  assertFinitePositive(trade.currentPrice, `${label}.currentPrice`);
  if (!TRADE_STATES.has(trade.status)) invalid(`${label}.status`);

  const entryTime = parseCanonicalIso(trade.entryTime, `${label}.entryTime`);
  if (trade.timestamp !== trade.entryTime) invalid(`${label}.timestamp`);

  if (trade.status === 'CLOSED') {
    assertFinitePositive(trade.exitPrice, `${label}.exitPrice`);
    const exitTime = parseCanonicalIso(trade.exitTime, `${label}.exitTime`);
    if (exitTime < entryTime) invalid(`${label}.exitTime`);
    if (typeof trade.exitReason !== 'string' || trade.exitReason.length === 0) invalid(`${label}.exitReason`);
    assertNonNegativeFinite(trade.duration, `${label}.duration`);
    assertFiniteNumber(trade.pnl, `${label}.pnl`);
    assertFiniteNumber(trade.pnlPercent, `${label}.pnlPercent`);
  } else if (trade.exitPrice !== null || trade.exitTime !== null || trade.exitReason !== null
    || trade.duration !== null || trade.pnl !== null || trade.pnlPercent !== null) {
    invalid(`${label} closure fields`);
  }

  assertFiniteNumber(trade.confidence, `${label}.confidence`);
  if (trade.confidence < 0 || trade.confidence > 100) invalid(`${label}.confidence`);
  if (typeof trade.reason !== 'string') invalid(`${label}.reason`);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const clone = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(clone, key, {
        value: cloneValue(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return clone;
  }
  return value;
}

function validateSummaryTrade(trade, tradeCounter, label) {
  if (trade === null) return;
  assertExactObject(trade, SUMMARY_TRADE_FIELDS, label);
  if (typeof trade.tradeId !== 'string') invalid(`${label}.tradeId`);
  const idMatch = /^PT-([1-9]\d*)$/.exec(trade.tradeId);
  if (!idMatch || !Number.isSafeInteger(Number(idMatch[1])) || Number(idMatch[1]) > tradeCounter) {
    invalid(`${label}.tradeId`);
  }
  assertFiniteNumber(trade.pnlPercent, `${label}.pnlPercent`);
}

function validateCountSummary(value, label) {
  assertSafeCounter(value, label);
}

function validateDirectionSummary(summary, totalClosedTrades, winningTrades, losingTrades, label) {
  assertExactObject(summary, ['BUY', 'SELL'], label);
  let total = 0;
  let wins = 0;
  let losses = 0;
  for (const direction of ['BUY', 'SELL']) {
    const entry = summary[direction];
    assertExactObject(entry, DIRECTION_SUMMARY_FIELDS, `${label}.${direction}`);
    validateCountSummary(entry.total, `${label}.${direction}.total`);
    validateCountSummary(entry.wins, `${label}.${direction}.wins`);
    validateCountSummary(entry.losses, `${label}.${direction}.losses`);
    assertFiniteNumber(entry.totalPnl, `${label}.${direction}.totalPnl`);
    if (entry.wins + entry.losses > entry.total) invalid(`${label}.${direction}.counts`);
    total += entry.total;
    wins += entry.wins;
    losses += entry.losses;
  }
  if (total !== totalClosedTrades || wins !== winningTrades || losses !== losingTrades) {
    invalid(`${label}.counts`);
  }
}

function validateTimeframeSummary(summary, totalClosedTrades, winningTrades, losingTrades, label) {
  if (!isPlainObject(summary)) invalid(label);
  let total = 0;
  let wins = 0;
  let losses = 0;
  for (const [key, entry] of Object.entries(summary)) {
    if (key.length === 0) invalid(`${label}.${key}`);
    assertExactObject(entry, TIMEFRAME_SUMMARY_FIELDS, `${label}.${key}`);
    validateCountSummary(entry.total, `${label}.${key}.total`);
    validateCountSummary(entry.wins, `${label}.${key}.wins`);
    validateCountSummary(entry.losses, `${label}.${key}.losses`);
    assertFiniteNumber(entry.totalPnl, `${label}.${key}.totalPnl`);
    if (entry.wins + entry.losses > entry.total) invalid(`${label}.${key}.counts`);
    total += entry.total;
    wins += entry.wins;
    losses += entry.losses;
  }
  if (total !== totalClosedTrades || wins !== winningTrades || losses !== losingTrades) {
    invalid(`${label}.counts`);
  }
}

function validateExitSummary(summary, totalClosedTrades, label) {
  if (!isPlainObject(summary)) invalid(label);
  let total = 0;
  for (const [key, entry] of Object.entries(summary)) {
    if (key.length === 0) invalid(`${label}.${key}`);
    assertExactObject(entry, EXIT_SUMMARY_FIELDS, `${label}.${key}`);
    validateCountSummary(entry.count, `${label}.${key}.count`);
    assertFiniteNumber(entry.totalPnl, `${label}.${key}.totalPnl`);
    total += entry.count;
  }
  if (total !== totalClosedTrades) invalid(`${label}.count`);
}

function validateLifetimeSummary(summary, initialBalance, tradeCounter, label = 'lifetimeSummary') {
  assertExactObject(summary, SUMMARY_FIELDS, label);

  for (const field of [
    'totalClosedTrades', 'winningTrades', 'losingTrades', 'breakevenTrades',
    'maxConsecutiveWins', 'maxConsecutiveLosses', 'winningStreakCount',
    'losingStreakCount', 'currentStreak', 'downsideReturnCount',
  ]) {
    validateCountSummary(summary[field], `${label}.${field}`);
  }
  if (summary.winningTrades + summary.losingTrades + summary.breakevenTrades
    !== summary.totalClosedTrades) invalid(`${label}.outcomeCounts`);

  for (const field of [
    'grossProfit', 'totalPnl', 'totalPnlPercent', 'totalDuration', 'maxPnl', 'minPnl',
    'drawdownPeakEquity', 'maxDrawdown', 'maxDrawdownPct', 'returnMean', 'returnM2',
    'downsideReturnSumSquares',
  ]) {
    assertFiniteNumber(summary[field], `${label}.${field}`);
  }
  if (summary.grossProfit < 0 || summary.lossPnlSum > 0 || summary.totalDuration < 0
    || summary.drawdownPeakEquity < initialBalance || summary.maxDrawdown < 0
    || summary.maxDrawdownPct < 0 || summary.returnM2 < 0
    || summary.downsideReturnSumSquares < 0
    || summary.downsideReturnCount > summary.totalClosedTrades) {
    invalid(`${label}.numericBounds`);
  }
  assertFiniteNumber(summary.lossPnlSum, `${label}.lossPnlSum`);

  validateSummaryTrade(summary.bestTrade, tradeCounter, `${label}.bestTrade`);
  validateSummaryTrade(summary.worstTrade, tradeCounter, `${label}.worstTrade`);
  if (summary.totalClosedTrades === 0) {
    if (summary.bestTrade !== null || summary.worstTrade !== null
      || summary.currentStreak !== 0 || summary.currentStreakType !== 'None'
      || summary.returnMean !== 0 || summary.returnM2 !== 0) {
      invalid(`${label}.emptyState`);
    }
    if (summary.maxPnl !== 0 || summary.minPnl !== 0) invalid(`${label}.emptyExtrema`);
  } else if (summary.bestTrade === null || summary.worstTrade === null
    || !['Win', 'Loss', 'Breakeven'].includes(summary.currentStreakType)
    || summary.currentStreak === 0) {
    invalid(`${label}.closedState`);
  }
  if (!['None', 'Win', 'Loss', 'Breakeven'].includes(summary.currentStreakType)) {
    invalid(`${label}.currentStreakType`);
  }
  if (summary.currentStreak > summary.totalClosedTrades) invalid(`${label}.currentStreak`);
  if (summary.currentStreakType === 'Win' && summary.currentStreak > summary.winningTrades) invalid(`${label}.currentWinStreak`);
  if (summary.currentStreakType === 'Loss' && summary.currentStreak > summary.losingTrades) invalid(`${label}.currentLossStreak`);
  if (summary.currentStreakType === 'Breakeven' && summary.currentStreak > summary.breakevenTrades) invalid(`${label}.currentBreakevenStreak`);
  if (summary.maxConsecutiveWins > summary.winningTrades || summary.maxConsecutiveLosses > summary.losingTrades) {
    invalid(`${label}.maximumStreaks`);
  }
  if (summary.winningStreakCount > summary.winningTrades || summary.losingStreakCount > summary.losingTrades) {
    invalid(`${label}.streakCounts`);
  }
  if ((summary.winningTrades === 0 && summary.winningStreakCount !== 0)
    || (summary.winningTrades > 0 && summary.winningStreakCount === 0)
    || (summary.losingTrades === 0 && summary.losingStreakCount !== 0)
    || (summary.losingTrades > 0 && summary.losingStreakCount === 0)) {
    invalid(`${label}.streakPresence`);
  }

  validateDirectionSummary(
    summary.byDirection,
    summary.totalClosedTrades,
    summary.winningTrades,
    summary.losingTrades,
    `${label}.byDirection`,
  );
  validateTimeframeSummary(
    summary.byTimeframe,
    summary.totalClosedTrades,
    summary.winningTrades,
    summary.losingTrades,
    `${label}.byTimeframe`,
  );
  validateExitSummary(summary.byExitReason, summary.totalClosedTrades, `${label}.byExitReason`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function validateLiveExecutionState(snapshot, expectedContext = {}) {
  if (!isPlainObject(expectedContext)) invalid('expectedContext');
  if (typeof expectedContext.expectedFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(expectedContext.expectedFingerprint)) {
    throw new LiveStateError(
      'STATE_CONTEXT_MISMATCH',
      'Expected state fingerprint is invalid',
      { phase: 'context' },
    );
  }
  if (typeof expectedContext.expectedSymbol !== 'string' || expectedContext.expectedSymbol.length === 0) {
    throw new LiveStateError(
      'STATE_CONTEXT_MISMATCH',
      'Expected state symbol is invalid',
      { phase: 'context' },
    );
  }
  assertFiniteNumber(expectedContext.nowMs, 'expectedContext.nowMs');
  if (!Number.isInteger(expectedContext.nowMs) || expectedContext.nowMs < 0 || expectedContext.nowMs > MAX_DATE_MS) {
    invalid('expectedContext.nowMs');
  }

  assertExactObject(snapshot, ROOT_FIELDS, 'root');
  if (snapshot.schemaVersion !== LEGACY_SCHEMA_VERSION && snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw new LiveStateError(
      'STATE_SCHEMA_UNSUPPORTED',
      'Unsupported live execution state schema version',
      { phase: 'validation' },
    );
  }
  if (snapshot.stateType !== STATE_TYPE) invalid('stateType');
  if (snapshot.symbol !== expectedContext.expectedSymbol
    || typeof snapshot.symbol !== 'string' || snapshot.symbol.length === 0) {
    throw new LiveStateError(
      'STATE_CONTEXT_MISMATCH',
      'Live execution state symbol does not match expected context',
      { phase: 'context' },
    );
  }
  const savedAt = parseCanonicalIso(snapshot.savedAt, 'savedAt');
  if (savedAt > expectedContext.nowMs + FUTURE_SKEW_MS) invalid('savedAt');
  assertSafeCounter(snapshot.mutationSequence, 'mutationSequence');
  if (typeof snapshot.configFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(snapshot.configFingerprint)) {
    invalid('configFingerprint');
  }
  if (snapshot.configFingerprint !== expectedContext.expectedFingerprint) {
    throw new LiveStateError(
      'STATE_CONTEXT_MISMATCH',
      'Live execution state fingerprint does not match expected context',
      { phase: 'context' },
    );
  }

  const isV2 = snapshot.schemaVersion === SCHEMA_VERSION;
  assertExactObject(snapshot.paperTrading, isV2 ? V2_PAPER_FIELDS : PAPER_FIELDS, 'paperTrading');
  assertSafeCounter(snapshot.paperTrading.tradeCounter, 'paperTrading.tradeCounter');
  if (snapshot.paperTrading.lastPrice !== null) assertFinitePositive(snapshot.paperTrading.lastPrice, 'paperTrading.lastPrice');
  assertFiniteNumber(snapshot.paperTrading.balance, 'paperTrading.balance');
  assertFinitePositive(snapshot.paperTrading.initialBalance, 'paperTrading.initialBalance');
  assertFiniteNumber(snapshot.paperTrading.peakEquity, 'paperTrading.peakEquity');
  if (snapshot.paperTrading.peakEquity < snapshot.paperTrading.initialBalance
    || snapshot.paperTrading.peakEquity < snapshot.paperTrading.balance) {
    invalid('paperTrading.peakEquity');
  }
  if (!Array.isArray(snapshot.paperTrading.trades)) invalid('paperTrading.trades');
  if (!Array.isArray(snapshot.paperTrading.closedTrades)) invalid('paperTrading.closedTrades');
  if (isV2) {
    if (snapshot.paperTrading.trades.length > DEFAULT_MAX_TRADES) invalid('paperTrading.trades length');
    if (snapshot.paperTrading.closedTrades.length > RECENT_CLOSED_TRADES_LIMIT) {
      invalid('paperTrading.closedTrades length');
    }
    validateLifetimeSummary(
      snapshot.paperTrading.lifetimeSummary,
      snapshot.paperTrading.initialBalance,
      snapshot.paperTrading.tradeCounter,
    );
  }

  const tradesById = new Map();
  snapshot.paperTrading.trades.forEach((trade, index) => {
    const label = `paperTrading.trades[${index}]`;
    validateTrade(trade, snapshot.symbol, snapshot.paperTrading.tradeCounter, label);
    if (tradesById.has(trade.tradeId)) invalid(`${label}.tradeId duplicate`);
    tradesById.set(trade.tradeId, trade);
  });

  const closedById = new Map();
  snapshot.paperTrading.closedTrades.forEach((trade, index) => {
    const label = `paperTrading.closedTrades[${index}]`;
    validateTrade(trade, snapshot.symbol, snapshot.paperTrading.tradeCounter, label);
    if (trade.status !== 'CLOSED') invalid(`${label}.status`);
    if (closedById.has(trade.tradeId)) invalid(`${label}.tradeId duplicate`);
    closedById.set(trade.tradeId, trade);
  });

  for (const [tradeId, trade] of tradesById) {
    const historical = closedById.get(tradeId);
    if (!historical) continue;
    if (trade.status !== 'CLOSED') invalid(`paperTrading.trades.${tradeId} active/closed collision`);
    if (JSON.stringify(trade) !== JSON.stringify(historical)) invalid(`paperTrading.${tradeId} closure mismatch`);
  }

  assertExactObject(snapshot.advanceRisk, RISK_FIELDS, 'advanceRisk');
  assertFinitePositive(snapshot.advanceRisk.accountBalance, 'advanceRisk.accountBalance');
  assertFiniteNumber(snapshot.advanceRisk.dailyPnL, 'advanceRisk.dailyPnL');
  assertFiniteNumber(snapshot.advanceRisk.dailyHighWater, 'advanceRisk.dailyHighWater');
  if (snapshot.advanceRisk.dailyHighWater
    < snapshot.advanceRisk.accountBalance + snapshot.advanceRisk.dailyPnL) {
    invalid('advanceRisk.dailyHighWater');
  }
  assertSafeCounter(snapshot.advanceRisk.consecutiveLosses, 'advanceRisk.consecutiveLosses');
  if (snapshot.advanceRisk.lossPauseUntil !== 0) assertEpoch(snapshot.advanceRisk.lossPauseUntil, 'advanceRisk.lossPauseUntil');
  for (const field of ['dailyLossLimitReached', 'tradingEnabled', 'riskStateHealthy']) {
    if (typeof snapshot.advanceRisk[field] !== 'boolean') invalid(`advanceRisk.${field}`);
  }
  parseDateKey(snapshot.advanceRisk.lastResetDay, 'advanceRisk.lastResetDay');

  assertExactObject(snapshot.executionPipeline, PIPELINE_FIELDS, 'executionPipeline');
  if (snapshot.executionPipeline.lastSignalTime !== 0) assertEpoch(snapshot.executionPipeline.lastSignalTime, 'executionPipeline.lastSignalTime');
  if (typeof snapshot.executionPipeline.riskSyncFailure !== 'boolean') invalid('executionPipeline.riskSyncFailure');

  return deepFreeze(cloneValue(snapshot));
}

function canonicalJson(value, seen = new WeakSet()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fingerprint values must be finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined' || typeof value === 'function'
    || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError('Fingerprint values must be JSON-compatible');
  }
  if (typeof value !== 'object' || !isPlainObject(value) && !Array.isArray(value)) {
    throw new TypeError('Fingerprint values must be plain objects or arrays');
  }
  if (seen.has(value)) throw new TypeError('Fingerprint context must not be cyclic');
  seen.add(value);

  let serialized;
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError('Fingerprint arrays must be dense');
      items.push(canonicalJson(value[index], seen));
    }
    serialized = `[${items.join(',')}]`;
  } else {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('Fingerprint keys must be strings');
    serialized = `{${keys.sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return serialized;
}

function requiredContextValue(value, label) {
  if (value === undefined) throw new TypeError(`Missing fingerprint context value: ${label}`);
  return value;
}

function finiteContextNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Invalid fingerprint context value: ${label}`);
  return value;
}

function normalizeFingerprintContext(context) {
  if (!isPlainObject(context)) throw new TypeError('Fingerprint context must be an object');
  const paper = requiredContextValue(context.paperTrading, 'paperTrading');
  const confluence = requiredContextValue(context.confluence, 'confluence');
  const risk = requiredContextValue(context.advanceRisk, 'advanceRisk');
  const pipeline = requiredContextValue(context.executionPipeline, 'executionPipeline');
  const mtf = requiredContextValue(context.mtf, 'mtf');
  if (!isPlainObject(paper) || !isPlainObject(confluence) || !isPlainObject(risk)
    || !isPlainObject(pipeline) || !isPlainObject(mtf)) {
    throw new TypeError('Fingerprint policy groups must be objects');
  }
  const multipliers = requiredContextValue(risk.sessionMultipliers, 'advanceRisk.sessionMultipliers');
  if (!isPlainObject(multipliers)) throw new TypeError('Session multipliers must be an object');

  const normalized = {
    symbol: requiredContextValue(context.symbol, 'symbol'),
    paperTrading: {
      initialBalance: finiteContextNumber(requiredContextValue(paper.initialBalance, 'paperTrading.initialBalance'), 'paperTrading.initialBalance'),
      maxTrades: finiteContextNumber(requiredContextValue(paper.maxTrades, 'paperTrading.maxTrades'), 'paperTrading.maxTrades'),
      fallbackRiskPerTradePct: finiteContextNumber(requiredContextValue(paper.fallbackRiskPerTradePct, 'paperTrading.fallbackRiskPerTradePct'), 'paperTrading.fallbackRiskPerTradePct'),
    },
    confluence: {
      bullishThreshold: finiteContextNumber(requiredContextValue(confluence.bullishThreshold, 'confluence.bullishThreshold'), 'confluence.bullishThreshold'),
      bearishThreshold: finiteContextNumber(requiredContextValue(confluence.bearishThreshold, 'confluence.bearishThreshold'), 'confluence.bearishThreshold'),
    },
    advanceRisk: {
      riskPerTradePct: finiteContextNumber(requiredContextValue(risk.riskPerTradePct, 'advanceRisk.riskPerTradePct'), 'advanceRisk.riskPerTradePct'),
      atrMultTrending: finiteContextNumber(requiredContextValue(risk.atrMultTrending, 'advanceRisk.atrMultTrending'), 'advanceRisk.atrMultTrending'),
      atrMultRanging: finiteContextNumber(requiredContextValue(risk.atrMultRanging, 'advanceRisk.atrMultRanging'), 'advanceRisk.atrMultRanging'),
      rrTrending: finiteContextNumber(requiredContextValue(risk.rrTrending, 'advanceRisk.rrTrending'), 'advanceRisk.rrTrending'),
      rrRanging: finiteContextNumber(requiredContextValue(risk.rrRanging, 'advanceRisk.rrRanging'), 'advanceRisk.rrRanging'),
      maxDailyLossPct: finiteContextNumber(requiredContextValue(risk.maxDailyLossPct, 'advanceRisk.maxDailyLossPct'), 'advanceRisk.maxDailyLossPct'),
      maxDailyDrawdownPct: finiteContextNumber(requiredContextValue(risk.maxDailyDrawdownPct, 'advanceRisk.maxDailyDrawdownPct'), 'advanceRisk.maxDailyDrawdownPct'),
      maxConsecutiveLosses: finiteContextNumber(requiredContextValue(risk.maxConsecutiveLosses, 'advanceRisk.maxConsecutiveLosses'), 'advanceRisk.maxConsecutiveLosses'),
      cooldownMs: finiteContextNumber(requiredContextValue(risk.cooldownMs, 'advanceRisk.cooldownMs'), 'advanceRisk.cooldownMs'),
      sessionMultipliers: {
        ASIAN: finiteContextNumber(requiredContextValue(multipliers.ASIAN, 'advanceRisk.sessionMultipliers.ASIAN'), 'advanceRisk.sessionMultipliers.ASIAN'),
        LONDON: finiteContextNumber(requiredContextValue(multipliers.LONDON, 'advanceRisk.sessionMultipliers.LONDON'), 'advanceRisk.sessionMultipliers.LONDON'),
        NEW_YORK: finiteContextNumber(requiredContextValue(multipliers.NEW_YORK, 'advanceRisk.sessionMultipliers.NEW_YORK'), 'advanceRisk.sessionMultipliers.NEW_YORK'),
      },
      minConfidence: finiteContextNumber(requiredContextValue(risk.minConfidence, 'advanceRisk.minConfidence'), 'advanceRisk.minConfidence'),
      maxVolatilityPct: finiteContextNumber(requiredContextValue(risk.maxVolatilityPct, 'advanceRisk.maxVolatilityPct'), 'advanceRisk.maxVolatilityPct'),
    },
    executionPipeline: {
      signalCooldownMs: finiteContextNumber(requiredContextValue(pipeline.signalCooldownMs, 'executionPipeline.signalCooldownMs'), 'executionPipeline.signalCooldownMs'),
    },
    mtf: {
      aggressive: requiredContextValue(mtf.aggressive, 'mtf.aggressive'),
    },
  };
  if (typeof normalized.symbol !== 'string' || normalized.symbol.length === 0) throw new TypeError('Invalid fingerprint context value: symbol');
  if (typeof normalized.mtf.aggressive !== 'boolean') throw new TypeError('Invalid fingerprint context value: mtf.aggressive');
  return normalized;
}

function createConfigFingerprint(context) {
  let canonical;
  try {
    canonical = canonicalJson(normalizeFingerprintContext(context));
  } catch (cause) {
    throw new LiveStateError(
      'STATE_VALIDATION_FAILED',
      'Invalid durable policy fingerprint context',
      { cause, phase: 'fingerprint' },
    );
  }
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function serializeLiveExecutionState(snapshot, expectedContext) {
  const validated = validateLiveExecutionState(snapshot, expectedContext);
  try {
    return Buffer.from(JSON.stringify(validated), 'utf8');
  } catch (cause) {
    throw new LiveStateError(
      'STATE_WRITE_FAILED',
      'Live execution state serialization failed',
      { cause, phase: 'serialize' },
    );
  }
}

function deserializeLiveExecutionState(bytes, expectedContext) {
  if ((typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) || bytes.length === 0) {
    throw new LiveStateError('STATE_PARSE_FAILED', 'Live execution state JSON is empty', { phase: 'parse' });
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString());
  } catch (cause) {
    throw new LiveStateError('STATE_PARSE_FAILED', 'Live execution state JSON is invalid', { cause, phase: 'parse' });
  }
  return validateLiveExecutionState(parsed, expectedContext);
}

module.exports = {
  FINGERPRINT_PATTERN,
  FUTURE_SKEW_MS,
  LEGACY_SCHEMA_VERSION,
  LiveStateError,
  MAX_DATE_MS,
  SCHEMA_VERSION,
  STATE_TYPE,
  createConfigFingerprint,
  deserializeLiveExecutionState,
  serializeLiveExecutionState,
  validateLiveExecutionState,
};
