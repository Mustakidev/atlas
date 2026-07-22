const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateScore } = require('../../src/engine/scoreAggregator');

function componentResults(scores, weight = 1) {
  return Object.fromEntries(scores.map((score, index) => [`component${index}`, {
    score,
    weight,
    available: true,
  }]));
}

test('aggregates equally weighted component scores', () => {
  assert.equal(aggregateScore(componentResults([80, 60, 40])), 60);
});

test('preserves weighted score semantics', () => {
  assert.equal(aggregateScore({
    trend: { score: 90, weight: 0.30, available: true },
    structure: { score: 60, weight: 0.25, available: true },
    momentum: { score: 40, weight: 0.15, available: true },
    rsi: { score: 20, weight: 0.15, available: true },
    volatility: { score: 50, weight: 0.15, available: true },
  }), 59);
});

test('excludes unavailable and null-score components from the aggregate', () => {
  assert.equal(aggregateScore({
    available: { score: 80, weight: 0.50, available: true },
    unavailable: { score: 20, weight: 0.25, available: false },
    missing: { score: null, weight: 0.25, available: true },
  }), 80);
});

test('returns null when no component contributes to the score', () => {
  assert.equal(aggregateScore({
    unavailable: { score: 80, weight: 1, available: false },
    missing: { score: null, weight: 1, available: true },
  }), null);
});

test('preserves undefined score legacy behavior', () => {
  assert.ok(Number.isNaN(aggregateScore({
    undefinedScore: { score: undefined, weight: 1, available: true },
  })));
});

test('returns identical output for repeated identical input', () => {
  const results = componentResults([90, 60, 30]);
  assert.equal(aggregateScore(results), aggregateScore(results));
});
