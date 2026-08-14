const test = require('node:test');
const assert = require('node:assert/strict');

const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { ReplayMtfCandleAdapterError } = require('../../src/engine/replayMtfCandleAdapter');
const {
  normalizeReplayInput,
} = require('../../src/engine/replayInput');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');
const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = REPLAY_MTF_DURATIONS_MS['1h'];
const SECONDARY_TIMEFRAMES = ['1m', '5m', '15m'];
const LEGACY_KEYS = [
  'candleEngine', 'indicatorRegistry', 'analyzer', 'analyzerHistory',
  'replayAnalyzerOrchestrator', 'structureEngine', 'atrEngine',
  'macdEngine', 'bollingerEngine', 'confluenceEngine', 'regimeEngine',
  'regimeDecisionEngine', 'mtfConfirmationEngine', 'mtfEngine', 'paperTradeEngine',
  'advanceRiskEngine', 'logger', 'config', 'symbol', 'clock', 'clockController',
];
const COHERENCE_PREFIX = 'Replay MTF primary coherence mismatch:';

const logger = { info() {}, warn() {}, error() {}, system() {} };

function makeConfig() {
  return {
    get(key) {
      if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
      if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
      if (key === 'MAX_HISTORY') return 500;
      return undefined;
    },
  };
}

function makeAnalyzerInput() {
  return normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: 'BTCUSDT',
    snapshots: [{
      timestamp: new Date(BASE_TIME).toISOString(),
      price: 100,
      volume: 1,
      change24h: 0,
    }],
  });
}

function makePrimaryRaw(count = 51) {
  return Array.from({ length: count }, (_, index) => {
    const openTime = BASE_TIME + index * HOUR;
    const open = 100 + index;
    return {
      openTime,
      timestamp: new Date(openTime).toISOString(),
      open,
      high: open + 1,
      low: open - 1,
      close: open + 0.5,
      volume: index + 1,
    };
  });
}

function makePrimaryInput() {
  return normalizeReplayInput(makePrimaryRaw());
}

function makeMtfInput(primaryRaw = makePrimaryRaw()) {
  const primaryHorizon = primaryRaw.length * HOUR;
  const timeframes = {};

  for (const timeframe of [...SECONDARY_TIMEFRAMES, '1h']) {
    const duration = REPLAY_MTF_DURATIONS_MS[timeframe];
    const count = Math.ceil(primaryHorizon / duration);
    timeframes[timeframe] = Array.from({ length: count }, (_, index) => {
      if (timeframe === '1h') return { ...primaryRaw[index] };

      const openTime = BASE_TIME + index * duration;
      const open = 200 + index;
      return {
        openTime,
        timestamp: new Date(openTime).toISOString(),
        open,
        high: open + 1,
        low: open - 1,
        close: open + 0.5,
        volume: index + 1,
      };
    });
  }

  return normalizeReplayMultiTimeframeInput({
    schemaVersion: 2,
    primaryTimeframe: '1h',
    sourcePolicy: 'independent',
    timeframes,
  });
}

function makeClock() {
  let monotonic = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => monotonic++,
  };
}

function makeBundle(overrides = {}) {
  return createReplayDependencies({
    logger,
    symbol: 'BTCUSDT',
    config: makeConfig(),
    normalizedInput: makePrimaryInput(),
    analyzerInput: makeAnalyzerInput(),
    clock: makeClock(),
    ...overrides,
  });
}

function makeMtfVariant(input, mutatePrimary) {
  const primary = input.timeframes['1h'].map((candle, index) => Object.freeze({
    ...candle,
    ...mutatePrimary(candle, index),
  }));
  return Object.freeze({
    ...input,
    timeframes: Object.freeze({
      ...input.timeframes,
      '1h': Object.freeze(primary),
    }),
  });
}

function makeMalformedMtfInput(input) {
  const secondary = input.timeframes['5m'].map((candle, index) => index === 0
    ? Object.freeze({ ...candle, closeTime: undefined })
    : candle);
  return Object.freeze({
    ...input,
    timeframes: Object.freeze({
      ...input.timeframes,
      '5m': Object.freeze(secondary),
    }),
  });
}

function commitBoundary(owner, boundaryTime) {
  owner.commitBoundary(owner.prepareBoundary({ boundaryTime }));
}

function withoutDiagnostics(result) {
  const {
    lastUpdated,
    analysisTime,
    calculationTime,
    ...stableResult
  } = result;
  return stableResult;
}

test('legacy factory shape remains exactly 21 keys and excludes MTF dependencies', () => {
  const bundle = makeBundle();

  assert.deepEqual(Object.keys(bundle), LEGACY_KEYS);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.hasOwn(bundle, 'replayMtfCandleAdapter'), false);
  assert.equal(Object.hasOwn(bundle, 'replayCandleView'), false);
});

test('valid real normalized MTF input returns an exact 23-key opt-in bundle', () => {
  const bundle = makeBundle({ normalizedMtfInput: makeMtfInput() });

  assert.deepEqual(Object.keys(bundle), [
    ...LEGACY_KEYS,
    'replayMtfCandleAdapter',
    'replayCandleView',
  ]);
  assert.equal(Object.isFrozen(bundle), true);
  assert.deepEqual(bundle.replayMtfCandleAdapter.getCandles('5m'), []);
  assert.equal(bundle.replayMtfCandleAdapter.getActive('5m'), null);
  assert.deepEqual(bundle.replayCandleView.getCandles('1h'), []);
  assert.equal(bundle.replayCandleView.getActive('1h'), null);
});

test('view delegates 1h and 5m reads to the exact primary and secondary owners', () => {
  const bundle = makeBundle({ normalizedMtfInput: makeMtfInput() });
  const boundaryTime = BASE_TIME + HOUR;

  commitBoundary(bundle.candleEngine, boundaryTime);
  assert.deepEqual(bundle.replayCandleView.getCandles('1h'), bundle.candleEngine.getCandles('1h'));
  assert.strictEqual(
    bundle.replayCandleView.getActive('1h'),
    bundle.candleEngine.getActive('1h'),
  );

  commitBoundary(bundle.replayMtfCandleAdapter, boundaryTime);
  assert.deepEqual(
    bundle.replayCandleView.getCandles('5m'),
    bundle.replayMtfCandleAdapter.getCandles('5m'),
  );
  assert.strictEqual(
    bundle.replayCandleView.getActive('5m'),
    bundle.replayMtfCandleAdapter.getActive('5m'),
  );
});

test('opt-in graphs are isolated and do not mutate frozen source inputs', () => {
  const normalizedInput = makePrimaryInput();
  const normalizedMtfInput = makeMtfInput();
  const inputSnapshot = structuredClone({ normalizedInput, normalizedMtfInput });
  const first = makeBundle({ normalizedInput, normalizedMtfInput });
  const second = makeBundle({ normalizedInput, normalizedMtfInput });

  assert.notStrictEqual(first.candleEngine, second.candleEngine);
  assert.notStrictEqual(first.replayMtfCandleAdapter, second.replayMtfCandleAdapter);
  assert.notStrictEqual(first.replayCandleView, second.replayCandleView);

  commitBoundary(first.candleEngine, BASE_TIME + HOUR);
  commitBoundary(first.replayMtfCandleAdapter, BASE_TIME + HOUR);

  assert.equal(second.candleEngine.getCandles('1h').length, 0);
  assert.equal(second.candleEngine.getActive('1h'), null);
  assert.equal(second.replayMtfCandleAdapter.getCandles('5m').length, 0);
  assert.equal(second.replayMtfCandleAdapter.getActive('5m'), null);
  assert.deepEqual({ normalizedInput, normalizedMtfInput }, inputSnapshot);
});

test('existing graph consumers remain primary-backed and secondary advancement is isolated', () => {
  const legacy = makeBundle();
  const optIn = makeBundle({ normalizedMtfInput: makeMtfInput() });

  for (const consumer of [
    optIn.atrEngine,
    optIn.macdEngine,
    optIn.bollingerEngine,
    optIn.confluenceEngine,
    optIn.regimeEngine,
  ]) {
    assert.strictEqual(consumer.candleEngine, optIn.candleEngine);
    assert.notStrictEqual(consumer.candleEngine, optIn.replayCandleView);
  }
  assert.strictEqual(legacy.mtfEngine.candleEngine, legacy.candleEngine);
  assert.strictEqual(optIn.mtfEngine.candleEngine, optIn.replayCandleView);
  assert.notStrictEqual(optIn.mtfEngine.candleEngine, optIn.candleEngine);

  assert.deepEqual(optIn.candleEngine.getCandles('1h'), legacy.candleEngine.getCandles('1h'));
  assert.deepEqual(
    withoutDiagnostics(optIn.atrEngine.calculate('1h')),
    withoutDiagnostics(legacy.atrEngine.calculate('1h')),
  );
  assert.deepEqual(
    withoutDiagnostics(optIn.macdEngine.calculate('1h')),
    withoutDiagnostics(legacy.macdEngine.calculate('1h')),
  );
  assert.deepEqual(
    withoutDiagnostics(optIn.bollingerEngine.calculate('1h')),
    withoutDiagnostics(legacy.bollingerEngine.calculate('1h')),
  );
  const mtfBeforeSecondary = withoutDiagnostics(optIn.mtfEngine.calculate());
  assert.deepEqual(
    mtfBeforeSecondary,
    withoutDiagnostics(legacy.mtfEngine.calculate()),
  );

  commitBoundary(optIn.replayMtfCandleAdapter, BASE_TIME + 2 * HOUR);
  assert.deepEqual(optIn.candleEngine.getCandles('1h'), legacy.candleEngine.getCandles('1h'));
  assert.equal(optIn.candleEngine.getActive('1h'), legacy.candleEngine.getActive('1h'));
  const mtfAfterSecondary = withoutDiagnostics(optIn.mtfEngine.calculate());
  assert.equal(mtfAfterSecondary.timeframes['5m'].candleCount > 0, true);
  assert.deepEqual(mtfAfterSecondary.timeframes['1h'], mtfBeforeSecondary.timeframes['1h']);
});

test('coherence rejects each indexed primary mismatch with the stable TypeError prefix', () => {
  const valid = makeMtfInput();
  const cases = [
    ['length', input => Object.freeze({
      ...input,
      timeframes: Object.freeze({
        ...input.timeframes,
        '1h': Object.freeze(input.timeframes['1h'].slice(0, -1)),
      }),
    })],
    ['openTime', input => makeMtfVariant(input, () => ({ openTime: BASE_TIME + 123 }))],
    ['timestamp', input => makeMtfVariant(input, () => ({ timestamp: '2024-01-01T00:00:00.001Z' }))],
    ['open', input => makeMtfVariant(input, candle => ({ open: candle.open + 1 }))],
    ['high', input => makeMtfVariant(input, candle => ({ high: candle.high + 1 }))],
    ['low', input => makeMtfVariant(input, candle => ({ low: candle.low + 1 }))],
    ['close', input => makeMtfVariant(input, candle => ({ close: candle.close + 1 }))],
    ['volume', input => makeMtfVariant(input, candle => ({ volume: candle.volume + 1 }))],
    ['closeTime', input => makeMtfVariant(input, candle => ({ closeTime: candle.closeTime + 1 }))],
    ['ordering', input => makeMtfVariant(input, (_candle, index) => index < 2
      ? { ...input.timeframes['1h'][index === 0 ? 1 : 0] }
      : {})],
  ];

  for (const [field, variant] of cases) {
    assert.throws(
      () => makeBundle({ normalizedMtfInput: variant(valid) }),
      error => error instanceof TypeError
        && !(error instanceof ReplayMtfCandleAdapterError)
        && error.message.startsWith(COHERENCE_PREFIX),
      field,
    );
  }
});

test('coherence rejects a malformed schema-v2 1h witness without leaking a native TypeError', () => {
  const valid = makeMtfInput();
  const normalizedMtfInput = Object.freeze({
    ...valid,
    timeframes: Object.freeze({
      ...valid.timeframes,
      '1h': Object.freeze([null, ...valid.timeframes['1h'].slice(1)]),
    }),
  });

  assert.throws(
    () => makeBundle({ normalizedMtfInput }),
    error => error instanceof TypeError
      && !(error instanceof ReplayMtfCandleAdapterError)
      && error.message.startsWith(COHERENCE_PREFIX)
      && !error.message.includes('Cannot read properties of null'),
  );
});

test('R1 structural failures propagate unchanged and null takes the opt-in path', () => {
  const valid = makeMtfInput();

  for (const input of [null, makeMalformedMtfInput(valid)]) {
    assert.throws(
      () => makeBundle({ normalizedMtfInput: input }),
      error => error instanceof ReplayMtfCandleAdapterError
        && error.name === 'ReplayMtfCandleAdapterError'
        && error.code === 'INVALID_INPUT',
    );
  }
});

test('existing schema-v1 primary validation runs before MTF opt-in validation', () => {
  const valid = makePrimaryInput();
  const invalidPrimary = Object.freeze({ ...valid, schemaVersion: 2 });

  assert.throws(
    () => makeBundle({ normalizedInput: invalidPrimary, normalizedMtfInput: makeMtfInput() }),
    error => error instanceof TypeError
      && !(error instanceof ReplayMtfCandleAdapterError)
      && error.message === 'normalizedInput.schemaVersion must be 1',
  );
});

test('opt-in graph keeps Analyzer graph construction and source semantics separate', () => {
  const legacy = makeBundle();
  const optIn = makeBundle({ normalizedMtfInput: makeMtfInput() });

  assert.notStrictEqual(legacy.analyzer, optIn.analyzer);
  assert.notStrictEqual(legacy.analyzerHistory, optIn.analyzerHistory);
  assert.notStrictEqual(legacy.replayAnalyzerOrchestrator, optIn.replayAnalyzerOrchestrator);
  assert.deepEqual(legacy.analyzerHistory.all(), optIn.analyzerHistory.all());
  assert.deepEqual(legacy.analyzer.getAnalysis(), optIn.analyzer.getAnalysis());
});
