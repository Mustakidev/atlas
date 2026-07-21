const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfluenceEngine } = require('../../src/engine/confluence');
const { RSIIndicator } = require('../../src/engine/indicators/rsi');
const { StructureEngine } = require('../../src/engine/structure');
const { bullishCandles } = require('../fixtures/market');
const { fresh } = require('../helpers/fixtures');

test('Confluence returns a bounded scored response with component results', () => {
  const candles = fresh(bullishCandles, 40);
  const registry = { get(name) { return name === 'RSI' ? new RSIIndicator('BTCUSDT') : null; } };
  const engine = new ConfluenceEngine({
    analyzer: {
      getAnalysis() {
        return {
          trend: { '1H': 'Bullish' },
          confidence: { '1H': 80 },
          momentum: { '1H': 70 },
          volatility: { '1H': 'Medium' },
        };
      },
    },
    indicatorRegistry: registry,
    structureEngine: new StructureEngine({ info() {}, warn() {} }, 'BTCUSDT'),
    candleEngine: null,
    logger: { info() {}, warn() {}, error() {} },
    config: { get(key) { return key === 'CONFLUENCE_BULLISH_THRESHOLD' ? 65 : 35; } },
    symbol: 'BTCUSDT',
  });
  const result = engine.calculate(candles, '1h');

  assert.ok(result.score === null || (result.score >= 0 && result.score <= 100));
  assert.ok(['Bullish', 'Bearish', 'Neutral'].includes(result.bias));
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  assert.ok(result.components && typeof result.components === 'object');
  assert.ok(Array.isArray(result.missing));
});
