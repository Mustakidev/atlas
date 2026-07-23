function aggregateScore(componentResults) {
  let totalWeight = 0;
  let weightedScoreSum = 0;

  for (const result of Object.values(componentResults)) {
    if (!result || result.available === false || !Number.isFinite(result.score)
      || !Number.isFinite(result.weight) || result.weight < 0) continue;

    const weightedScore = result.score * result.weight;
    const nextTotalWeight = totalWeight + result.weight;
    const nextWeightedScoreSum = weightedScoreSum + weightedScore;
    if (!Number.isFinite(weightedScore)
      || !Number.isFinite(nextTotalWeight)
      || !Number.isFinite(nextWeightedScoreSum)) continue;

    totalWeight = nextTotalWeight;
    weightedScoreSum = nextWeightedScoreSum;
  }

  if (totalWeight <= 0) return null;

  const score = weightedScoreSum / totalWeight;
  return Number.isFinite(score) ? Math.round(score) : null;
}

module.exports = { aggregateScore };
