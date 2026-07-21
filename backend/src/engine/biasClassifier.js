const DEFAULT_BULLISH_THRESHOLD = 65;
const DEFAULT_BEARISH_THRESHOLD = 35;

function classifyBias(score, {
  bullishThreshold = DEFAULT_BULLISH_THRESHOLD,
  bearishThreshold = DEFAULT_BEARISH_THRESHOLD,
} = {}) {
  if (score >= bullishThreshold) return 'Bullish';
  if (score <= bearishThreshold) return 'Bearish';
  return 'Neutral';
}

module.exports = {
  classifyBias,
  DEFAULT_BULLISH_THRESHOLD,
  DEFAULT_BEARISH_THRESHOLD,
};
