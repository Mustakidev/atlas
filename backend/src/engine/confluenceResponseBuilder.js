function buildConfluenceResponse({
  timeframe,
  candleCount,
  score,
  bias,
  confidence,
  components,
  missing,
  timestamp,
  calculatedAt,
  engineVersion,
  lastUpdated,
  calculationTime,
  dataSource,
}) {
  return {
    timeframe,
    candleCount,
    score,
    bias,
    confidence,
    components,
    missing,
    timestamp,
    calculatedAt,
    engineVersion,
    lastUpdated,
    calculationTime,
    dataSource,
  };
}

module.exports = { buildConfluenceResponse };
