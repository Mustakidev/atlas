function aggregateScore(componentResults) {
  let totalWeight = 0;
  let weightedScoreSum = 0;

  for (const result of Object.values(componentResults)) {
    if (result.available !== false && result.score !== null) {
      totalWeight += result.weight;
      weightedScoreSum += result.score * result.weight;
    }
  }

  return totalWeight > 0 ? Math.round(weightedScoreSum / totalWeight) : null;
}

module.exports = { aggregateScore };
