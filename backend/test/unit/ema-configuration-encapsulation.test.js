const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EMAIndicator,
  DEFAULT_PERIODS,
} = require('../../src/engine/indicators/ema');
const { createIndicatorRegistry } = require('../../src/engine/indicators');
const { ATREngine } = require('../../src/engine/atr');
const { RegimeEngine } = require('../../src/market-regime/RegimeEngine');
const { createValidationDependencies } = require('../../src/engine/validationDependencies');

const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = {
  get(key) {
    return {
      CONFLUENCE_BULLISH_THRESHOLD: 65,
      CONFLUENCE_BEARISH_THRESHOLD: 35,
    }[key];
  },
};

function makeCandles(count = 250) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return {
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      timestamp: new Date(index * 3600000).toISOString(),
    };
  });
}

function candleEngine(candles) {
  return {
    getCandles(_timeframe, limit) {
      const result = candles.map(candle => ({ ...candle }));
      return limit ? result.slice(-limit) : result;
    },
    getActive() { return null; },
    getAllTimeframes() { return ['1h']; },
  };
}

function stable(result) {
  const copy = { ...result };
  delete copy.calculationTime;
  delete copy.lastUpdated;
  delete copy.calculatedAt;
  return copy;
}

test('EMA default periods are independently owned and immutable', () => {
  const first = new EMAIndicator('BTCUSDT');
  const second = new EMAIndicator('BTCUSDT');

  assert.equal(Object.isFrozen(DEFAULT_PERIODS), true);
  assert.throws(() => DEFAULT_PERIODS.push(7), TypeError);

  const firstInfo = first.getInfo();
  firstInfo.periods[0] = 7;

  assert.deepEqual(first.getPeriods(), [9, 20, 50, 100, 200]);
  assert.deepEqual(second.getPeriods(), [9, 20, 50, 100, 200]);
});

test('EMA getInfo returns a defensive periods copy', () => {
  const engine = new EMAIndicator('BTCUSDT');
  const info = engine.getInfo();

  assert.notStrictEqual(info.periods, engine.getInfo().periods);
  info.periods[0] = 7;
  info.periods.push(300);

  assert.deepEqual(engine.getInfo().periods, [9, 20, 50, 100, 200]);
  assert.deepEqual(engine.getPeriods(), [9, 20, 50, 100, 200]);
});

test('EMA runtime configuration replacement cannot change stored periods', () => {
  const engine = new EMAIndicator('BTCUSDT');

  engine._periods = [7];
  engine.periods = [7];
  engine.config = { periods: [7] };

  assert.deepEqual(engine.getPeriods(), [9, 20, 50, 100, 200]);
  assert.deepEqual(Object.keys(engine.calculateAll(makeCandles(), '1h')), ['9', '20', '50', '100', '200']);
});

test('EMA rejects invalid explicit periods for single and multi-period calculations', () => {
  const engine = new EMAIndicator('BTCUSDT');
  const candles = makeCandles();

  for (const period of [0, -1, 0.5, '5', NaN, Infinity, -Infinity, null]) {
    assert.throws(
      () => engine.calculate(candles, '1h', period),
      { name: 'TypeError', message: 'EMA period must be a finite positive integer' },
    );
  }

  assert.throws(
    () => engine.calculateAll(candles, '1h', [9, 0, 20]),
    { name: 'TypeError', message: 'EMA period must be a finite positive integer' },
  );
  assert.throws(
    () => engine.calculateAll(candles, '1h', '20'),
    { name: 'TypeError', message: 'EMA periods must be an array' },
  );
});

test('EMA repeated calculations remain deterministic and preserve the formula', () => {
  const engine = new EMAIndicator('BTCUSDT');
  const candles = [10, 11, 12, 13, 14, 13, 12, 13, 14, 15].map((close, index) => ({
    close,
    timestamp: new Date(index * 60000).toISOString(),
  }));

  const first = engine.calculate(candles, '1h', 3);
  const second = engine.calculate(candles, '1h', 3);

  assert.equal(first.value, 14.19);
  assert.deepEqual(stable(second), stable(first));
});

test('validation graphs do not share EMA default configuration', () => {
  const first = createValidationDependencies({ config, symbol: 'BTCUSDT' });
  const second = createValidationDependencies({ config, symbol: 'BTCUSDT' });

  first.indicatorRegistry.get('EMA').getInfo().periods[0] = 7;

  assert.deepEqual(first.indicatorRegistry.get('EMA').getPeriods(), [9, 20, 50, 100, 200]);
  assert.deepEqual(second.indicatorRegistry.get('EMA').getPeriods(), [9, 20, 50, 100, 200]);
});

test('production regime output remains stable after EMA configuration mutation attempts', () => {
  const candles = makeCandles();
  const indicatorRegistry = createIndicatorRegistry('BTCUSDT');
  const candleProvider = candleEngine(candles);
  const regime = new RegimeEngine({
    indicatorRegistry,
    atrEngine: new ATREngine({ candleEngine: candleProvider, logger, symbol: 'BTCUSDT' }),
    candleEngine: candleProvider,
    analyzer: { getAnalysis: () => ({ trend: {}, confidence: {} }) },
    logger,
    config,
    symbol: 'BTCUSDT',
  });

  const before = stable(regime.calculate(candles, '1h'));
  indicatorRegistry.get('EMA').getInfo().periods[0] = 7;
  const after = stable(regime.calculate(candles, '1h'));

  assert.deepEqual(after, before);
});
