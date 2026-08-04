const test = require('node:test');
const assert = require('node:assert/strict');

const { ATREngine } = require('../../src/engine/atr');
const { createIndicatorRegistry } = require('../../src/engine/indicators');
const { RegimeEngine } = require('../../src/market-regime/RegimeEngine');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { StrategyReplayEngine } = require('../../src/engine/strategyReplay');
const { createValidationDependencies } = require('../../src/engine/validationDependencies');

const logger = { info() {}, warn() {}, error() {}, system() {} };
const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const config = {
  get(key) {
    if (key === 'MAX_HISTORY') return 500;
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  },
};

function candleProvider(initial) {
  let candles = initial.map(candle => ({ ...candle }));
  return {
    set(next) { candles = next.map(candle => ({ ...candle })); },
    getCandles(_timeframe, limit) {
      const result = candles.map(candle => ({ ...candle }));
      return limit ? result.slice(-limit) : result;
    },
    getActive() { return null; },
    getAllTimeframes() { return ['1h']; },
  };
}

function constantRangeCandles(count, width = 5) {
  return Array.from({ length: count }, (_, index) => ({
    open: 100,
    high: 100 + width,
    low: 100 - width,
    close: 100,
    volume: 1,
    timestamp: new Date(BASE_TIME + index * 60000).toISOString(),
  }));
}

function variedCandles() {
  return Array.from({ length: 60 }, (_, index) => {
    const close = 100 + index * 0.5;
    const width = index % 5 === 0 ? 12 : index % 2 === 0 ? 2 : 1;
    return {
      open: close,
      high: close + width,
      low: close - width,
      close,
      volume: 10,
      timestamp: new Date(BASE_TIME + index * 3600000).toISOString(),
    };
  });
}

function customPeriodCandles() {
  return [1, 2, 3, 4, 5, 6].map((width, index) => ({
    open: 100,
    high: 100 + width,
    low: 100 - width,
    close: 100,
    volume: 1,
    timestamp: new Date(BASE_TIME + index * 60000).toISOString(),
  }));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!['timestamp', 'lastUpdated', 'calculationTime', 'calculatedAt', 'analyzedAt'].includes(key)) {
        result[key] = stable(nested);
      }
    }
    return result;
  }
  return value;
}

function makeProductionGraph(candles = variedCandles()) {
  const candleEngine = candleProvider(candles);
  const atrEngine = new ATREngine({ candleEngine, logger, symbol: 'BTCUSDT' });
  const regimeEngine = new RegimeEngine({
    indicatorRegistry: createIndicatorRegistry('BTCUSDT'),
    atrEngine,
    candleEngine,
    analyzer: { getAnalysis: () => ({ trend: {}, confidence: {} }) },
    logger,
    config,
    symbol: 'BTCUSDT',
  });
  const riskEngine = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: null, config });
  return { candleEngine, atrEngine, regimeEngine, riskEngine };
}

function productionDecision(graph, candles = variedCandles()) {
  const atr = graph.atrEngine.calculate('1h', candles.length);
  const regime = graph.regimeEngine.calculate(candles, '1h');
  const risk = graph.riskEngine.evaluate({
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 125,
    atr,
    direction: 'BUY',
    trend: {},
    structure: {},
    confluence: { confidence: 80 },
    regime: regime.regime,
  });
  return { atr, regime, risk };
}

test('default period preserves ATR formula, readiness, and metadata', () => {
  const engine = new ATREngine({ candleEngine: candleProvider(constantRangeCandles(20)), logger });
  const result = engine.calculate('1h', 20);

  assert.equal(engine.period, 14);
  assert.equal(result.period, 14);
  assert.equal(result.ready, true);
  assert.equal(result.atr, 10);
  assert.equal(engine.getInfo().minCandles, 15);

  const notReady = new ATREngine({ candleEngine: candleProvider(constantRangeCandles(14)), logger }).calculate('1h', 14);
  assert.equal(notReady.ready, false);
  assert.equal(notReady.atr, null);
  assert.match(notReady.reason, /14\/15/);
});

test('custom period is validated, used by Wilder ATR, and reported in metadata', () => {
  const candles = customPeriodCandles();
  const engine = new ATREngine({ candleEngine: candleProvider(candles), logger, period: 5 });
  const result = engine.calculate('1h', candles.length);

  assert.equal(engine.period, 5);
  assert.equal(result.period, 5);
  assert.equal(result.ready, true);
  assert.equal(result.atr, 7.2);
  assert.equal(result.atrPercentage, 7.2);
  assert.equal(engine.getInfo().minCandles, 6);

  const notReady = new ATREngine({ candleEngine: candleProvider(candles.slice(0, 5)), logger, period: 5 }).calculate('1h', 5);
  assert.equal(notReady.ready, false);
  assert.equal(notReady.atr, null);
  assert.match(notReady.reason, /5\/6/);
});

test('runtime period assignment cannot change calculation or configuration', () => {
  const candles = variedCandles();
  const engine = new ATREngine({ candleEngine: candleProvider(candles), logger });
  const control = new ATREngine({ candleEngine: candleProvider(candles), logger });
  const before = engine.calculate('1h', candles.length);
  const controlResult = control.calculate('1h', candles.length);

  engine.period = 5;

  assert.equal(engine.period, 14);
  assert.deepEqual(stable(engine.calculate('1h', candles.length)), stable(controlResult));
  assert.equal(before.atr, controlResult.atr);
});

test('invalid constructor periods are rejected deterministically', () => {
  for (const period of [0, -1, 0.5, '5', NaN, Infinity, -Infinity, null]) {
    assert.throws(
      () => new ATREngine({ candleEngine: candleProvider(constantRangeCandles(20)), logger, period }),
      { name: 'TypeError', message: 'ATR period must be a finite positive integer' },
    );
  }
});

test('large valid periods require period plus one candles', () => {
  const engine = new ATREngine({ candleEngine: candleProvider(variedCandles()), logger, period: 100000 });
  const result = engine.calculate('1h', 60);

  assert.equal(engine.period, 100000);
  assert.equal(result.ready, false);
  assert.equal(result.atr, null);
  assert.equal(result.atrPercentage, null);
  assert.match(result.reason, /60\/100001/);
});

test('production regime and risk decisions remain stable after mutation attempts', () => {
  const candles = variedCandles();
  const graph = makeProductionGraph(candles);
  const before = productionDecision(graph, candles);

  graph.atrEngine.period = 5;

  const after = productionDecision(graph, candles);
  assert.equal(graph.atrEngine.period, 14);
  assert.deepEqual(stable(after), stable(before));
});

test('replay remains isolated from production ATR configuration', () => {
  const candles = variedCandles();
  const graph = makeProductionGraph(candles);
  const replay = new StrategyReplayEngine({ logger, symbol: 'BTCUSDT', config });
  const before = replay.run(candles, '1h');

  graph.atrEngine.period = 5;

  const after = replay.run(candles, '1h');
  assert.equal(graph.atrEngine.period, 14);
  assert.deepEqual(stable(after), stable(before));
});

test('validation remains isolated from production ATR configuration', () => {
  const candles = variedCandles();
  const graph = makeProductionGraph(candles);
  const validation = createValidationDependencies({ config, symbol: 'BTCUSDT' });
  validation.candleEngine.setValidationCandles('1h', candles);
  const before = validation.regimeEngine.calculate(validation.candleEngine.getCandles('1h'), '1h');

  graph.atrEngine.period = 2;

  const after = validation.regimeEngine.calculate(validation.candleEngine.getCandles('1h'), '1h');
  assert.equal(graph.atrEngine.period, 14);
  assert.deepEqual(stable(after), stable(before));
});

test('metadata and returned result mutation cannot alter internal period', () => {
  const candles = constantRangeCandles(20);
  const engine = new ATREngine({ candleEngine: candleProvider(candles), logger });
  const info = engine.getInfo();
  const result = engine.calculate('1h', candles.length);

  info.period = 5;
  result.period = 5;

  assert.equal(engine.period, 14);
  assert.equal(engine.getInfo().period, 14);
  assert.equal(engine.calculate('1h', candles.length).period, 14);
});

test('repeated default calculations remain deterministic', () => {
  const candles = variedCandles();
  const engine = new ATREngine({ candleEngine: candleProvider(candles), logger });
  const first = engine.calculate('1h', candles.length);
  const second = engine.calculate('1h', candles.length);

  assert.deepEqual(stable(second), stable(first));
});
