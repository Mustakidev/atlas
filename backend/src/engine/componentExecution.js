const { inspectResult } = require('./componentValidator');
const { normalizeComponentResult } = require('./componentNormalizer');

function executeComponents({ components, candles, tf, context, diagnostics: diagnosticsSink }) {
  const componentResults = {};
  const missing = [];
  const diagnostics = [];
  const collectedDiagnostics = diagnosticsSink || diagnostics;

  for (const [name, component] of components) {
    try {
      const result = component.calculate(candles, tf, context);
      collectedDiagnostics.push(...inspectResult(name, result));
      const normalized = normalizeComponentResult(result, component.weight);
      const invalidScore = !Number.isFinite(result.score);
      const invalidWeight = !Number.isFinite(component.weight) || component.weight < 0;

      if (invalidScore || invalidWeight) {
        normalized.score = null;
        normalized.available = false;
      }

      componentResults[name] = normalized;

      if (result.available === false || result.score === null || invalidScore || invalidWeight) {
        missing.push({
          name,
          reason: result.reason || (result.score === null
            ? 'Insufficient data'
            : (invalidScore ? 'Invalid score' : 'Invalid weight')),
        });
      }
    } catch (err) {
      componentResults[name] = {
        score: null,
        direction: null,
        weight: component.weight,
        available: false,
        confidence: null,
        reason: err.message,
      };
      missing.push({ name, reason: err.message });
    }
  }

  return { componentResults, missing, diagnostics: collectedDiagnostics };
}

module.exports = { executeComponents };
