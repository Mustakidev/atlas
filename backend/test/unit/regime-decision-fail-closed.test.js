const test = require('node:test');
const assert = require('node:assert/strict');

const { RegimeDecisionEngine } = require('../../src/market-regime/RegimeDecisionEngine');
const { REGIMES } = require('../../src/market-regime/RegimeTypes');

const engine = new RegimeDecisionEngine({ logger: { info() {}, warn() {}, error() {} }, symbol: 'TEST' });

function evaluate(overrides = {}) {
  return engine.evaluate({
    regime: REGIMES.TRENDING_BULL,
    confidence: 80,
    direction: 'BUY',
    confluenceScore: 80,
    ...overrides,
  });
}

test('unknown and unsupported regimes are never allowed to trade', () => {
  for (const regime of [undefined, null, REGIMES.UNKNOWN]) {
    const result = evaluate({ regime });
    assert.equal(result.allowTrade, false);
    assert.equal(result.reason, 'REGIME_UNKNOWN');
  }

  const unsupported = evaluate({ regime: 'UNSUPPORTED' });
  assert.equal(unsupported.allowTrade, false);
  assert.equal(unsupported.reason, 'REGIME_INVALID');
});

test('malformed regime decision inputs fail closed', () => {
  for (const overrides of [
    { confidence: NaN },
    { confidence: 101 },
    { confluenceScore: Infinity },
    { confluenceScore: -1 },
    { direction: 'HOLD' },
  ]) {
    const result = evaluate(overrides);
    assert.equal(result.allowTrade, false);
    assert.equal(result.reason, 'REGIME_INVALID');
  }
});
