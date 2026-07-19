const { REGIMES } = require('./RegimeTypes');

const ENGINE_VERSION = '1.0.0';

const PENALTIES = {
  NONE: 0,
  MINOR: 5,
  MODERATE: 15,
  SEVERE: 25,
  REJECT: 100,
};

class RegimeDecisionEngine {
  constructor({ logger, symbol }) {
    this.logger = logger;
    this.symbol = symbol || 'BTCUSDT';
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
  }

  evaluate({ regime, confidence, direction, confluenceScore }) {
    const start = Date.now();

    if (!regime || regime === REGIMES.UNKNOWN) {
      return this._unknownDecision(direction, confluenceScore);
    }

    const decision = this._applyRules(regime, confidence, direction, confluenceScore);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return decision;
  }

  _applyRules(regime, confidence, direction, confluenceScore) {
    switch (regime) {
      case REGIMES.TRENDING_BULL:
        return this._bullTrend(confidence, direction, confluenceScore);
      case REGIMES.TRENDING_BEAR:
        return this._bearTrend(confidence, direction, confluenceScore);
      case REGIMES.RANGING:
        return this._sideways(confidence, direction, confluenceScore);
      case REGIMES.HIGH_VOLATILITY:
        return this._highVolatility(confidence, direction, confluenceScore);
      case REGIMES.LOW_VOLATILITY:
        return this._lowVolatility(confidence, direction, confluenceScore);
      default:
        return this._unknownDecision(direction, confluenceScore);
    }
  }

  _bullTrend(confidence, direction, confluenceScore) {
    if (direction === 'BUY') {
      return {
        allowTrade: true,
        reason: 'Bull trend detected — BUY trades active, no penalty',
        penalty: PENALTIES.NONE,
        preferredDirection: 'BUY',
      };
    }

    if (direction === 'SELL') {
      const penalty = confidence >= 70 ? PENALTIES.SEVERE : PENALTIES.MODERATE;
      const allow = confluenceScore >= 75;
      return {
        allowTrade: allow,
        reason: allow
          ? `Bull trend — SELL counter-trend allowed with strong confluence (${confluenceScore})`
          : `Bull trend — SELL counter-trend penalized (-${penalty} confidence)`,
        penalty,
        preferredDirection: 'BUY',
      };
    }

    return {
      allowTrade: true,
      reason: 'Bull trend — no direction preference',
      penalty: PENALTIES.NONE,
      preferredDirection: 'BUY',
    };
  }

  _bearTrend(confidence, direction, confluenceScore) {
    if (direction === 'SELL') {
      return {
        allowTrade: true,
        reason: 'Bear trend detected — SELL trades active, no penalty',
        penalty: PENALTIES.NONE,
        preferredDirection: 'SELL',
      };
    }

    if (direction === 'BUY') {
      const penalty = confidence >= 70 ? PENALTIES.SEVERE : PENALTIES.MODERATE;
      const allow = confluenceScore >= 75;
      return {
        allowTrade: allow,
        reason: allow
          ? `Bear trend — BUY counter-trend allowed with strong confluence (${confluenceScore})`
          : `Bear trend — BUY counter-trend penalized (-${penalty} confidence)`,
        penalty,
        preferredDirection: 'SELL',
      };
    }

    return {
      allowTrade: true,
      reason: 'Bear trend — no direction preference',
      penalty: PENALTIES.NONE,
      preferredDirection: 'SELL',
    };
  }

  _sideways(confidence, direction, confluenceScore) {
    const requiredConfluence = 65;
    const isTrendFollower = direction === 'BUY' || direction === 'SELL';

    if (isTrendFollower && confluenceScore < requiredConfluence) {
      return {
        allowTrade: false,
        reason: `Sideways market — trend-following trade rejected, confluence ${confluenceScore} < required ${requiredConfluence}`,
        penalty: PENALTIES.MODERATE,
        preferredDirection: 'NEUTRAL',
      };
    }

    if (isTrendFollower && confluenceScore >= requiredConfluence) {
      return {
        allowTrade: true,
        reason: `Sideways market — trend trade allowed with strong confluence (${confluenceScore})`,
        penalty: PENALTIES.MINOR,
        preferredDirection: 'NEUTRAL',
      };
    }

    return {
      allowTrade: true,
      reason: 'Sideways market — no direction preference',
      penalty: PENALTIES.NONE,
      preferredDirection: 'NEUTRAL',
    };
  }

  _highVolatility(confidence, direction, confluenceScore) {
    const requiredConfidence = 70;
    const requiredConfluence = 70;

    if (confluenceScore < requiredConfluence) {
      return {
        allowTrade: false,
        reason: `High volatility — trade rejected, confluence ${confluenceScore} < required ${requiredConfluence}`,
        penalty: PENALTIES.SEVERE,
        preferredDirection: direction || 'NEUTRAL',
        warning: 'HIGH_VOLATILITY',
        riskReduction: 0.5,
      };
    }

    return {
      allowTrade: true,
      reason: `High volatility — trade allowed with sufficient confluence (${confluenceScore})`,
      penalty: PENALTIES.MODERATE,
      preferredDirection: direction || 'NEUTRAL',
      warning: 'HIGH_VOLATILITY',
      riskReduction: 0.5,
    };
  }

  _lowVolatility(confidence, direction, confluenceScore) {
    return {
      allowTrade: true,
      reason: 'Low volatility — normal trading conditions',
      penalty: PENALTIES.NONE,
      preferredDirection: direction || 'NEUTRAL',
    };
  }

  _unknownDecision(direction, confluenceScore) {
    return {
      allowTrade: true,
      reason: 'Unknown regime — allowing trade with no regime adjustment',
      penalty: PENALTIES.NONE,
      preferredDirection: direction || 'NEUTRAL',
    };
  }

  getInfo() {
    return {
      name: 'RegimeDecision',
      description: 'Regime-Aware Decision Engine — applies regime-based penalties and preferences to trade decisions',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
    };
  }
}

module.exports = { RegimeDecisionEngine, ENGINE_VERSION, PENALTIES };
