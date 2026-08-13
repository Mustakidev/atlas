const test = require('node:test');
const assert = require('node:assert/strict');

const { getFinalizedCandles } = require('../../src/engine/candleUtils');
const { ReplayCandleEngine } = require('../../src/engine/replayCandleEngine');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');
const { createReplayMtfCandleAdapter } = require('../../src/engine/replayMtfCandleAdapter');
const { createReplayCandleView } = require('../../src/engine/replayCandleView');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = REPLAY_MTF_DURATIONS_MS['1h'];
const SECONDARY_TIMEFRAMES = ['1m', '5m', '15m'];

function owner(overrides = {}) {
  return {
    getCandles() { return []; },
    getActive() { return null; },
    ...overrides,
  };
}

function makeCandle(timeframe, openTime, index) {
  const value = 100 + index + (SECONDARY_TIMEFRAMES.indexOf(timeframe) + 1) / 10;
  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    open: value,
    high: value + 1,
    low: value - 1,
    close: value + 0.5,
    volume: index + 1,
  };
}

function normalizedMtfInput() {
  const timeframes = {};
  const primaryCount = 51;
  const horizon = primaryCount * HOUR;
  for (const timeframe of [...SECONDARY_TIMEFRAMES, '1h']) {
    const duration = REPLAY_MTF_DURATIONS_MS[timeframe];
    const count = timeframe === '1h' ? primaryCount : Math.ceil(horizon / duration) + 1;
    timeframes[timeframe] = Array.from({ length: count }, (_, index) =>
      makeCandle(timeframe, BASE_TIME + index * duration, index));
  }
  return normalizeReplayMultiTimeframeInput({
    schemaVersion: 2,
    primaryTimeframe: '1h',
    sourcePolicy: 'independent',
    timeframes,
  });
}

function primaryInput(count = 51) {
  const candles = Array.from({ length: count }, (_, index) => {
    const openTime = BASE_TIME + index * HOUR;
    const value = 100 + index;
    return Object.freeze({
      openTime,
      timestamp: new Date(openTime).toISOString(),
      open: value,
      high: value + 1,
      low: value - 1,
      close: value + 0.5,
      volume: index + 1,
    });
  });
  return Object.freeze({ schemaVersion: 1, timeframe: '1h', candles: Object.freeze(candles) });
}

function realOwners() {
  const normalized = normalizedMtfInput();
  return {
    primary: new ReplayCandleEngine({ timeframe: '1h', candles: primaryInput().candles }),
    secondary: createReplayMtfCandleAdapter(normalized),
  };
}

test('exports exactly the approved single API', () => {
  assert.deepEqual(Object.keys(require('../../src/engine/replayCandleView')), [
    'createReplayCandleView',
  ]);
});

test('returns a frozen facade with exactly the three read methods', () => {
  const view = createReplayCandleView({ primaryEngine: owner(), secondaryAdapter: owner() });

  assert.equal(Object.isFrozen(view), true);
  assert.deepEqual(Object.keys(view), ['getCandles', 'getActive', 'getAllTimeframes']);
  assert.equal('prepareBoundary' in view, false);
  assert.equal('commitBoundary' in view, false);
});

test('rejects owners without the minimal read capability', () => {
  for (const primaryEngine of [null, [], {}, { getActive() {} }, { getCandles() {} }]) {
    assert.throws(
      () => createReplayCandleView({ primaryEngine, secondaryAdapter: owner() }),
      TypeError,
    );
  }
  for (const secondaryAdapter of [null, [], {}, { getActive() {} }, { getCandles() {} }]) {
    assert.throws(
      () => createReplayCandleView({ primaryEngine: owner(), secondaryAdapter }),
      TypeError,
    );
  }
});

test('returns the exact ordered replay discovery list as a fresh array', () => {
  const view = createReplayCandleView({ primaryEngine: owner(), secondaryAdapter: owner() });
  const first = view.getAllTimeframes();
  const second = view.getAllTimeframes();

  assert.deepEqual(first, ['1m', '5m', '15m', '1h']);
  assert.notStrictEqual(first, second);
  first.push('30m');
  assert.deepEqual(view.getAllTimeframes(), ['1m', '5m', '15m', '1h']);
});

test('routes exact secondary candle timeframes without preprocessing', () => {
  const calls = [];
  const primaryResult = [];
  const secondaryResult = [];
  const primary = owner({ getCandles(...args) { calls.push(['primary', args]); return primaryResult; } });
  const secondary = owner({ getCandles(...args) { calls.push(['secondary', args]); return secondaryResult; } });
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });
  const limit = 'unchanged';

  for (const timeframe of ['1m', '5m', '15m']) {
    assert.strictEqual(view.getCandles(timeframe, limit), secondaryResult);
  }
  assert.deepEqual(calls, [
    ['secondary', ['1m', limit]],
    ['secondary', ['5m', limit]],
    ['secondary', ['15m', limit]],
  ]);
});

test('routes 1h to primary and preserves its returned array identity', () => {
  const result = [];
  let received;
  const primary = owner({ getCandles(...args) { received = args; return result; } });
  const secondary = owner({ getCandles() { throw new Error('secondary must not receive 1h'); } });
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });

  assert.strictEqual(view.getCandles('1h', 7), result);
  assert.deepEqual(received, ['1h', 7]);
});

test('routes unsupported and noncanonical inputs to primary unchanged', () => {
  const calls = [];
  const primary = owner({ getCandles(...args) { calls.push(args); return args; } });
  const secondary = owner({ getCandles() { throw new Error('secondary must not receive fallback input'); } });
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });
  const inputs = ['30m', '4h', '12h', '24h', '5M', ' 5m ', '', null, undefined];

  for (const timeframe of inputs) {
    const limit = { timeframe };
    assert.deepEqual(view.getCandles(timeframe, limit), [timeframe, limit]);
  }
  assert.deepEqual(calls, inputs.map(timeframe => [timeframe, { timeframe }]));
});

test('routes active reads using the same exact dispatch rule', () => {
  const calls = [];
  const primaryActive = { owner: 'primary' };
  const secondaryActive = { owner: 'secondary' };
  const primary = owner({ getActive(...args) { calls.push(['primary', args]); return primaryActive; } });
  const secondary = owner({ getActive(...args) { calls.push(['secondary', args]); return secondaryActive; } });
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });

  for (const timeframe of ['1m', '5m', '15m']) assert.strictEqual(view.getActive(timeframe), secondaryActive);
  for (const timeframe of ['1h', '30m', '5M', ' 5m ', undefined]) {
    assert.strictEqual(view.getActive(timeframe), primaryActive);
  }
  assert.deepEqual(calls, [
    ['secondary', ['1m']],
    ['secondary', ['5m']],
    ['secondary', ['15m']],
    ['primary', ['1h']],
    ['primary', ['30m']],
    ['primary', ['5M']],
    ['primary', [' 5m ']],
    ['primary', [undefined]],
  ]);
});

test('does not validate limits or alter owner errors', () => {
  const primaryError = new TypeError('primary limit');
  const secondaryError = new TypeError('secondary limit');
  const primary = owner({ getCandles() { throw primaryError; } });
  const secondary = owner({ getCandles() { throw secondaryError; } });
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });

  assert.throws(() => view.getCandles('1h', 0), error => error === primaryError);
  assert.throws(() => view.getCandles('1m', 0), error => error === secondaryError);
  assert.throws(() => view.getCandles('1m', Symbol('limit')), error => error === secondaryError);
});

test('preserves exact owner errors for active reads', () => {
  const primaryError = new Error('primary active');
  const secondaryError = new Error('secondary active');
  const view = createReplayCandleView({
    primaryEngine: owner({ getActive() { throw primaryError; } }),
    secondaryAdapter: owner({ getActive() { throw secondaryError; } }),
  });

  assert.throws(() => view.getActive('1h'), error => error === primaryError);
  assert.throws(() => view.getActive('5m'), error => error === secondaryError);
});

test('real primary engine remains the 1h owner and retains read identity', () => {
  const { primary, secondary } = realOwners();
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });
  const plan = primary.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  primary.commitBoundary(plan);

  const expected = primary.getCandles('1h');
  assert.deepEqual(view.getCandles('1h'), expected);
  assert.strictEqual(view.getActive('1h'), primary.getActive('1h'));
  assert.equal(view.getActive('1h').openTime, BASE_TIME + HOUR);
});

test('real secondary adapter remains the exact 5m owner', () => {
  const { primary, secondary } = realOwners();
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });
  const before = view.getCandles('5m');

  assert.strictEqual(view.getCandles('5m')[0], before[0]);
  assert.deepEqual(view.getCandles('5m'), []);

  secondary.commitBoundary(secondary.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }));
  const after = view.getCandles('5m');
  assert.equal(after.length, 12);
  assert.strictEqual(after[0], secondary.getCandles('5m')[0]);
  assert.equal(view.getActive('5m').openTime, BASE_TIME + HOUR);
});

test('external owner advancement is visible without view state', () => {
  const primary = owner({
    getCandles() { return primaryState; },
    getActive() { return primaryActive; },
  });
  const secondary = owner({
    getCandles() { return secondaryState; },
    getActive() { return secondaryActive; },
  });
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });
  let primaryState = [];
  let secondaryState = [];
  let primaryActive = null;
  let secondaryActive = null;
  const nextPrimary = [{ openTime: BASE_TIME }];
  const nextSecondary = [{ openTime: BASE_TIME + 1 }];

  assert.strictEqual(view.getCandles('1h'), primaryState);
  assert.strictEqual(view.getCandles('1m'), secondaryState);
  primaryState = nextPrimary;
  secondaryState = nextSecondary;
  primaryActive = { openTime: BASE_TIME + HOUR };
  secondaryActive = { openTime: BASE_TIME + HOUR };
  assert.strictEqual(view.getCandles('1h'), nextPrimary);
  assert.strictEqual(view.getCandles('1m'), nextSecondary);
  assert.strictEqual(view.getActive('1h'), primaryActive);
  assert.strictEqual(view.getActive('1m'), secondaryActive);
});

test('works with getFinalizedCandles for both replay owners without dropping data', () => {
  const { primary, secondary } = realOwners();
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });
  primary.commitBoundary(primary.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }));
  secondary.commitBoundary(secondary.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }));

  const primaryFinalized = getFinalizedCandles(view, '1h');
  const secondaryFinalized = getFinalizedCandles(view, '5m');
  assert.equal(primaryFinalized.length, 1);
  assert.equal(secondaryFinalized.length, 12);
  assert.equal(primaryFinalized.at(-1).openTime, BASE_TIME);
  assert.equal(secondaryFinalized.at(-1).closeTime, BASE_TIME + HOUR);
  assert.equal(view.getActive('1h').openTime, BASE_TIME + HOUR);
  assert.equal(view.getActive('5m').openTime, BASE_TIME + HOUR);
});

test('does not aggregate, fabricate, or mutate either owner', () => {
  const primaryCandles = [{ openTime: BASE_TIME, closeTime: BASE_TIME + HOUR }];
  const secondaryCandles = [{ openTime: BASE_TIME, closeTime: BASE_TIME + 60_000 }];
  const primary = owner({ getCandles: () => primaryCandles, getActive: () => null });
  const secondary = owner({ getCandles: () => secondaryCandles, getActive: () => null });
  const view = createReplayCandleView({ primaryEngine: primary, secondaryAdapter: secondary });

  assert.strictEqual(view.getCandles('1h'), primaryCandles);
  assert.strictEqual(view.getCandles('1m'), secondaryCandles);
  assert.deepEqual(primaryCandles, [{ openTime: BASE_TIME, closeTime: BASE_TIME + HOUR }]);
  assert.deepEqual(secondaryCandles, [{ openTime: BASE_TIME, closeTime: BASE_TIME + 60_000 }]);
});

test('separate views do not share state or owners', () => {
  const firstOwners = realOwners();
  const secondOwners = realOwners();
  const first = createReplayCandleView({ primaryEngine: firstOwners.primary, secondaryAdapter: firstOwners.secondary });
  const second = createReplayCandleView({ primaryEngine: secondOwners.primary, secondaryAdapter: secondOwners.secondary });

  firstOwners.primary.commitBoundary(firstOwners.primary.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }));
  firstOwners.secondary.commitBoundary(firstOwners.secondary.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }));
  assert.equal(first.getCandles('1h').length, 1);
  assert.equal(first.getCandles('5m').length, 12);
  assert.equal(second.getCandles('1h').length, 0);
  assert.equal(second.getCandles('5m').length, 0);
});
