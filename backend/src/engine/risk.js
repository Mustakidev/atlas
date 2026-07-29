/**
 * Risk Engine
 *
 * Evaluates trade risk using ATR-based stop loss, confluence confidence,
 * and volatility thresholds. Consumes outputs from existing production engines.
 *
 * Never modifies existing engines. Consumes only.
 *
 * Version: 1.0.0
 * Data Source: ATR, Trend, Structure, Confluence engine outputs (consumed only)
 */
const ENGINE_VERSION = '1.0.0';
const DEFAULT_RISK_REWARD = 2;
const DEFAULT_ATR_MULTIPLIER = 2;
const DEFAULT_MIN_CONFIDENCE = 30;
const DEFAULT_MAX_VOLATILITY_PCT = 5;
const DEFAULT_STOP_LOSS_ATR_MULT = 2;
const DEFAULT_TAKE_PROFIT_ATR_MULT = 4;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

class RiskEngine {
  constructor({ logger, symbol }) {
    this.logger = logger;
    this.symbol = symbol || 'BTCUSDT';
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'ATR, Trend, Structure, Confluence engine outputs (consumed only)';

    this._riskRewardRatio = DEFAULT_RISK_REWARD;
    this._minConfidence = DEFAULT_MIN_CONFIDENCE;
    this._maxVolatilityPct = DEFAULT_MAX_VOLATILITY_PCT;
    this._slAtrMult = DEFAULT_STOP_LOSS_ATR_MULT;
    this._tpAtrMult = DEFAULT_TAKE_PROFIT_ATR_MULT;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a potential trade for risk parameters.
   *
   * @param {Object} params
   * @param {string}  params.symbol        - Trading pair (e.g. 'BTCUSDT')
   * @param {string}  params.timeframe     - Candle timeframe (e.g. '1h')
   * @param {number}  params.entryPrice    - Intended entry price
   * @param {Object}  params.atr           - ATR engine output
   * @param {string}  params.direction     - 'BUY' or 'SELL'
   * @param {Object}  params.trend         - Trend/MarketAnalyzer output
   * @param {Object}  params.structure     - Structure engine output
   * @param {Object}  params.confluence    - Confluence engine output
   * @returns {Object} Risk evaluation result
   */
  evaluate(params) {
    const start = Date.now();
    const { symbol, timeframe, entryPrice, atr, direction, trend, structure, confluence } = params || {};

    // --- Validate inputs ---
    const inputError = this._validateInputs(params);
    if (inputError) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return inputError;
    }

    // --- Check confluence confidence threshold ---
    const confConfidence = confluence?.confidence;
    if (!isFiniteNumber(confConfidence) || confConfidence > 100) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._rejected(
        symbol || this.symbol, timeframe, entryPrice, direction,
        'Invalid confluence confidence'
      );
    }
    if (confConfidence < this._minConfidence) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._rejected(
        symbol || this.symbol, timeframe, entryPrice, direction,
        `Confluence confidence ${confConfidence} below minimum ${this._minConfidence}`
      );
    }

    // --- Check volatility threshold ---
    const atrPct = atr?.atrPercentage;
    if (!isFiniteNumber(atrPct) || atrPct < 0) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._rejected(
        symbol || this.symbol, timeframe, entryPrice, direction,
        'Invalid ATR percentage'
      );
    }
    if (atrPct > this._maxVolatilityPct) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._rejected(
        symbol || this.symbol, timeframe, entryPrice, direction,
        `Volatility ${atrPct}% exceeds maximum ${this._maxVolatilityPct}%`
      );
    }

    // --- Compute ATR-based levels ---
    const atrValue = atr.atr;
    const isBuy = direction === 'BUY';

    const stopLoss = isBuy
      ? this._round(entryPrice - (atrValue * this._slAtrMult))
      : this._round(entryPrice + (atrValue * this._slAtrMult));

    const takeProfit = isBuy
      ? this._round(entryPrice + (atrValue * this._tpAtrMult))
      : this._round(entryPrice - (atrValue * this._tpAtrMult));

    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(takeProfit - entryPrice);
    const riskReward = risk > 0 ? this._round(reward / risk) : 0;
    const roundedEntryPrice = this._round(entryPrice);
    const roundedRisk = this._round(risk);
    const roundedReward = this._round(reward);

    if (![roundedEntryPrice, stopLoss, takeProfit, riskReward, roundedRisk, roundedReward,
      atrValue, this._slAtrMult, this._tpAtrMult, confConfidence, atrPct]
      .every(Number.isFinite)) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._rejected(
        symbol || this.symbol, timeframe, entryPrice, direction,
        'Risk calculation produced non-finite value'
      );
    }

    if (!(risk > 0) || !(roundedRisk > 0)) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._rejected(
        symbol || this.symbol, timeframe, entryPrice, direction,
        'Risk distance must be finite and greater than zero'
      );
    }

    const result = {
      symbol: symbol || this.symbol,
      timeframe,
      entryPrice: roundedEntryPrice,
      direction,
      stopLoss,
      takeProfit,
      riskReward,
      risk: roundedRisk,
      reward: roundedReward,
      atrUsed: atrValue,
      atrMultiplierSL: this._slAtrMult,
      atrMultiplierTP: this._tpAtrMult,
      confluenceConfidence: confConfidence,
      volatilityPct: atrPct,
      tradeAllowed: true,
      rejectionReason: null,
      timestamp: new Date().toISOString(),
      engineVersion: this.version,
      lastUpdated: new Date().toISOString(),
      calculationTime: 0,
      dataSource: this.dataSource,
    };

    this.lastUpdated = new Date().toISOString();
    this.calculationTime = Date.now() - start;
    result.calculationTime = this.calculationTime;
    return result;
  }

  getInfo() {
    return {
      name: 'Risk',
      description: 'Risk management engine — ATR-based stop loss/take profit with confidence and volatility gates',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      riskRewardRatio: this._riskRewardRatio,
      minConfidence: this._minConfidence,
      maxVolatilityPct: this._maxVolatilityPct,
    };
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  setRiskRewardRatio(ratio) {
    if (isFiniteNumber(ratio) && ratio > 0) {
      this._riskRewardRatio = ratio;
      this._tpAtrMult = this._slAtrMult * ratio;
    }
  }

  setMinConfidence(val) {
    if (isFiniteNumber(val) && val >= 0 && val <= 100) {
      this._minConfidence = val;
    }
  }

  setMaxVolatilityPct(val) {
    if (isFiniteNumber(val) && val > 0) {
      this._maxVolatilityPct = val;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _validateInputs(params) {
    if (!params) return this._rejected(this.symbol, null, null, null, 'No parameters provided');
    if (!isFiniteNumber(params.entryPrice) || params.entryPrice <= 0) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, null, params.direction, 'Invalid entry price');
    }
    if (!params.direction || !['BUY', 'SELL'].includes(params.direction)) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, params.entryPrice, null, 'Direction must be BUY or SELL');
    }
    if (!params.atr || !params.atr.ready || !isFiniteNumber(params.atr.atr) || params.atr.atr <= 0) {
      return this._rejected(params.symbol || this.symbol, params.timeframe, params.entryPrice, params.direction, 'ATR not ready or invalid');
    }
    return null;
  }

  _rejected(symbol, timeframe, entryPrice, direction, reason) {
    return {
      symbol: symbol || this.symbol,
      timeframe: timeframe || null,
      entryPrice: entryPrice != null ? this._round(entryPrice) : null,
      direction: direction || null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      risk: null,
      reward: null,
      atrUsed: null,
      atrMultiplierSL: null,
      atrMultiplierTP: null,
      confluenceConfidence: null,
      volatilityPct: null,
      tradeAllowed: false,
      rejectionReason: reason,
      timestamp: new Date().toISOString(),
      engineVersion: this.version,
      lastUpdated: new Date().toISOString(),
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }

  _round(value) {
    return Math.round(value * 100) / 100;
  }
}

module.exports = { RiskEngine, ENGINE_VERSION, DEFAULT_RISK_REWARD, DEFAULT_MIN_CONFIDENCE, DEFAULT_MAX_VOLATILITY_PCT };
