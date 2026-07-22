function normalizeComponentResult(result, weight) {
  return {
    score: result.score,
    direction: result.direction,
    weight,
    available: result.available !== false,
    confidence: result.confidence || null,
    reason: result.reason || null,
  };
}

module.exports = { normalizeComponentResult };
