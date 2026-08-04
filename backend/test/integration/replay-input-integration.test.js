const test = require('node:test');
const assert = require('node:assert/strict');

const { StrategyReplayEngine } = require('../../src/engine/strategyReplay');
const { CandleEngine } = require('../../src/engine/candles');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { MTFConfirmationEngine } = require('../../src/engine/mtfConfirmation');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { ReplayInputError } = require('../../src/engine/replayInput');

const logger = { info() {}, warn() {}, error() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  },
};

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');

function makeCandles(length = 51, mutate) {
  return Array.from({ length }, (_, index) => {
    const close = 100 + index;
    const candle = {
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
      timestamp: new Date(BASE_TIME + index * 60000).toISOString(),
    };
    mutate?.(candle, index);
    return candle;
  });
}

function createReplay(overrides = {}) {
  return new StrategyReplayEngine({
    logger,
    symbol: 'BTCUSDT',
    config,
    ...overrides,
  });
}

function runQuietly(replay, candles, timeframe) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return replay.run(candles, timeframe);
  } finally {
    console.log = originalLog;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!['lastUpdated', 'calculationTime', 'timestamp', 'analyzedAt'].includes(key)) {
        result[key] = stable(nested);
      }
    }
    return result;
  }
  return value;
}

test('valid route-shaped replay input succeeds with the existing response keys', () => {
  const candles = makeCandles(51, (candle, index) => {
    candle.openTime = BASE_TIME + index * 60000;
  });

  const result = runQuietly(createReplay(), candles, '1h');

  assert.equal(result.totalCandles, 51);
  assert.equal(result.candlesAnalyzed, 1);
  assert.deepEqual(Object.keys(result), [
    'symbol', 'timeframe', 'totalCandles', 'candlesAnalyzed', 'warmup',
    'trades', 'rejections', 'regimeHistory', 'stats', 'engineVersion',
    'lastUpdated', 'calculationTime', 'dataSource',
  ]);
});

test('normalized candles are used directly by StrategyReplay', () => {
  const candles = makeCandles(51, (candle, index) => {
    if (index === 0) {
      candle.openTime = BASE_TIME;
      delete candle.timestamp;
      candle.extra = 'removed';
    }
  });
  let observedWindow;
  const replay = createReplay();
  replay._runMarketRegime = window => {
    observedWindow = window;
    return {
      regime: 'TRENDING_BULL', confidence: 80, trendScore: 80,
      rangeScore: 20, volatility: 'LOW',
    };
  };

  runQuietly(replay, candles, '1h');

  assert.ok(observedWindow);
  assert.ok(Object.isFrozen(observedWindow[0]));
  assert.equal(observedWindow[0].openTime, BASE_TIME);
  assert.equal(observedWindow[0].timestamp, new Date(BASE_TIME).toISOString());
  assert.equal(Object.hasOwn(observedWindow[0], 'extra'), false);
});

test('normalization does not mutate the input array or candle objects', () => {
  const candles = makeCandles(51);
  const before = JSON.stringify(candles);

  runQuietly(createReplay(), candles, '1h');

  assert.equal(JSON.stringify(candles), before);
  assert.equal(Object.isFrozen(candles), false);
  assert.equal(Object.isFrozen(candles[0]), false);
});

test('timestamp-only candles normalize to canonical UTC identity', () => {
  const candles = makeCandles(51, (candle, index) => {
    if (index === 0) candle.timestamp = '2024-01-01T01:00:00+01:00';
  });
  let observedWindow;
  const replay = createReplay();
  replay._runMarketRegime = window => {
    observedWindow = window;
    return { regime: 'UNKNOWN', confidence: 0, trendScore: 0, rangeScore: 0, volatility: 'LOW' };
  };

  runQuietly(replay, candles, '1h');

  assert.equal(observedWindow[0].openTime, BASE_TIME);
  assert.equal(observedWindow[0].timestamp, '2024-01-01T00:00:00.000Z');
});

test('duplicate timestamps reject deterministically with ReplayInputError details', () => {
  const candles = makeCandles(51, (candle, index) => {
    if (index === 10) candle.timestamp = new Date(BASE_TIME + 9 * 60000).toISOString();
  });

  assert.throws(
    () => runQuietly(createReplay(), candles, '1h'),
    error => error instanceof ReplayInputError
      && error.code === 'DUPLICATE_TIMESTAMP'
      && error.index === 10
      && error.field === 'openTime'
      && error.path === 'candles[10].openTime',
  );
});

test('out-of-order timestamps reject deterministically with ReplayInputError details', () => {
  const candles = makeCandles(51, (candle, index) => {
    if (index === 10) candle.timestamp = new Date(BASE_TIME + 8 * 60000 - 1).toISOString();
  });

  assert.throws(
    () => runQuietly(createReplay(), candles, '1h'),
    error => error instanceof ReplayInputError
      && error.code === 'NON_CHRONOLOGICAL_INPUT'
      && error.index === 10
      && error.field === 'openTime'
      && error.path === 'candles[10].openTime',
  );
});

test('malformed OHLCV rejects with ReplayInputError details', () => {
  const candles = makeCandles(51, candle => {
    candle.high = Number.NaN;
  });

  assert.throws(
    () => runQuietly(createReplay(), candles, '1h'),
    error => error instanceof ReplayInputError
      && error.code === 'INVALID_CANDLE'
      && error.index === 0
      && error.field === 'high'
      && error.path === 'candles[0].high',
  );
});

test('invalid timestamp rejects with structured ReplayInputError details', () => {
  const candles = makeCandles(51, candle => {
    candle.timestamp = 'not-a-date';
  });

  assert.throws(
    () => runQuietly(createReplay(), candles, '1h'),
    error => error instanceof ReplayInputError
      && error.code === 'INVALID_TIMESTAMP'
      && error.index === 0
      && error.field === 'timestamp'
      && error.path === 'candles[0].timestamp',
  );
});

test('invalid timeframe uses ReplayInputError while the route boundary remains unchanged', () => {
  assert.throws(
    () => runQuietly(createReplay(), makeCandles(), '2h'),
    error => error instanceof ReplayInputError
      && error.code === 'INVALID_TIMEFRAME',
  );
});

test('valid input applies the normalizer timeframe contract', () => {
  const replay = createReplay();

  const defaulted = runQuietly(replay, makeCandles(), undefined);
  assert.equal(defaulted.timeframe, '1h');

  for (const timeframe of ['', ' ', null, 60, '2h']) {
    assert.throws(
      () => runQuietly(replay, makeCandles(), timeframe),
      error => error instanceof ReplayInputError
        && error.code === 'INVALID_TIMEFRAME',
    );
  }
});

test('non-array, empty, and short input preserve the existing fallback contract', () => {
  const replay = createReplay();
  const expectedKeys = [
    'symbol', 'timeframe', 'totalCandles', 'candlesAnalyzed', 'warmup',
    'trades', 'rejections', 'stats', 'reason', 'engineVersion',
    'lastUpdated', 'calculationTime', 'dataSource',
  ];

  const nonArray = runQuietly(replay, null, null);
  const empty = runQuietly(replay, [], '');
  const short = runQuietly(replay, makeCandles(50), 60);

  assert.deepEqual(Object.keys(nonArray), expectedKeys);
  assert.deepEqual(Object.keys(empty), expectedKeys);
  assert.deepEqual(Object.keys(short), expectedKeys);
  assert.equal(nonArray.reason, 'No candle data provided');
  assert.equal(empty.reason, 'No candle data provided');
  assert.equal(short.reason, 'Insufficient candles (50/51 minimum)');
  assert.equal(nonArray.timeframe, '1h');
  assert.equal(empty.timeframe, '1h');
  assert.equal(short.timeframe, 60);
  assert.equal(nonArray.totalCandles, 0);
  assert.equal(empty.totalCandles, 0);
  assert.equal(short.totalCandles, 0);
});

test('normalization runs before replay dependency construction', () => {
  const replay = createReplay();
  replay._createReplayDependencies = () => {
    throw new Error('replay dependencies must not be created');
  };
  const malformed = makeCandles(51, candle => {
    candle.volume = -1;
  });

  assert.throws(
    () => runQuietly(replay, malformed, '1h'),
    error => error instanceof ReplayInputError
      && error.code === 'INVALID_VOLUME',
  );
});

test('normalization does not mutate live CandleEngine, PaperTrading, AdvanceRisk, or MTF state', () => {
  const candleEngine = new CandleEngine(config, logger, 'BTCUSDT');
  const paperTradeEngine = new PaperTradingEngine({ logger, symbol: 'BTCUSDT' });
  const advanceRiskEngine = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine,
    config,
  });
  const mtfEngine = new MTFConfirmationEngine({ logger, symbol: 'BTCUSDT', config });
  const liveState = {
    candle: { allTimeframes: candleEngine.getAllTimeframes(), candles: candleEngine.getCandles('1h'), active: candleEngine.getActive('1h') },
    paper: { balance: paperTradeEngine.getBalance(), open: paperTradeEngine.open(), closed: paperTradeEngine.closed() },
    risk: advanceRiskEngine.getState(),
    mtf: { aggressive: mtfEngine.isAggressive(), info: mtfEngine.getInfo() },
  };
  const candles = makeCandles(51);
  const replay = createReplay({ riskPolicySource: advanceRiskEngine });

  runQuietly(replay, candles, '1h');

  assert.deepEqual({
    candle: { allTimeframes: candleEngine.getAllTimeframes(), candles: candleEngine.getCandles('1h'), active: candleEngine.getActive('1h') },
    paper: { balance: paperTradeEngine.getBalance(), open: paperTradeEngine.open(), closed: paperTradeEngine.closed() },
    risk: advanceRiskEngine.getState(),
    mtf: { aggressive: mtfEngine.isAggressive(), info: mtfEngine.getInfo() },
  }, liveState);
});

test('repeated identical valid runs remain deterministic', () => {
  const replay = createReplay();
  const candles = makeCandles(51);

  const first = runQuietly(replay, candles, '1h');
  const second = runQuietly(replay, candles, '1h');

  assert.deepEqual(stable(second), stable(first));
});
