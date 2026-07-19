const REGIMES = {
  TRENDING_BULL: 'TRENDING_BULL',
  TRENDING_BEAR: 'TRENDING_BEAR',
  RANGING: 'RANGING',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  LOW_VOLATILITY: 'LOW_VOLATILITY',
  UNKNOWN: 'UNKNOWN',
};

const REGIME_DESCRIPTIONS = {
  TRENDING_BULL: 'Sustained upward movement with strong bullish structure',
  TRENDING_BEAR: 'Sustained downward movement with strong bearish structure',
  RANGING: 'Sideways price action with no clear direction',
  HIGH_VOLATILITY: 'Elevated price volatility exceeding normal ranges',
  LOW_VOLATILITY: 'Suppressed price volatility indicating consolidation',
  UNKNOWN: 'Insufficient data to determine market regime',
};

const REGIME_THRESHOLDS = {
  TREND_BULL_MIN_SCORE: 60,
  TREND_BEAR_MAX_SCORE: 40,
  RANGE_CONFIDENCE_MIN: 55,
  HIGH_VOL_ATR_PCT: 3.0,
  LOW_VOL_ATR_PCT: 1.0,
};

function isTrending(regime) {
  return regime === REGIMES.TRENDING_BULL || regime === REGIMES.TRENDING_BEAR;
}

function isVolatile(regime) {
  return regime === REGIMES.HIGH_VOLATILITY || regime === REGIMES.LOW_VOLATILITY;
}

function getRegimeColor(regime) {
  switch (regime) {
    case REGIMES.TRENDING_BULL: return '#00e676';
    case REGIMES.TRENDING_BEAR: return '#ff5252';
    case REGIMES.RANGING: return '#ffd740';
    case REGIMES.HIGH_VOLATILITY: return '#ff9100';
    case REGIMES.LOW_VOLATILITY: return '#448aff';
    default: return '#4a5568';
  }
}

function getRegimeLabel(regime) {
  switch (regime) {
    case REGIMES.TRENDING_BULL: return 'Trending Bull';
    case REGIMES.TRENDING_BEAR: return 'Trending Bear';
    case REGIMES.RANGING: return 'Ranging';
    case REGIMES.HIGH_VOLATILITY: return 'High Volatility';
    case REGIMES.LOW_VOLATILITY: return 'Low Volatility';
    default: return 'Unknown';
  }
}

module.exports = {
  REGIMES,
  REGIME_DESCRIPTIONS,
  REGIME_THRESHOLDS,
  isTrending,
  isVolatile,
  getRegimeColor,
  getRegimeLabel,
};
