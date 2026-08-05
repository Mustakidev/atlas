const test = require('node:test');
const assert = require('node:assert/strict');

const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { ReplayCandleEngine } = require('../../src/engine/replayCandleEngine');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { MTFEngine } = require('../../src/engine/mtf');
const { MTFConfirmationEngine } = require('../../src/engine/mtfConfirmation');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const logger = { info() {}, warn() {}, error() {}, system() {} };

function makeConfig() {
  const values = {
    SYMBOL: 'LIVE-SYMBOL',
    CONFLUENCE_BULLISH_THRESHOLD: 65,
    CONFLUENCE_BEARISH_THRESHOLD: undefined,
    UNDEFINED_VALUE: undefined,
  };
  return {
    values,
    get(key) { return this.values[key]; },
    set(key, value) { this.values[key] = value; },
  };
}

function makeInput(count = 52, startTime = BASE_TIME) {
  const candles = Array.from({ length: count }, (_, index) => {
    const openTime = startTime + index * 3600000;
    const close = 100 + index;
    return Object.freeze({
      openTime,
      timestamp: new Date(openTime).toISOString(),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    });
  });
  return Object.freeze({ schemaVersion: 1, timeframe: '1h', candles: Object.freeze(candles) });
}

function makeClock() {
  let monotonic = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => monotonic++,
  };
}

function makeStatefulClock() {
  let monotonic = 0;
  let monotonicReads = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => {
      monotonicReads++;
      return monotonic++;
    },
    getMonotonicReads: () => monotonicReads,
  };
}

function makeBundle(overrides = {}) {
  return createReplayDependencies({
    logger,
    symbol: 'BTCUSDT',
    config: makeConfig(),
    normalizedInput: makeInput(),
    clock: makeClock(),
    ...overrides,
  });
}

function openTrade(engine) {
  return engine.signal({
    trend: { trend: { '1H': 'Bullish' } },
    structure: { ready: true, direction: 'bullish', structure: 'Bullish', score: 80 },
    rsi: { ready: true, value: 70, state: 'Overbought' },
    ema: { ready: true, value: 110, trend: 'Above' },
    macd: { ready: true, trend: 'Bullish', histogram: 1 },
    bollinger: { ready: true, pricePosition: 'Inside Bands' },
    confluence: { bias: 'Bullish', score: 80, confidence: 80 },
    mtf: { overallBias: 'Bullish', timeframeAgreement: 100 },
  }, 100, '1h', 'BUY', { stopLoss: 96, takeProfit: 106, positionSize: 25, riskReward: 2.5 });
}

test('returns the complete replay-local dependency bundle and freezes only the bundle', () => {
  const bundle = makeBundle();
  const keys = [
    'candleEngine', 'indicatorRegistry', 'analyzer', 'structureEngine', 'atrEngine',
    'macdEngine', 'bollingerEngine', 'confluenceEngine', 'regimeEngine',
    'regimeDecisionEngine', 'mtfConfirmationEngine', 'mtfEngine', 'paperTradeEngine',
    'advanceRiskEngine', 'logger', 'config', 'symbol', 'clock', 'clockController',
  ];

  assert.deepEqual(Object.keys(bundle), keys);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.paperTradeEngine), false);
  assert.equal(Object.isFrozen(bundle.advanceRiskEngine), false);
  assert.ok(bundle.candleEngine instanceof ReplayCandleEngine);
  assert.ok(bundle.mtfEngine instanceof MTFEngine);
  assert.ok(bundle.mtfConfirmationEngine instanceof MTFConfirmationEngine);
  assert.ok(bundle.paperTradeEngine instanceof PaperTradingEngine);
  assert.ok(bundle.advanceRiskEngine instanceof AdvanceRiskEngine);
});

test('every mutable dependency is fresh across factory calls', () => {
  const first = makeBundle();
  const second = makeBundle();
  const mutableKeys = [
    'candleEngine', 'indicatorRegistry', 'analyzer', 'structureEngine', 'atrEngine',
    'macdEngine', 'bollingerEngine', 'confluenceEngine', 'regimeEngine',
    'regimeDecisionEngine', 'mtfConfirmationEngine', 'mtfEngine', 'paperTradeEngine',
    'advanceRiskEngine', 'logger', 'config', 'clock', 'clockController',
  ];

  for (const key of mutableKeys) assert.notStrictEqual(first[key], second[key], key);
  assert.strictEqual(first.atrEngine.candleEngine, first.candleEngine);
  assert.strictEqual(first.confluenceEngine.indicatorRegistry, first.indicatorRegistry);
  assert.strictEqual(first.regimeEngine.atrEngine, first.atrEngine);
  assert.strictEqual(first.mtfEngine.confluenceEngine, first.confluenceEngine);
  assert.strictEqual(first.advanceRiskEngine.paperTradeEngine, first.paperTradeEngine);
});

test('same normalized input supports independent candle, paper, risk, MTF, and registry state', () => {
  const normalizedInput = makeInput();
  const first = makeBundle({ normalizedInput });
  const second = makeBundle({ normalizedInput });

  first.candleEngine.nextActive();
  first.candleEngine.finalizeActive();
  assert.equal(first.candleEngine.getCandles('1h').length, 1);
  assert.equal(second.candleEngine.getCandles('1h').length, 0);

  openTrade(first.paperTradeEngine);
  assert.equal(first.paperTradeEngine.open().length, 1);
  assert.equal(second.paperTradeEngine.open().length, 0);

  first.advanceRiskEngine.onTradeClosed(-100);
  assert.equal(first.advanceRiskEngine.getDailyPnL(), -100);
  assert.equal(second.advanceRiskEngine.getDailyPnL(), 0);

  first.mtfConfirmationEngine.enableAggressive();
  assert.equal(first.mtfConfirmationEngine.isAggressive(), true);
  assert.equal(second.mtfConfirmationEngine.isAggressive(), false);

  first.mtfEngine.calculate();
  assert.notEqual(first.mtfEngine.lastUpdated, null);
  assert.equal(second.mtfEngine.lastUpdated, null);

  first.indicatorRegistry.register({ name: 'LOCAL_ONLY', calculate() { return null; } });
  assert.equal(first.indicatorRegistry.has('LOCAL_ONLY'), true);
  assert.equal(second.indicatorRegistry.has('LOCAL_ONLY'), false);
});

test('real runtime calculations use the isolated config snapshot', () => {
  const config = makeConfig();
  config.set('CONFLUENCE_BULLISH_THRESHOLD', 80);
  config.set('CONFLUENCE_BEARISH_THRESHOLD', 20);
  const bundle = makeBundle({ config });

  for (let index = 0; index < 20; index++) {
    bundle.candleEngine.nextActive();
    bundle.candleEngine.finalizeActive();
  }

  const first = bundle.mtfEngine.calculate();
  assert.ok(first);
  assert.equal(bundle.confluenceEngine.config.get('CONFLUENCE_BULLISH_THRESHOLD'), 80);
  assert.equal(bundle.mtfEngine.config.get('CONFLUENCE_BEARISH_THRESHOLD'), 20);

  config.set('CONFLUENCE_BULLISH_THRESHOLD', 1);
  config.set('CONFLUENCE_BEARISH_THRESHOLD', 99);
  const second = bundle.mtfEngine.calculate();
  assert.ok(second);
  assert.equal(bundle.confluenceEngine.config.get('CONFLUENCE_BULLISH_THRESHOLD'), 80);
  assert.equal(bundle.mtfEngine.config.get('CONFLUENCE_BEARISH_THRESHOLD'), 20);
});

test('A -> B -> A creation remains isolated', () => {
  const inputA = makeInput();
  const inputB = makeInput().candles.map(candle => Object.freeze({ ...candle, close: candle.close + 100 }));
  const firstA = makeBundle({ normalizedInput: Object.freeze({ schemaVersion: 1, timeframe: '1h', candles: Object.freeze(inputA.candles) }) });
  makeBundle({ normalizedInput: Object.freeze({ schemaVersion: 1, timeframe: '1h', candles: Object.freeze(inputB) }) }).candleEngine.nextActive();
  const secondA = makeBundle({ normalizedInput: Object.freeze({ schemaVersion: 1, timeframe: '1h', candles: Object.freeze(inputA.candles) }) });

  firstA.candleEngine.nextActive();
  firstA.candleEngine.finalizeActive();
  assert.equal(secondA.candleEngine.getCandles('1h').length, 0);
  assert.equal(secondA.candleEngine.nextActive().close, 100);
});

test('config is snapshotted, read-only, and preserves undefined values', () => {
  const config = makeConfig();
  const bundle = makeBundle({ config });
  config.set('CONFLUENCE_BULLISH_THRESHOLD', 99);
  config.set('CONFLUENCE_BEARISH_THRESHOLD', 35);
  config.set('UNDEFINED_VALUE', 'now-defined');
  config.set('SYMBOL', 'MUTATED');

  assert.equal(bundle.config.get('CONFLUENCE_BULLISH_THRESHOLD'), 65);
  assert.equal(bundle.config.get('CONFLUENCE_BEARISH_THRESHOLD'), undefined);
  assert.equal(bundle.config.get('SYMBOL'), undefined);
  assert.equal(typeof bundle.config.set, 'undefined');
  assert.equal(Object.isFrozen(bundle.config), true);
});

test('logger facade is run-local and does not mutate the supplied logger', () => {
  const supplied = {
    calls: 0,
    info() { this.calls++; },
    warn() { this.calls++; },
    error() { this.calls++; },
  };
  const bundle = makeBundle({ logger: supplied });

  assert.notStrictEqual(bundle.logger, supplied);
  bundle.logger.info('test');
  bundle.logger.warn('test');
  bundle.logger.error('test');
  bundle.logger.system('test');
  assert.equal(supplied.calls, 0);
});

test('PaperTrading and AdvanceRisk share the graph clock semantics', () => {
  const clock = makeClock();
  const bundle = makeBundle({ clock });
  const paperClock = bundle.paperTradeEngine.clock;
  const riskClock = bundle.advanceRiskEngine.clock;
  const later = BASE_TIME + 3600000;

  assert.deepEqual(Object.keys(bundle.clock).sort(), ['monotonicMs', 'nowMs']);
  assert.deepEqual(Object.keys(bundle.clockController), ['advanceTo']);
  assert.equal(Object.isFrozen(bundle.clock), true);
  assert.equal(Object.isFrozen(bundle.clockController), true);
  assert.equal(bundle.clock.nowMs(), BASE_TIME);
  assert.equal(bundle.paperTradeEngine.clock.nowMs(), bundle.advanceRiskEngine.clock.nowMs());
  assert.equal(bundle.advanceRiskEngine.getState().lastUpdated, null);

  bundle.clockController.advanceTo(later);
  assert.equal(bundle.clock.nowMs(), later);
  assert.equal(bundle.paperTradeEngine.clock.nowMs(), later);
  assert.equal(bundle.advanceRiskEngine.clock.nowMs(), later);
  assert.strictEqual(bundle.paperTradeEngine.clock, paperClock);
  assert.strictEqual(bundle.advanceRiskEngine.clock, riskClock);

  const trade = openTrade(bundle.paperTradeEngine);
  assert.equal(trade.entryTime, new Date(later).toISOString());
  const riskResult = bundle.advanceRiskEngine.evaluate({
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 100,
    atr: { ready: true, atr: 1, atrPercentage: 1 },
    direction: 'BUY',
    confluence: { confidence: 80 },
    regime: 'TRENDING_BULL',
  });
  assert.equal(riskResult.timestamp, new Date(later).toISOString());

  const directClock = makeClock();
  const directPaper = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock: directClock });
  const directRisk = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: directPaper,
    config: makeConfig(),
    clock: directClock,
  });
  assert.notStrictEqual(directPaper.clock, directClock);
  assert.notStrictEqual(directRisk.clock, directClock);
});

test('historical candles override default and supplied future wall clocks', () => {
  const defaultClockBundle = makeBundle({ clock: undefined });
  const futureClock = {
    nowMs: () => Date.parse('2099-01-01T00:00:00.000Z'),
    monotonicMs: () => 100,
  };
  const suppliedClockBundle = makeBundle({ clock: futureClock });

  assert.equal(defaultClockBundle.clock.nowMs(), BASE_TIME);
  assert.equal(suppliedClockBundle.clock.nowMs(), BASE_TIME);
  assert.equal(defaultClockBundle.clockController.advanceTo(BASE_TIME), BASE_TIME);
  assert.equal(suppliedClockBundle.clockController.advanceTo(BASE_TIME), BASE_TIME);
});

test('two graphs keep clock state isolated even when supplied the same clock object', () => {
  const suppliedClock = makeStatefulClock();
  const first = makeBundle({ clock: suppliedClock });
  const second = makeBundle({ clock: suppliedClock });
  const sourceReadsAfterConstruction = suppliedClock.getMonotonicReads();
  const later = BASE_TIME + 3600000;
  const firstStart = first.clock.monotonicMs();
  const secondStart = second.clock.monotonicMs();

  assert.notStrictEqual(first.clock, second.clock);
  assert.equal(first.clock.nowMs(), BASE_TIME);
  assert.equal(second.clock.nowMs(), BASE_TIME);
  first.clockController.advanceTo(later);
  assert.equal(first.clock.nowMs(), later);
  assert.equal(second.clock.nowMs(), BASE_TIME);
  assert.equal(suppliedClock.getMonotonicReads(), sourceReadsAfterConstruction);
  assert.equal(first.clock.monotonicMs(), firstStart + 1);
  assert.equal(second.clock.monotonicMs(), secondStart + 1);
  assert.equal(suppliedClock.getMonotonicReads(), sourceReadsAfterConstruction);
});

test('historical clock advancement is idempotent, rejects invalid movement, and preserves monotonic time', () => {
  const bundle = makeBundle();
  const initialMonotonic = bundle.clock.monotonicMs();
  const later = BASE_TIME + 3600000;

  assert.equal(bundle.clockController.advanceTo(BASE_TIME), BASE_TIME);
  assert.equal(bundle.clock.nowMs(), BASE_TIME);
  assert.equal(bundle.clockController.advanceTo(later), later);
  assert.equal(bundle.clockController.advanceTo(later), later);
  assert.equal(bundle.clock.nowMs(), later);

  const nextMonotonic = bundle.clock.monotonicMs();
  assert.ok(nextMonotonic > initialMonotonic);
  assert.equal(bundle.clock.nowMs(), later);

  for (const timestamp of [BASE_TIME - 1, BASE_TIME + 0.5, -1, NaN, Infinity, 8640000000000001]) {
    assert.throws(() => bundle.clockController.advanceTo(timestamp), /historical clock|timestamp/);
  }
  assert.equal(bundle.clock.nowMs(), later);
});

test('factory construction does not call Date.now when a valid clock is supplied', () => {
  const originalNow = Date.now;
  Date.now = () => { throw new Error('Date.now must not be used by replay factory'); };
  try {
    assert.doesNotThrow(() => makeBundle({ clock: makeClock() }));
  } finally {
    Date.now = originalNow;
  }
});

test('historical UTC rollover initializes risk and paper time from the first candle', () => {
  const firstOpenTime = Date.parse('2024-01-01T23:00:00.000Z');
  const nextOpenTime = Date.parse('2024-01-02T00:00:00.000Z');
  const bundle = makeBundle({
    normalizedInput: makeInput(52, firstOpenTime),
    clock: {
      nowMs: () => Date.parse('2099-01-01T00:00:00.000Z'),
      monotonicMs: () => 0,
    },
  });
  const riskParams = {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 100,
    atr: { ready: true, atr: 1, atrPercentage: 1 },
    direction: 'BUY',
    confluence: { confidence: 80 },
    regime: 'TRENDING_BULL',
  };

  assert.equal(bundle.clock.nowMs(), firstOpenTime);
  assert.equal(openTrade(bundle.paperTradeEngine).entryTime, new Date(firstOpenTime).toISOString());
  assert.equal(bundle.advanceRiskEngine.evaluate(riskParams).timestamp, new Date(firstOpenTime).toISOString());
  bundle.advanceRiskEngine.onTradeClosed(-100, { nowMs: firstOpenTime });
  assert.equal(bundle.advanceRiskEngine.getDailyPnL(), -100);

  bundle.clockController.advanceTo(nextOpenTime);
  assert.equal(bundle.clock.nowMs(), nextOpenTime);
  assert.equal(bundle.advanceRiskEngine.evaluate(riskParams).timestamp, new Date(nextOpenTime).toISOString());
  assert.equal(bundle.advanceRiskEngine.getDailyPnL(), 0);
  assert.equal(openTrade(bundle.paperTradeEngine).entryTime, new Date(nextOpenTime).toISOString());
});

test('risk policy is copied through public policy APIs without runtime state', () => {
  const sourcePaper = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock: makeClock() });
  openTrade(sourcePaper);
  const source = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: sourcePaper, config: makeConfig(), clock: makeClock() });
  source.setAccountBalance(25000);
  source.setRiskPerTradePct(2);
  source.setAtrMultTrending(3);
  source.setAtrMultRanging(2);
  source.setRrTrending(4);
  source.setRrRanging(2);
  source.setMaxDailyLossPct(7);
  source.setMaxDailyDrawdownPct(12);
  source.setMaxConsecutiveLosses(5);
  source.setConsecutiveCooldownMs(1234);
  source.setSessionMultiplier('ASIAN', 1.5);
  source.onTradeClosed(-100);
  const sourceState = source.getState();
  const sourcePaperState = sourcePaper.stats();

  const bundle = makeBundle({ riskPolicySource: source });
  assert.deepEqual(bundle.advanceRiskEngine.getPolicy(), {
    accountBalance: 25000,
    riskPerTradePct: 2,
    atrMultTrending: 3,
    atrMultRanging: 2,
    rrTrending: 4,
    rrRanging: 2,
    maxDailyLossPct: 7,
    maxDailyDrawdownPct: 12,
    maxConsecutiveLosses: 5,
    cooldownMs: 1234,
    sessionMultipliers: { ASIAN: 1.5, LONDON: 1, NEW_YORK: 1 },
  });
  assert.equal(bundle.advanceRiskEngine.getDailyPnL(), 0);
  assert.equal(bundle.advanceRiskEngine.getConsecutiveLosses(), 0);
  assert.equal(bundle.advanceRiskEngine.isTradingEnabled(), true);
  assert.notStrictEqual(bundle.advanceRiskEngine.paperTradeEngine, sourcePaper);
  assert.deepEqual(source.getState(), sourceState);
  assert.deepEqual(sourcePaper.stats(), sourcePaperState);
});

test('incomplete and malformed risk policies reject before policy application', () => {
  const source = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: {},
    config: makeConfig(),
    clock: makeClock(),
  });
  const malformed = [
    policy => { delete policy.accountBalance; },
    policy => { policy.accountBalance = Number.NaN; },
    policy => { policy.riskPerTradePct = Infinity; },
    policy => { policy.sessionMultipliers.ASIAN = 6; },
    policy => { delete policy.sessionMultipliers.LONDON; },
    policy => { policy.sessionMultipliers.EXTRA = 1; },
  ];

  for (const mutate of malformed) {
    const policy = source.getPolicy();
    mutate(policy);
    assert.throws(
      () => makeBundle({ riskPolicySource: { getPolicy: () => policy } }),
      /riskPolicySource\.getPolicy\(\) returned invalid|unknown session/,
    );
  }
  assert.equal(source.getDailyPnL(), 0);
  assert.equal(source.getConsecutiveLosses(), 0);
});

test('risk validator accepts every boundary accepted by canonical setters', () => {
  const source = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: {},
    config: makeConfig(),
    clock: makeClock(),
  });
  source.setAccountBalance(1);
  source.setRiskPerTradePct(100);
  source.setMaxDailyLossPct(100);
  source.setMaxDailyDrawdownPct(100);
  source.setMaxConsecutiveLosses(1.5);
  source.setConsecutiveCooldownMs(0.5);
  source.setSessionMultiplier('ASIAN', 0);
  source.setSessionMultiplier('LONDON', 5);
  source.setSessionMultiplier('NEW_YORK', 0);

  const bundle = makeBundle({ riskPolicySource: source });
  const policy = bundle.advanceRiskEngine.getPolicy();
  assert.equal(policy.accountBalance, 1);
  assert.equal(policy.riskPerTradePct, 100);
  assert.equal(policy.maxDailyLossPct, 100);
  assert.equal(policy.maxDailyDrawdownPct, 100);
  assert.equal(policy.maxConsecutiveLosses, 1.5);
  assert.equal(policy.cooldownMs, 0.5);
  assert.deepEqual(policy.sessionMultipliers, { ASIAN: 0, LONDON: 5, NEW_YORK: 0 });
});

test('empty or invalid first historical timestamps reject deterministically', () => {
  const empty = Object.freeze({ schemaVersion: 1, timeframe: '1h', candles: Object.freeze([]) });
  assert.throws(() => makeBundle({ normalizedInput: empty }), /at least one candle/);

  for (const openTime of [undefined, null, NaN, Infinity, -1, 'not-a-timestamp', 1704067200000.5, 8640000000000001]) {
    const input = makeInput();
    const first = { ...input.candles[0], openTime };
    if (openTime === undefined) delete first.openTime;
    const invalid = Object.freeze({
      schemaVersion: 1,
      timeframe: '1h',
      candles: Object.freeze([Object.freeze(first), ...input.candles.slice(1)]),
    });
    assert.throws(() => makeBundle({ normalizedInput: invalid }), /openTime|timestamp/);
  }
});

test('invalid inputs reject deterministically', () => {
  const valid = {
    logger,
    symbol: 'BTCUSDT',
    config: makeConfig(),
    normalizedInput: makeInput(),
    clock: makeClock(),
  };
  const cases = [
    [{ ...valid, symbol: '' }, /symbol must be a non-empty string/],
    [{ ...valid, logger: null }, /logger must be an object/],
    [{ ...valid, config: {} }, /config\.get must be a function/],
    [{ ...valid, normalizedInput: { schemaVersion: 2, timeframe: '1h', candles: valid.normalizedInput.candles } }, /schemaVersion must be 1/],
    [{ ...valid, normalizedInput: { schemaVersion: 1, timeframe: '1h', candles: valid.normalizedInput.candles.slice() } }, /frozen array/],
    [{ ...valid, clock: { nowMs() {} } }, /clock\.monotonicMs must be a function/],
    [{ ...valid, riskPolicySource: {} }, /riskPolicySource\.getPolicy must be a function/],
  ];

  for (const [input, matcher] of cases) assert.throws(() => createReplayDependencies(input), matcher);
});
