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
      componentResults[name] = normalizeComponentResult(result, component.weight);

      if (result.available === false || result.score === null) {
        missing.push({ name, reason: result.reason || 'Insufficient data' });
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
