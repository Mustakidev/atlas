const { assertTimestamp, resolveClock } = require('../core/clock');
const { ReplayCandleEngine } = require('./replayCandleEngine');
const { createReplayMtfCandleAdapter } = require('./replayMtfCandleAdapter');
const { createReplayCandleView } = require('./replayCandleView');
const { REPLAY_MTF_DURATIONS_MS } = require('./replayMultiTimeframeInput');
const { createIndicatorRegistry } = require('./indicators');
const { MarketAnalyzer } = require('./analyzer');
const { StructureEngine } = require('./structure');
const { ATREngine } = require('./atr');
const { MACDEngine } = require('./macd');
const { BollingerEngine } = require('./bollinger');
const { ConfluenceEngine } = require('./confluence');
const { RegimeEngine } = require('../market-regime/RegimeEngine');
const { RegimeDecisionEngine } = require('../market-regime/RegimeDecisionEngine');
const { MTFConfirmationEngine } = require('./mtfConfirmation');
const { MTFEngine } = require('./mtf');
const { PaperTradingEngine } = require('./paperTrading');
const { AdvanceRiskEngine } = require('./advanceRisk');
const { createReplayAnalyzerHistory } = require('./replayAnalyzerHistory');
const { createReplayAnalyzerOrchestrator } = require('./replayAnalyzerOrchestrator');

// Confluence is the only graph engine that reads config at runtime. SYMBOL reads in
// Confluence and MTF are unreachable because this factory requires an explicit symbol.
const SNAPSHOTTED_CONFIG_KEYS = Object.freeze([
  'CONFLUENCE_BULLISH_THRESHOLD',
  'CONFLUENCE_BEARISH_THRESHOLD',
  'MAX_HISTORY',
]);

const SESSION_NAMES = Object.freeze(['ASIAN', 'LONDON', 'NEW_YORK']);

const RISK_POLICY_VALIDATORS = Object.freeze({
  accountBalance: value => Number.isFinite(value) && value > 0,
  riskPerTradePct: value => Number.isFinite(value) && value > 0 && value <= 100,
  atrMultTrending: value => Number.isFinite(value) && value > 0,
  atrMultRanging: value => Number.isFinite(value) && value > 0,
  rrTrending: value => Number.isFinite(value) && value > 0,
  rrRanging: value => Number.isFinite(value) && value > 0,
  maxDailyLossPct: value => Number.isFinite(value) && value > 0 && value <= 100,
  maxDailyDrawdownPct: value => Number.isFinite(value) && value > 0 && value <= 100,
  maxConsecutiveLosses: value => Number.isFinite(value) && value > 0,
  cooldownMs: value => Number.isFinite(value) && value > 0,
});

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertLogger(logger) {
  assertObject(logger, 'logger');
  for (const method of ['info', 'warn', 'error']) {
    if (typeof logger[method] !== 'function') {
      throw new TypeError(`logger.${method} must be a function`);
    }
  }
}

function assertConfig(config) {
  assertObject(config, 'config');
  if (typeof config.get !== 'function') {
    throw new TypeError('config.get must be a function');
  }
}

function assertNormalizedInput(normalizedInput) {
  assertObject(normalizedInput, 'normalizedInput');
  if (normalizedInput.schemaVersion !== 1) {
    throw new TypeError('normalizedInput.schemaVersion must be 1');
  }
  if (typeof normalizedInput.timeframe !== 'string' || normalizedInput.timeframe.trim() === '') {
    throw new TypeError('normalizedInput.timeframe must be a non-empty string');
  }
  if (!Array.isArray(normalizedInput.candles) || !Object.isFrozen(normalizedInput.candles)) {
    throw new TypeError('normalizedInput.candles must be a frozen array');
  }
  if (normalizedInput.candles.length === 0) {
    throw new TypeError('normalizedInput.candles must contain at least one candle');
  }
  assertTimestamp(
    normalizedInput.candles[0]?.openTime,
    'normalizedInput.candles[0].openTime',
  );
}

function assertReplayMtfPrimaryCoherence(normalizedInput, normalizedMtfInput) {
  const primaryCandles = normalizedInput.candles;
  const mtfPrimaryCandles = normalizedMtfInput.timeframes['1h'];
  const prefix = 'Replay MTF primary coherence mismatch:';

  if (primaryCandles.length !== mtfPrimaryCandles.length) {
    throw new TypeError(`${prefix} length differs`);
  }

  const fields = ['openTime', 'timestamp', 'open', 'high', 'low', 'close', 'volume'];
  for (let index = 0; index < primaryCandles.length; index++) {
    const primaryCandle = primaryCandles[index];
    const mtfCandle = mtfPrimaryCandles[index];

    if (!mtfCandle || typeof mtfCandle !== 'object' || Array.isArray(mtfCandle)) {
      throw new TypeError(`${prefix} candle ${index} is invalid`);
    }

    for (const field of fields) {
      if (primaryCandle[field] !== mtfCandle[field]) {
        throw new TypeError(`${prefix} candle ${index} ${field} differs`);
      }
    }

    const expectedCloseTime = primaryCandle.openTime + REPLAY_MTF_DURATIONS_MS['1h'];
    if (mtfCandle.closeTime !== expectedCloseTime) {
      throw new TypeError(`${prefix} candle ${index} closeTime differs`);
    }
  }
}

function assertRiskPolicySource(riskPolicySource) {
  if (riskPolicySource !== undefined && riskPolicySource !== null) {
    assertObject(riskPolicySource, 'riskPolicySource');
    if (typeof riskPolicySource.getPolicy !== 'function') {
      throw new TypeError('riskPolicySource.getPolicy must be a function');
    }
  }
}

function copyConfigValue(value, seen = new WeakMap()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const copy = [];
    seen.set(value, copy);
    for (const nested of value) copy.push(copyConfigValue(nested, seen));
    return Object.freeze(copy);
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return seen.get(value);
    const copy = {};
    seen.set(value, copy);
    for (const [key, nested] of Object.entries(value)) copy[key] = copyConfigValue(nested, seen);
    return Object.freeze(copy);
  }
  return value;
}

function createConfigSnapshot(config) {
  const values = {};
  for (const key of SNAPSHOTTED_CONFIG_KEYS) {
    values[key] = copyConfigValue(config.get(key));
  }
  Object.freeze(values);

  return Object.freeze({
    get(key) {
      return values[key];
    },
  });
}

function createReplayLogger() {
  // Replay diagnostics are intentionally discarded. Current replay engines only
  // use logging as an optional side effect; no graph decision depends on it.
  return Object.freeze({
    info() {},
    warn() {},
    error() {},
    system() {},
  });
}

function createRunLocalHistoricalClock(clock, initialNowMs) {
  const resolvedClock = resolveClock(clock);
  let currentNowMs = assertTimestamp(initialNowMs, 'historical clock initial timestamp');
  let localMonotonicMs = resolvedClock.monotonicMs();

  const clockView = Object.freeze({
    nowMs: () => currentNowMs,
    monotonicMs: () => localMonotonicMs++,
  });
  const controller = Object.freeze({
    advanceTo(timestamp) {
      const nextNowMs = assertTimestamp(timestamp, 'historical clock timestamp');
      if (nextNowMs < currentNowMs) {
        throw new TypeError('historical clock cannot move backwards');
      }
      currentNowMs = nextNowMs;
      return currentNowMs;
    },
  });

  return { clockView, controller };
}

function assertRiskPolicyValue(policy, key) {
  if (!Object.hasOwn(policy, key) || !RISK_POLICY_VALIDATORS[key](policy[key])) {
    throw new TypeError(`riskPolicySource.getPolicy() returned invalid ${key}`);
  }
}

function copySessionMultipliers(policy) {
  const multipliers = policy.sessionMultipliers;
  if (!multipliers || typeof multipliers !== 'object' || Array.isArray(multipliers)) {
    throw new TypeError('riskPolicySource.getPolicy() returned invalid sessionMultipliers');
  }

  for (const session of SESSION_NAMES) {
    if (!Object.hasOwn(multipliers, session)
      || !Number.isFinite(multipliers[session])
      || multipliers[session] < 0
      || multipliers[session] > 5) {
      throw new TypeError(`riskPolicySource.getPolicy() returned invalid sessionMultipliers.${session}`);
    }
  }
  for (const session of Object.keys(multipliers)) {
    if (!SESSION_NAMES.includes(session)) {
      throw new TypeError(`riskPolicySource.getPolicy() returned unknown session ${session}`);
    }
  }

  return Object.fromEntries(SESSION_NAMES.map(session => [session, multipliers[session]]));
}

function readRiskPolicy(riskPolicySource) {
  if (riskPolicySource == null) return null;
  const policy = riskPolicySource.getPolicy();
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('riskPolicySource.getPolicy() must return an object');
  }
  for (const key of Object.keys(RISK_POLICY_VALIDATORS)) assertRiskPolicyValue(policy, key);

  return {
    accountBalance: policy.accountBalance,
    riskPerTradePct: policy.riskPerTradePct,
    atrMultTrending: policy.atrMultTrending,
    atrMultRanging: policy.atrMultRanging,
    rrTrending: policy.rrTrending,
    rrRanging: policy.rrRanging,
    maxDailyLossPct: policy.maxDailyLossPct,
    maxDailyDrawdownPct: policy.maxDailyDrawdownPct,
    maxConsecutiveLosses: policy.maxConsecutiveLosses,
    cooldownMs: policy.cooldownMs,
    sessionMultipliers: copySessionMultipliers(policy),
  };
}

function applyRiskPolicy(engine, policy) {
  if (!policy) return;

  engine.setAccountBalance(policy.accountBalance);
  engine.setRiskPerTradePct(policy.riskPerTradePct);
  engine.setAtrMultTrending(policy.atrMultTrending);
  engine.setAtrMultRanging(policy.atrMultRanging);
  engine.setRrTrending(policy.rrTrending);
  engine.setRrRanging(policy.rrRanging);
  engine.setMaxDailyLossPct(policy.maxDailyLossPct);
  engine.setMaxDailyDrawdownPct(policy.maxDailyDrawdownPct);
  engine.setMaxConsecutiveLosses(policy.maxConsecutiveLosses);
  engine.setConsecutiveCooldownMs(policy.cooldownMs);

  for (const [session, multiplier] of Object.entries(policy.sessionMultipliers || {})) {
    engine.setSessionMultiplier(session, multiplier);
  }

  // Rebase the fresh daily runtime state after applying the account policy.
  engine.resetDaily();
}

function createReplayDependencies({
  logger,
  symbol,
  config,
  normalizedInput,
  analyzerInput,
  riskPolicySource,
  clock,
  normalizedMtfInput,
} = {}) {
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new TypeError('symbol must be a non-empty string');
  }
  assertLogger(logger);
  assertConfig(config);
  assertNormalizedInput(normalizedInput);
  if (analyzerInput === undefined) {
    throw new TypeError('analyzerInput is required');
  }
  assertRiskPolicySource(riskPolicySource);

  const riskPolicy = readRiskPolicy(riskPolicySource);
  let replayMtfCandleAdapter;
  if (normalizedMtfInput !== undefined) {
    replayMtfCandleAdapter = createReplayMtfCandleAdapter(normalizedMtfInput);
    assertReplayMtfPrimaryCoherence(normalizedInput, normalizedMtfInput);
  }

  const replayLogger = createReplayLogger();
  const replayConfig = createConfigSnapshot(config);
  const maxHistory = replayConfig.get('MAX_HISTORY');
  const { clockView: replayClock, controller: clockController } = createRunLocalHistoricalClock(
    clock,
    normalizedInput.candles[0].openTime,
  );
  const candleEngine = new ReplayCandleEngine({
    timeframe: normalizedInput.timeframe,
    candles: normalizedInput.candles,
  });
  const replayCandleView = normalizedMtfInput === undefined
    ? undefined
    : createReplayCandleView({
      primaryEngine: candleEngine,
      secondaryAdapter: replayMtfCandleAdapter,
    });
  const indicatorRegistry = createIndicatorRegistry(symbol);
  const analyzer = new MarketAnalyzer(replayLogger, symbol);
  const analyzerHistory = createReplayAnalyzerHistory(analyzerInput, { symbol, maxHistory });
  const replayAnalyzerOrchestrator = createReplayAnalyzerOrchestrator({
    source: analyzerInput,
    history: analyzerHistory,
    analyzer,
    symbol,
  });
  const structureEngine = new StructureEngine(replayLogger, symbol);
  const atrEngine = new ATREngine({ candleEngine, logger: replayLogger, symbol });
  const macdEngine = new MACDEngine({ candleEngine, logger: replayLogger, symbol });
  const bollingerEngine = new BollingerEngine({ candleEngine, logger: replayLogger, symbol });
  const confluenceEngine = new ConfluenceEngine({
    analyzer,
    indicatorRegistry,
    structureEngine,
    candleEngine,
    logger: replayLogger,
    config: replayConfig,
    symbol,
  });
  const regimeEngine = new RegimeEngine({
    indicatorRegistry,
    atrEngine,
    candleEngine,
    analyzer,
    logger: replayLogger,
    config: replayConfig,
    symbol,
  });
  const regimeDecisionEngine = new RegimeDecisionEngine({ logger: replayLogger, symbol });
  const mtfConfirmationEngine = new MTFConfirmationEngine({
    logger: replayLogger,
    symbol,
    config: replayConfig,
  });
  const mtfEngine = new MTFEngine({
    confluenceEngine,
    structureEngine,
    indicatorRegistry,
    candleEngine,
    analyzer,
    logger: replayLogger,
    config: replayConfig,
    symbol,
  });
  const paperTradeEngine = new PaperTradingEngine({
    logger: replayLogger,
    symbol,
    clock: replayClock,
  });
  const advanceRiskEngine = new AdvanceRiskEngine({
    logger: replayLogger,
    symbol,
    paperTradeEngine,
    config: replayConfig,
    clock: replayClock,
  });

  applyRiskPolicy(advanceRiskEngine, riskPolicy);

  const dependencies = {
    candleEngine,
    indicatorRegistry,
    analyzer,
    analyzerHistory,
    replayAnalyzerOrchestrator,
    structureEngine,
    atrEngine,
    macdEngine,
    bollingerEngine,
    confluenceEngine,
    regimeEngine,
    regimeDecisionEngine,
    mtfConfirmationEngine,
    mtfEngine,
    paperTradeEngine,
    advanceRiskEngine,
    logger: replayLogger,
    config: replayConfig,
    symbol,
    clock: replayClock,
    clockController,
  };

  if (normalizedMtfInput !== undefined) {
    dependencies.replayMtfCandleAdapter = replayMtfCandleAdapter;
    dependencies.replayCandleView = replayCandleView;
  }

  return Object.freeze(dependencies);
}

module.exports = { createReplayDependencies, SNAPSHOTTED_CONFIG_KEYS };
