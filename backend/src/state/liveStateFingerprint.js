const { createConfigFingerprint } = require('./liveExecutionStateSchema');
const { DEFAULTS } = require('../engine/advanceRisk');
const {
  RISK_PER_TRADE_PCT,
} = require('../engine/paperTrading');

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a non-array object`);
  }
}

function createCanonicalLiveStateFingerprint({
  config,
  symbol,
  paperTrading,
  advanceRisk,
  executionPipeline,
  mtfConfirmation,
} = {}) {
  assertObject(config, 'config');
  assertObject(paperTrading, 'paperTrading');
  assertObject(advanceRisk, 'advanceRisk');
  assertObject(executionPipeline, 'executionPipeline');
  assertObject(mtfConfirmation, 'mtfConfirmation');

  if (typeof config.get !== 'function') throw new TypeError('config.get must be a function');
  if (typeof paperTrading.getInfo !== 'function') throw new TypeError('paperTrading.getInfo must be a function');
  if (typeof advanceRisk.getPolicy !== 'function') throw new TypeError('advanceRisk.getPolicy must be a function');
  if (typeof executionPipeline.getPolicy !== 'function') throw new TypeError('executionPipeline.getPolicy must be a function');
  if (typeof mtfConfirmation.isAggressive !== 'function') throw new TypeError('mtfConfirmation.isAggressive must be a function');

  const paperInfo = paperTrading.getInfo();
  const riskPolicy = advanceRisk.getPolicy();
  const executionPolicy = executionPipeline.getPolicy();

  return createConfigFingerprint({
    symbol,
    paperTrading: {
      initialBalance: paperInfo.initialBalance,
      maxTrades: paperInfo.maxTrades,
      fallbackRiskPerTradePct: RISK_PER_TRADE_PCT,
    },
    confluence: {
      bullishThreshold: config.get('CONFLUENCE_BULLISH_THRESHOLD'),
      bearishThreshold: config.get('CONFLUENCE_BEARISH_THRESHOLD'),
    },
    advanceRisk: {
      riskPerTradePct: riskPolicy.riskPerTradePct,
      atrMultTrending: riskPolicy.atrMultTrending,
      atrMultRanging: riskPolicy.atrMultRanging,
      rrTrending: riskPolicy.rrTrending,
      rrRanging: riskPolicy.rrRanging,
      maxDailyLossPct: riskPolicy.maxDailyLossPct,
      maxDailyDrawdownPct: riskPolicy.maxDailyDrawdownPct,
      maxConsecutiveLosses: riskPolicy.maxConsecutiveLosses,
      cooldownMs: riskPolicy.cooldownMs,
      sessionMultipliers: riskPolicy.sessionMultipliers,
      minConfidence: DEFAULTS.MIN_CONFIDENCE,
      maxVolatilityPct: DEFAULTS.MAX_VOLATILITY_PCT,
    },
    executionPipeline: {
      signalCooldownMs: executionPolicy.signalCooldownMs,
    },
    mtf: {
      aggressive: mtfConfirmation.isAggressive(),
    },
  });
}

module.exports = { createCanonicalLiveStateFingerprint };
