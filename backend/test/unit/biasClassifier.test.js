const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyBias } = require('../../src/engine/biasClassifier');
const { ConfluenceEngine } = require('../../src/engine/confluence');

function classifyThroughFacade(score, config) {
  return ConfluenceEngine.prototype._classifyBias.call({ config }, score);
}

test('classifies 34 as Bearish', () => {
  assert.equal(classifyBias(34), 'Bearish');
});

test('classifies 35 as Bearish', () => {
  assert.equal(classifyBias(35), 'Bearish');
});

test('classifies 36 as Neutral', () => {
  assert.equal(classifyBias(36), 'Neutral');
});

test('classifies 64 as Neutral', () => {
  assert.equal(classifyBias(64), 'Neutral');
});

test('classifies 65 as Bullish', () => {
  assert.equal(classifyBias(65), 'Bullish');
});

test('classifies 66 as Bullish', () => {
  assert.equal(classifyBias(66), 'Bullish');
});

test('classifies using custom configured thresholds', () => {
  const config = {
    get(key) {
      return key === 'CONFLUENCE_BULLISH_THRESHOLD' ? 70 : 30;
    },
  };

  assert.equal(classifyThroughFacade(30, config), 'Bearish');
  assert.equal(classifyThroughFacade(31, config), 'Neutral');
  assert.equal(classifyThroughFacade(70, config), 'Bullish');
});

test('uses default thresholds when configured values are unavailable', () => {
  const unavailableConfig = { get: () => undefined };

  assert.equal(classifyThroughFacade(35, unavailableConfig), 'Bearish');
  assert.equal(classifyThroughFacade(65, unavailableConfig), 'Bullish');
  assert.equal(classifyThroughFacade(50, undefined), 'Neutral');
});

test('returns identical output for repeated identical input', () => {
  const input = { bullishThreshold: 68, bearishThreshold: 32 };
  assert.equal(classifyBias(68, input), classifyBias(68, input));
  assert.equal(classifyBias(50, input), classifyBias(50, input));
  assert.equal(classifyBias(32, input), classifyBias(32, input));
});
