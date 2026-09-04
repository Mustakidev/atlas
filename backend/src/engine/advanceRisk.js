const { REGIMES } = require('../market-regime/RegimeTypes');
const {
  elapsedMs,
  formatTimestamp,
  readNowMs,
  readMonotonicMs,
  resolveClock,
  resolveCycleNowMs,
  utcDateKey,
} = require('../core/clock');

const ENGINE_VERSION = '2.0.0';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const EXECUTABLE_REGIMES = new Set([
  REGIMES.TRENDING_BULL,
  REGIMES.TRENDING_BEAR,
  REGIMES.RANGING,
  REGIMES.HIGH_VOLATILITY,
  REGIMES.LOW_VOLATILITY,
]);

const DEFAULTS = {
  ACCOUNT_BALANCE: 10000,
  RISK_PER_TRADE_PCT: 1,
  ATR_MULT_TRENDING: 2,
  ATR_MULT_RANGING: 1.5,
  RR_TRENDING: 3,
  RR_RANGING: 1.8,
  MAX_DAILY_LOSS_PCT: 5,
  MAX_DAILY_DRAWDOWN_PCT: 10,
  MAX_CONSECUTIVE_LOSSES: 3,
  CONSECUTIVE_COOLDOWN_MS: 3600000,
  SESSION_MULT_ASIAN: 1,
  SESSION_MULT_LONDON: 1,
  SESSION_MULT_NEWYORK: 1,
  MIN_CONFIDENCE: 30,
  MAX_VOLATILITY_PCT: 5,
};

class AdvanceRiskEngine {
  constructor({ logger, symbol, paperTradeEngine, config, clock }) {
    this.logger = logger;
    this.symbol = symbol || 'BTCUSDT';
    this.paperTradeEngine = paperTradeEngine;
    this.config = config;
    this.clock = resolveClock(clock);
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;

    this._accountBalance = DEFAULTS.ACCOUNT_BALANCE;
    this._riskPerTradePct = DEFAULTS.RISK_PER_TRADE_PCT;
    this._atrMultTrending = DEFAULTS.ATR_MULT_TRENDING;
    this._atrMultRanging = DEFAULTS.ATR_MULT_RANGING;
    this._rrTrending = DEFAULTS.RR_TRENDING;
    this._rrRanging = DEFAULTS.RR_RANGING;
    this._maxDailyLossPct = DEFAULTS.MAX_DAILY_LOSS_PCT;
    this._maxDailyDrawdownPct = DEFAULTS.MAX_DAILY_DRAWDOWN_PCT;
    this._maxConsecutiveLosses = DEFAULTS.MAX_CONSECUTIVE_LOSSES;
    this._cooldownMs = DEFAULTS.CONSECUTIVE_COOLDOWN_MS;
    this._sessionMultipliers = {
      ASIAN: DEFAULTS.SESSION_MULT_ASIAN,
      LONDON: DEFAULTS.SESSION_MULT_LONDON,
      NEW_YORK: DEFAULTS.SESSION_MULT_NEWYORK,
    };

    this._dailyPnL = 0;
    this._dailyHighWater = this._accountBalance;
    this._consecutiveLosses = 0;
    this._lossPauseUntil = 0;
    this._dailyLossLimitReached = false;
    this._tradingEnabled = true;
    this._lastResetDay = this._dayKey(readNowMs(this.clock));
    this._riskStateHealthy = true;
  }

  evaluate(params) {
    const nowMs = resolveCycleNowMs(this.clock, params?.nowMs);
    const start = readMonotonicMs(this.clock);
    const { symbol, timeframe, entryPrice, atr, direction, trend, structure, confluence, regime } = params || {};

    if (!this._riskStateHealthy) {
      this.calculationTime = elapsedMs(this.clock, start);
      this.lastUpdated = formatTimestamp(nowMs);
      return this._rejected(symbol || this.symbol, timeframe, entryPrice, direction, 'RISK_STATE_UNHEALTHY', nowMs);
    }

    const inputError = this._validateInputs(params, nowMs);
    if (inputError) {
      this.calculationTime = elapsedMs(this.clock, start);
      this.lastUpdated = formatTimestamp(nowMs);
      return inputError;
    }

    this._resetDailyIfNeeded(nowMs);

    if (!this._tradingEnabled) {
      return this._rejected(symbol, timeframe, entryPrice, direction,
        'Trading disabled — manual override', nowMs);
    }

    if (this._lossPauseUntil > nowMs) {
      const remaining = Math.ceil((this._lossPauseUntil - nowMs) / 60000);
      return this._rejected(symbol, timeframe, entryPrice, direction,
        `Consecutive loss pause active — ${remaining} min remaining (${this._consecutiveLosses} consecutive losses)`, nowMs);
    }

    if (this._dailyLossLimitReached) {
      return this._rejected(symbol, timeframe, entryPrice, direction,
        `Daily loss limit reached — max ${this._maxDailyLossPct}% loss (${this._dailyPnL.toFixed(2)})`, nowMs);
    }

    const dailyDrawdownPct = this._calculateDailyDrawdownPct();
    if (dailyDrawdownPct >= this._maxDailyDrawdownPct) {
      this._dailyLossLimitReached = true;
      return this._rejected(symbol, timeframe, entryPrice, direction,
        `Daily drawdown limit reached — ${dailyDrawdownPct.toFixed(2)}% >= ${this._maxDailyDrawdownPct}% max`, nowMs);
    }

    const confConfidence = confluence?.confidence;
    if (!isFiniteNumber(confConfidence) || confConfidence > 100) {
      return this._calculationRejected(start, symbol, timeframe, entryPrice, direction, 'Invalid confluence confidence', nowMs);
    }
    if (confConfidence < DEFAULTS.MIN_CONFIDENCE) {
      return this._rejected(symbol, timeframe, entryPrice, direction,
        `Confluence confidence ${confConfidence} below minimum ${DEFAULTS.MIN_CONFIDENCE}`, nowMs);
    }

    const atrPct = atr?.atrPercentage;
    if (!isFiniteNumber(atrPct) || atrPct < 0) {
      return this._calculationRejected(start, symbol, timeframe, entryPrice, direction, 'Invalid ATR percentage', nowMs);
    }
    if (atrPct > DEFAULTS.MAX_VOLATILITY_PCT) {
      return this._rejected(symbol, timeframe, entryPrice, direction,
        `Volatility ${atrPct}% exceeds maximum ${DEFAULTS.MAX_VOLATILITY_PCT}%`, nowMs);
    }

    const isRanging = regime === REGIMES.RANGING;
    const breakoutRegime = regime === REGIMES.HIGH_VOLATILITY;

    const atrMult = breakoutRegime ? this._atrMultRanging : (isRanging ? this._atrMultRanging : this._atrMultTrending);
    const rr = isRanging ? this._rrRanging : this._rrTrending;

    const session = this._detectSession(nowMs);
    const sessionMult = this._sessionMultipliers[session] || 1;

    const effectiveRiskPct = this._riskPerTradePct * sessionMult;

    const atrValue = atr.atr;
    const isBuy = direction === 'BUY';

    const stopLossRaw = isBuy
      ? entryPrice - (atrValue * atrMult)
      : entryPrice + (atrValue * atrMult);
    const stopLoss = this._round(stopLossRaw);

    const takeProfitRaw = isBuy
      ? entryPrice + (atrValue * atrMult * rr)
      : entryPrice - (atrValue * atrMult * rr);
    const takeProfit = this._round(takeProfitRaw);

    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    const rewardPerUnit = Math.abs(takeProfit - entryPrice);
    const riskReward = riskPerUnit > 0 ? this._round(rewardPerUnit / riskPerUnit) : 0;

    const dollarRisk = this._accountBalance * (effectiveRiskPct / 100);
    let positionSize = riskPerUnit > 0 ? this._round(dollarRisk / riskPerUnit) : 0;

    const maxPositionRisk = this._accountBalance * (this._riskPerTradePct / 100);
    const actualPositionRisk = positionSize * riskPerUnit;
    if (actualPositionRisk > maxPositionRisk) {
      positionSize = this._round(maxPositionRisk / riskPerUnit);
    }

    if (breakoutRegime) {
      positionSize = this._round(positionSize * 0.5);
    }

    const roundedEntryPrice = this._round(entryPrice);
    const roundedRiskPerUnit = this._round(riskPerUnit);
    const roundedRewardPerUnit = this._round(rewardPerUnit);
    const roundedDollarRisk = this._round(dollarRisk);
    const dailyDrawdown = this._round(dailyDrawdownPct);

    if (![roundedEntryPrice, stopLoss, takeProfit, riskReward, roundedRiskPerUnit,
      roundedRewardPerUnit, positionSize, roundedDollarRisk, this._accountBalance,
      effectiveRiskPct, atrValue, atrMult, sessionMult, this._dailyPnL, dailyDrawdown]
      .every(Number.isFinite)) {
      return this._calculationRejected(start, symbol, timeframe, entryPrice, direction,
        'Risk calculation produced non-finite value', nowMs);
    }

    if (!(riskPerUnit > 0) || !(roundedRiskPerUnit > 0)) {
      return this._calculationRejected(start, symbol, timeframe, entryPrice, direction,
        'Risk distance must be finite and greater than zero', nowMs);
    }

    if (!(stopLoss > 0) || !(takeProfit > 0)) {
      return this._calculationRejected(start, symbol, timeframe, entryPrice, direction,
        'Risk levels must be finite and greater than zero', nowMs);
    }

    this.calculationTime = elapsedMs(this.clock, start);
    this.lastUpdated = formatTimestamp(nowMs);

    return {
      symbol: symbol || this.symbol,
      timeframe,
      entryPrice: roundedEntryPrice,
      direction,
      stopLoss,
      takeProfit,
      riskReward,
      riskPerUnit: roundedRiskPerUnit,
      rewardPerUnit: roundedRewardPerUnit,
      positionSize,
      dollarRisk: roundedDollarRisk,
      accountBalance: this._accountBalance,
      riskPerTradePct: effectiveRiskPct,
      atrUsed: atrValue,
      atrMultiplier: atrMult,
      regime,
      session,
      sessionMultiplier: sessionMult,
      tradeAllowed: true,
      rejectionReason: null,
      dailyPnL: this._dailyPnL,
      dailyDrawdownPct: dailyDrawdown,
      consecutiveLosses: this._consecutiveLosses,
      tradingEnabled: this._tradingEnabled,
      timestamp: this.lastUpdated,
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
    };
  }

  onTradeClosed(pnl, context = {}) {
    if (!this._riskStateHealthy) throw new Error('RISK_STATE_UNHEALTHY');

    try {
      return this._recordTradeClosed(pnl, context);
    } catch (error) {
      this._riskStateHealthy = false;
      throw error;
    }
  }

  markRiskStateUnhealthy() {
    this._riskStateHealthy = false;
  }

  _recordTradeClosed(pnl, context = {}) {
    if (!isFiniteNumber(pnl)) {
      const error = new TypeError('Invalid trade closure PnL');
      error.code = 'RISK_STATE_SYNC_FAILURE';
      throw error;
    }

    const nowMs = resolveCycleNowMs(this.clock, context?.nowMs);
    this._resetDailyIfNeeded(nowMs);
    const nextDailyPnL = this._dailyPnL + pnl;
    const nextEquity = this._accountBalance + nextDailyPnL;
    if (!isFiniteNumber(nextDailyPnL) || !isFiniteNumber(nextEquity)) return;

    const isLoss = pnl < 0;
    const nextConsecutiveLosses = isLoss ? this._consecutiveLosses + 1 : 0;
    let nextLossPauseUntil = this._lossPauseUntil;
    let lossPct = null;

    if (isLoss) {
      if (nextConsecutiveLosses >= this._maxConsecutiveLosses) {
        nextLossPauseUntil = nowMs + this._cooldownMs;
        if (!isFiniteNumber(nextLossPauseUntil)) return;
      }
      lossPct = Math.abs(nextDailyPnL) / this._accountBalance * 100;
      if (!isFiniteNumber(lossPct)) return;
    }

    this._dailyPnL = nextDailyPnL;
    this._consecutiveLosses = nextConsecutiveLosses;
    this._lossPauseUntil = nextLossPauseUntil;
    if (nextEquity > this._dailyHighWater) this._dailyHighWater = nextEquity;

    if (isLoss && nextConsecutiveLosses >= this._maxConsecutiveLosses) {
      this.logger?.info('AdvanceRisk', `Consecutive loss pause activated — ${nextConsecutiveLosses} losses, cool down ${this._cooldownMs / 60000} min`);
    }
    if (isLoss && lossPct >= this._maxDailyLossPct) {
      this._dailyLossLimitReached = true;
      this.logger?.warn('AdvanceRisk', `Daily loss limit reached — ${lossPct.toFixed(2)}% loss (${this._dailyPnL.toFixed(2)})`);
    }
    this.lastUpdated = formatTimestamp(nowMs);
  }

  isRiskStateHealthy() { return this._riskStateHealthy; }

  getDailyPnL() { return this._round(this._dailyPnL); }
  getDailyDrawdownPct() {
    return this._round(this._calculateDailyDrawdownPct());
  }
  getConsecutiveLosses() { return this._consecutiveLosses; }
  isTradingEnabled(nowMs) {
    const currentNowMs = resolveCycleNowMs(this.clock, nowMs);
    return this._tradingEnabled && !this._dailyLossLimitReached && this._lossPauseUntil <= currentNowMs;
  }
  getLossPauseRemainingMs(nowMs) {
    const currentNowMs = resolveCycleNowMs(this.clock, nowMs);
    return Math.max(0, this._lossPauseUntil - currentNowMs);
  }
  getAccountBalance() { return this._accountBalance; }

  exportDurableState() {
    return {
      accountBalance: this._accountBalance,
      dailyPnL: this._dailyPnL,
      dailyHighWater: this._dailyHighWater,
      consecutiveLosses: this._consecutiveLosses,
      lossPauseUntil: this._lossPauseUntil,
      dailyLossLimitReached: this._dailyLossLimitReached,
      tradingEnabled: this._tradingEnabled,
      lastResetDay: this._lastResetDay,
      riskStateHealthy: this._riskStateHealthy,
    };
  }

  prepareDurableState(state) {
    return { ...state };
  }

  applyDurableState(prepared) {
    this._accountBalance = prepared.accountBalance;
    this._dailyPnL = prepared.dailyPnL;
    this._dailyHighWater = prepared.dailyHighWater;
    this._consecutiveLosses = prepared.consecutiveLosses;
    this._lossPauseUntil = prepared.lossPauseUntil;
    this._dailyLossLimitReached = prepared.dailyLossLimitReached;
    this._tradingEnabled = prepared.tradingEnabled;
    this._lastResetDay = prepared.lastResetDay;
    this._riskStateHealthy = prepared.riskStateHealthy;
  }

  restoreDurableState(state) {
    this.applyDurableState(this.prepareDurableState(state));
  }

  getState() {
    const nowMs = readNowMs(this.clock);
    this._resetDailyIfNeeded(nowMs);
    return {
      accountBalance: this._accountBalance,
      riskPerTradePct: this._riskPerTradePct,
      dailyPnL: this._round(this._dailyPnL),
      dailyDrawdownPct: this.getDailyDrawdownPct(),
      maxDailyLossPct: this._maxDailyLossPct,
      maxDailyDrawdownPct: this._maxDailyDrawdownPct,
      consecutiveLosses: this._consecutiveLosses,
      maxConsecutiveLosses: this._maxConsecutiveLosses,
      lossPauseRemainingMs: this.getLossPauseRemainingMs(nowMs),
      dailyLossLimitReached: this._dailyLossLimitReached,
      tradingEnabled: this._tradingEnabled,
      session: this._detectSession(nowMs),
      sessionMultipliers: { ...this._sessionMultipliers },
      atrMultTrending: this._atrMultTrending,
      atrMultRanging: this._atrMultRanging,
      rrTrending: this._rrTrending,
      rrRanging: this._rrRanging,
      lastUpdated: this.lastUpdated,
    };
  }

  getPolicy() {
    return {
      accountBalance: this._accountBalance,
      riskPerTradePct: this._riskPerTradePct,
      atrMultTrending: this._atrMultTrending,
      atrMultRanging: this._atrMultRanging,
      rrTrending: this._rrTrending,
      rrRanging: this._rrRanging,
      maxDailyLossPct: this._maxDailyLossPct,
      maxDailyDrawdownPct: this._maxDailyDrawdownPct,
      maxConsecutiveLosses: this._maxConsecutiveLosses,
      cooldownMs: this._cooldownMs,
      sessionMultipliers: { ...this._sessionMultipliers },
    };
  }

  setAccountBalance(val) { if (isFiniteNumber(val) && val > 0) this._accountBalance = val; }
  setRiskPerTradePct(val) { if (isFiniteNumber(val) && val > 0 && val <= 100) this._riskPerTradePct = val; }
  setMaxDailyLossPct(val) { if (isFiniteNumber(val) && val > 0 && val <= 100) this._maxDailyLossPct = val; }
  setMaxDailyDrawdownPct(val) { if (isFiniteNumber(val) && val > 0 && val <= 100) this._maxDailyDrawdownPct = val; }
  setMaxConsecutiveLosses(val) { if (isFiniteNumber(val) && val > 0) this._maxConsecutiveLosses = val; }
  setConsecutiveCooldownMs(val) { if (isFiniteNumber(val) && val > 0) this._cooldownMs = val; }
  setSessionMultiplier(session, mult) {
    if (this._sessionMultipliers[session] !== undefined && isFiniteNumber(mult) && mult >= 0 && mult <= 5) {
      this._sessionMultipliers[session] = mult;
    }
  }
  setAtrMultTrending(val) { if (isFiniteNumber(val) && val > 0) this._atrMultTrending = val; }
  setAtrMultRanging(val) { if (isFiniteNumber(val) && val > 0) this._atrMultRanging = val; }
  setRrTrending(val) { if (isFiniteNumber(val) && val > 0) this._rrTrending = val; }
  setRrRanging(val) { if (isFiniteNumber(val) && val > 0) this._rrRanging = val; }
  enableTrading() { this._tradingEnabled = true; }
  disableTrading() { this._tradingEnabled = false; }
  resetDaily(nowMs) {
    const currentNowMs = resolveCycleNowMs(this.clock, nowMs);
    this._dailyPnL = 0;
    this._dailyHighWater = this._accountBalance;
    this._dailyLossLimitReached = false;
    this._lastResetDay = this._dayKey(currentNowMs);
  }
  resetConsecutiveLosses() {
    this._consecutiveLosses = 0;
    this._lossPauseUntil = 0;
  }

  getInfo() {
    return {
      name: 'AdvanceRisk',
      description: 'Advanced risk management — dynamic sizing, ATR SL/TP, daily limits, consecutive loss protection, session risk',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      accountBalance: this._accountBalance,
      riskPerTradePct: this._riskPerTradePct,
    };
  }

  _detectSession(nowMs) {
    const currentNowMs = resolveCycleNowMs(this.clock, nowMs);
    const hour = new Date(currentNowMs).getUTCHours();
    if (hour >= 0 && hour < 8) return 'ASIAN';
    if (hour >= 8 && hour < 16) return 'LONDON';
    return 'NEW_YORK';
  }

  _resetDailyIfNeeded(nowMs) {
    const currentNowMs = resolveCycleNowMs(this.clock, nowMs);
    const today = this._dayKey(currentNowMs);
    if (today !== this._lastResetDay) {
      this.resetDaily(currentNowMs);
      this.resetConsecutiveLosses();
    }
  }

  _calculateDailyDrawdownPct() {
    if (this._accountBalance <= 0) return 0;
    const equity = this._accountBalance + this._dailyPnL;
    return ((this._dailyHighWater - equity) / this._accountBalance) * 100;
  }

  _validateInputs(params, nowMs) {
    if (!params) return this._rejected(this.symbol, null, null, null, 'No parameters provided', nowMs);
    if (params.regime === REGIMES.UNKNOWN || params.regime == null) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, params.entryPrice, params.direction, 'REGIME_UNKNOWN', nowMs);
    }
    if (!EXECUTABLE_REGIMES.has(params.regime)) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, params.entryPrice, params.direction, 'REGIME_INVALID', nowMs);
    }
    if (!isFiniteNumber(params.entryPrice) || params.entryPrice <= 0) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, null, params.direction, 'Invalid entry price', nowMs);
    }
    if (!params.direction || !['BUY', 'SELL'].includes(params.direction)) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, params.entryPrice, null, 'Direction must be BUY or SELL', nowMs);
    }
    if (!params.atr || !params.atr.ready || !isFiniteNumber(params.atr.atr) || params.atr.atr <= 0) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, params.entryPrice, params.direction, 'ATR not ready or invalid', nowMs);
    }
    return null;
  }

  _rejected(symbol, timeframe, entryPrice, direction, reason, nowMs) {
    const currentNowMs = resolveCycleNowMs(this.clock, nowMs);
    return {
      symbol: symbol || this.symbol,
      timeframe: timeframe || null,
      entryPrice: entryPrice != null ? this._round(entryPrice) : null,
      direction: direction || null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      riskPerUnit: null,
      rewardPerUnit: null,
      positionSize: null,
      dollarRisk: null,
      accountBalance: this._accountBalance,
      riskPerTradePct: this._riskPerTradePct,
      atrUsed: null,
      atrMultiplier: null,
      regime: null,
      session: this._detectSession(currentNowMs),
      sessionMultiplier: null,
      tradeAllowed: false,
      rejectionReason: reason,
      dailyPnL: this._dailyPnL,
      dailyDrawdownPct: this.getDailyDrawdownPct(),
      consecutiveLosses: this._consecutiveLosses,
      tradingEnabled: this._tradingEnabled,
      timestamp: formatTimestamp(currentNowMs),
      engineVersion: this.version,
      lastUpdated: formatTimestamp(currentNowMs),
      calculationTime: this.calculationTime,
    };
  }

  _calculationRejected(start, symbol, timeframe, entryPrice, direction, reason, nowMs) {
    this.calculationTime = elapsedMs(this.clock, start);
    this.lastUpdated = formatTimestamp(nowMs);
    return this._rejected(symbol || this.symbol, timeframe, entryPrice, direction, reason, nowMs);
  }

  _dayKey(nowMs) { return utcDateKey(nowMs); }

  _round(value) {
    return Math.round(value * 100) / 100;
  }
}

module.exports = { AdvanceRiskEngine, ENGINE_VERSION, DEFAULTS };
