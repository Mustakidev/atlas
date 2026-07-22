function calculateConfidence(componentResults, totalComponentCount) {
  const available = [];
  for (const [name, result] of Object.entries(componentResults)) {
    if (result.available && result.confidence !== null) {
      available.push(result.confidence);
    }
  }

  if (available.length === 0) return 0;

  const avgConfidence = available.reduce((a, b) => a + b, 0) / available.length;
  const coveragePenalty = available.length / totalComponentCount;

  return Math.round(avgConfidence * coveragePenalty);
}

module.exports = { calculateConfidence };
