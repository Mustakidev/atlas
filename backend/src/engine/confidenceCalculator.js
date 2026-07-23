function calculateConfidence(componentResults, totalComponentCount) {
  const available = [];
  for (const [name, result] of Object.entries(componentResults)) {
    if (result.available && Number.isFinite(result.confidence)) {
      available.push(result.confidence);
    }
  }

  if (available.length === 0 || !Number.isFinite(totalComponentCount) || totalComponentCount <= 0) return 0;

  const avgConfidence = available.reduce((a, b) => a + b, 0) / available.length;
  const coveragePenalty = available.length / totalComponentCount;
  const confidence = Math.round(avgConfidence * coveragePenalty);

  return Number.isFinite(confidence) ? confidence : 0;
}

module.exports = { calculateConfidence };
