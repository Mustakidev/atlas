const test = require('node:test');
const assert = require('node:assert/strict');

const { RSIIndicator } = require('../../src/engine/indicators/rsi');
const { EMAIndicator } = require('../../src/engine/indicators/ema');
const { IndicatorRegistry } = require('../../src/engine/indicators/registry');
const { MACDEngine } = require('../../src/engine/macd');
const { ATREngine } = require('../../src/engine/atr');
const { BollingerEngine } = require('../../src/engine/bollinger');

const logger = { info() {}, warn() {}, error() {}, system() {} };

function makeCandles(closeAt, rangeAt = () => 2, count = 60) {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    const range = rangeAt(index);
    const openTime = index * 3600000;
    return {
      open: close,
      high: close + range,
      low: close - range,
      close,
      volume: 1000 + index,
      openTime,
      timestamp: new Date(openTime).toISOString(),
    };
  });
}

function mutableCandleEngine(initial) {
  let candles = initial;
  return {
    setCandles(next) {
      candles = next;
    },
    getCandles(_timeframe, limit) {
      const result = [...candles];
      return limit && limit > 0 ? result.slice(-limit) : result;
    },
    getActive() {
      return null;
    },
    getAllTimeframes() {
      return ['1h'];
    },
  };
}

const descriptors = [
  {
    name: 'RSI',
    create: () => new RSIIndicator('BTCUSDT'),
    calculate: (engine, candles) => engine.calculate(candles, '1h'),
    mutate: result => { result.value = 999; },
  },
  {
    name: 'EMA',
    create: () => new EMAIndicator('BTCUSDT'),
    calculate: (engine, candles) => engine.calculate(candles, '1h', 20),
    mutate: result => { result.value = 999; },
  },
  {
    name: 'MACD',
    create: candles => new MACDEngine({ candleEngine: candles, logger, symbol: 'BTCUSDT' }),
    calculate: (engine, _candles, limit) => engine.calculate('1h', limit || 60),
    mutate: result => { result.macd = 999; },
  },
  {
    name: 'ATR',
    create: candles => new ATREngine({ candleEngine: candles, logger, symbol: 'BTCUSDT' }),
    calculate: (engine, _candles, limit) => engine.calculate('1h', limit || 60),
    mutate: result => { result.atr = 999; },
  },
  {
    name: 'Bollinger',
    create: candles => new BollingerEngine({ candleEngine: candles, logger, symbol: 'BTCUSDT' }),
    calculate: (engine, _candles, limit) => engine.calculate('1h', limit || 60),
    mutate: result => { result.middleBand = 999; },
  },
];

function withoutTiming(result) {
  const copy = { ...result };
  delete copy.calculationTime;
  delete copy.lastUpdated;
  return copy;
}

const firstDataset = makeCandles(index => 100 + index);
const secondDataset = makeCandles(index => 200 - index, index => index % 2 === 0 ? 1 : 8);
const variedDataset = makeCandles(index => 100 + Math.sin(index * 0.37) * 8 + index * 0.02);

test('different datasets with the same final openTime remain independent', () => {
  for (const descriptor of descriptors) {
    const candleEngine = descriptor.name === 'RSI' || descriptor.name === 'EMA'
      ? null
      : mutableCandleEngine(firstDataset);
    const engine = descriptor.create(candleEngine);
    const first = descriptor.calculate(engine, firstDataset, 60);

    if (candleEngine) candleEngine.setCandles(secondDataset);
    const second = descriptor.calculate(engine, secondDataset, 60);
    const freshEngine = descriptor.create(descriptor.name === 'RSI' || descriptor.name === 'EMA'
      ? null
      : mutableCandleEngine(secondDataset));
    const expected = descriptor.calculate(freshEngine, secondDataset, 60);

    assert.deepEqual(withoutTiming(second), withoutTiming(expected), descriptor.name);
    assert.notDeepEqual(withoutTiming(second), withoutTiming(first), descriptor.name);
    assert.notStrictEqual(first, second, descriptor.name);
  }
});

test('different candle counts are calculated from the requested input', () => {
  const shorter = variedDataset.slice(-40);

  for (const descriptor of descriptors) {
    const candleEngine = descriptor.name === 'RSI' || descriptor.name === 'EMA'
      ? null
      : mutableCandleEngine(variedDataset);
    const engine = descriptor.create(candleEngine);
    descriptor.calculate(engine, variedDataset, 60);

    const second = descriptor.name === 'RSI' || descriptor.name === 'EMA'
      ? descriptor.calculate(engine, shorter, 40)
      : descriptor.calculate(engine, shorter, 40);
    const freshEngine = descriptor.create(descriptor.name === 'RSI' || descriptor.name === 'EMA'
      ? null
      : mutableCandleEngine(variedDataset));
    const expected = descriptor.calculate(freshEngine, shorter, 40);

    assert.deepEqual(withoutTiming(second), withoutTiming(expected), descriptor.name);
    if (descriptor.name !== 'RSI') {
      assert.equal(second.candleCount, 40, descriptor.name);
    }
  }
});

test('current indicator parameters affect the next calculation without invalidation', () => {
  const ema = new EMAIndicator('BTCUSDT');
  ema.calculate(variedDataset, '1h', 20);
  const emaSecond = ema.calculate(variedDataset, '1h', 9);
  const emaExpected = new EMAIndicator('BTCUSDT').calculate(variedDataset, '1h', 9);
  assert.deepEqual(withoutTiming(emaSecond), withoutTiming(emaExpected));

  const macdCandles = mutableCandleEngine(variedDataset);
  const macd = new MACDEngine({ candleEngine: macdCandles, logger, symbol: 'BTCUSDT' });
  macd.calculate('1h', 60);
  macd.fastPeriod = 5;
  macd.slowPeriod = 20;
  macd.signalPeriod = 5;
  const macdSecond = macd.calculate('1h', 60);
  const macdExpectedEngine = new MACDEngine({ candleEngine: mutableCandleEngine(variedDataset), logger, symbol: 'BTCUSDT' });
  macdExpectedEngine.fastPeriod = 5;
  macdExpectedEngine.slowPeriod = 20;
  macdExpectedEngine.signalPeriod = 5;
  assert.deepEqual(withoutTiming(macdSecond), withoutTiming(macdExpectedEngine.calculate('1h', 60)));

  const atrCandles = mutableCandleEngine(variedDataset);
  const atr = new ATREngine({ candleEngine: atrCandles, logger, symbol: 'BTCUSDT' });
  atr.calculate('1h', 60);
  atr.period = 5;
  const atrSecond = atr.calculate('1h', 60);
  const atrExpected = new ATREngine({ candleEngine: mutableCandleEngine(variedDataset), logger, symbol: 'BTCUSDT' });
  atrExpected.period = 5;
  assert.deepEqual(withoutTiming(atrSecond), withoutTiming(atrExpected.calculate('1h', 60)));

  const bollingerCandles = mutableCandleEngine(variedDataset);
  const bollinger = new BollingerEngine({ candleEngine: bollingerCandles, logger, symbol: 'BTCUSDT' });
  bollinger.calculate('1h', 60);
  bollinger.period = 10;
  bollinger.stdDevMultiplier = 3;
  const bollingerSecond = bollinger.calculate('1h', 60);
  const bollingerExpected = new BollingerEngine({ candleEngine: mutableCandleEngine(variedDataset), logger, symbol: 'BTCUSDT' });
  bollingerExpected.period = 10;
  bollingerExpected.stdDevMultiplier = 3;
  assert.deepEqual(withoutTiming(bollingerSecond), withoutTiming(bollingerExpected.calculate('1h', 60)));
});

test('identical calculations return independent result objects', () => {
  for (const descriptor of descriptors) {
    const candleEngine = descriptor.name === 'RSI' || descriptor.name === 'EMA'
      ? null
      : mutableCandleEngine(variedDataset);
    const engine = descriptor.create(candleEngine);
    const first = descriptor.calculate(engine, variedDataset, 60);
    const second = descriptor.calculate(engine, variedDataset, 60);

    assert.notStrictEqual(first, second, descriptor.name);
    assert.deepEqual(withoutTiming(first), withoutTiming(second), descriptor.name);

    descriptor.mutate(first);
    const later = descriptor.calculate(engine, variedDataset, 60);
    assert.deepEqual(withoutTiming(later), withoutTiming(second), descriptor.name);
  }
});

test('invalidate remains callable without being required for correctness', () => {
  for (const descriptor of descriptors) {
    const candleEngine = descriptor.name === 'RSI' || descriptor.name === 'EMA'
      ? null
      : mutableCandleEngine(variedDataset);
    const engine = descriptor.create(candleEngine);
    descriptor.calculate(engine, variedDataset, 60);
    assert.doesNotThrow(() => engine.invalidate('1h'), descriptor.name);
    assert.equal(Object.keys(engine._cache).length, 0, descriptor.name);
  }
});

test('registry wrappers do not share indicator result objects', () => {
  const registry = new IndicatorRegistry();
  registry.register(new RSIIndicator('BTCUSDT'));
  registry.register(new EMAIndicator('BTCUSDT'));

  const first = registry.calculateAll(variedDataset);
  const second = registry.calculateAll(variedDataset);

  assert.notStrictEqual(first.RSI.result, second.RSI.result);
  assert.notStrictEqual(first.EMA.result, second.EMA.result);
  first.EMA.result.value = 999;
  assert.notEqual(second.EMA.result.value, 999);
  assert.strictEqual(registry.get('RSI'), registry.get('RSI'));
});
