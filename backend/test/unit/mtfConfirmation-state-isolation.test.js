const test = require('node:test');
const assert = require('node:assert/strict');

const { MTFConfirmationEngine } = require('../../src/engine/mtfConfirmation');

const logger = { info() {}, warn() {}, error() {} };
const config = { get() { return undefined; } };

function makeEngine() {
  return new MTFConfirmationEngine({ logger, symbol: 'BTCUSDT', config });
}

function mixedTimeframes() {
  return {
    '1m': { confluence: { bias: 'Bearish', score: 30, confidence: 60 } },
    '5m': { confluence: { bias: 'Bullish', score: 70, confidence: 60 } },
    '15m': { confluence: { bias: 'Bullish', score: 80, confidence: 75 } },
    '1h': { confluence: { bias: 'Bullish', score: 85, confidence: 80 } },
  };
}

function request(aggressive) {
  return {
    direction: 'BUY',
    timeframe: '1h',
    timeframes: mixedTimeframes(),
    ...(aggressive === undefined ? {} : { aggressive }),
  };
}

function decision(result) {
  return {
    aggressive: result.aggressive,
    mtfAllowed: result.mtfAllowed,
    alignmentScore: result.alignmentScore,
    blockedBy: result.blockedBy,
    rejectionReason: result.rejectionReason,
    confidence: result.confidence,
  };
}

test('normal -> aggressive -> normal is isolated on one engine', () => {
  const engine = makeEngine();
  const firstNormal = engine.evaluate(request(false));
  const aggressive = engine.evaluate(request(true));
  const finalNormal = engine.evaluate(request(false));
  const cleanNormal = makeEngine().evaluate(request(false));

  assert.deepEqual(decision(finalNormal), decision(cleanNormal));
  assert.deepEqual(decision(finalNormal), {
    aggressive: false,
    mtfAllowed: false,
    alignmentScore: 75,
    blockedBy: ['1m=Bearish (does not confirm)'],
    rejectionReason: 'MTF Confirmation: blocked by 1m=Bearish (does not confirm)',
    confidence: 60,
  });
  assert.equal(firstNormal.aggressive, false);
  assert.equal(aggressive.aggressive, true);
  assert.equal(aggressive.mtfAllowed, true);
});

test('aggressive -> normal matches a fresh clean-control engine', () => {
  const reused = makeEngine();
  reused.evaluate(request(true));

  const normal = reused.evaluate(request(false));
  const clean = makeEngine().evaluate(request(false));

  assert.deepEqual(decision(normal), decision(clean));
});

test('alternating explicit modes remain deterministic across repeated calls', () => {
  const engine = makeEngine();
  const modes = [false, true, false, true, false, true];
  const results = modes.map(mode => decision(engine.evaluate(request(mode))));

  assert.deepEqual(results.map(result => result.aggressive), modes);
  assert.deepEqual(results.map(result => result.mtfAllowed), [false, true, false, true, false, true]);
  assert.deepEqual(results.map(result => result.alignmentScore), [75, 100, 75, 100, 75, 100]);
  assert.equal(results[2].confidence, results[1].confidence);
});

test('explicit false resets a prior aggressive request without changing legacy configuration', () => {
  const engine = makeEngine();

  engine.evaluate(request(true));
  const normal = engine.evaluate(request(false));

  assert.equal(normal.aggressive, false);
  assert.equal(normal.mtfAllowed, false);
  assert.equal(engine.isAggressive(), false);
});

test('omitted mode preserves setter configuration while per-call mode does not mutate it', () => {
  const engine = makeEngine();
  engine.enableAggressive();

  const omittedAggressive = engine.evaluate(request());
  const explicitNormal = engine.evaluate(request(false));

  assert.equal(omittedAggressive.aggressive, true);
  assert.equal(omittedAggressive.mtfAllowed, true);
  assert.equal(explicitNormal.aggressive, false);
  assert.equal(explicitNormal.mtfAllowed, false);

  engine.disableAggressive();
  engine.evaluate(request(true));
  assert.equal(engine.isAggressive(), false);
  assert.equal(engine.evaluate(request()).aggressive, false);
});

test('an exception during evaluation does not contaminate the following normal call', () => {
  const engine = makeEngine();
  const original = engine._evaluateAlignment;
  engine._evaluateAlignment = () => { throw new Error('controlled MTF failure'); };

  assert.throws(() => engine.evaluate(request(true)), /controlled MTF failure/);
  engine._evaluateAlignment = original;

  const normal = engine.evaluate(request(false));
  assert.deepEqual(decision(normal), decision(makeEngine().evaluate(request(false))));
});

test('reentrant evaluations retain their own explicit modes', () => {
  const engine = makeEngine();
  const original = engine._evaluateAlignment.bind(engine);
  let nested;
  let entered = false;

  engine._evaluateAlignment = (...args) => {
    if (!entered) {
      entered = true;
      nested = decision(engine.evaluate(request(false)));
    }
    return original(...args);
  };

  const outer = decision(engine.evaluate(request(true)));

  assert.equal(nested.aggressive, false);
  assert.equal(nested.mtfAllowed, false);
  assert.equal(outer.aggressive, true);
  assert.equal(outer.mtfAllowed, true);
});

test('normal and aggressive alignment semantics remain unchanged', () => {
  const allBullish = {
    '1m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '5m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '15m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '1h': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
  };
  const bothHtfOppose = {
    '1m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '5m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '15m': { confluence: { bias: 'Bearish', score: 30, confidence: 70 } },
    '1h': { confluence: { bias: 'Bearish', score: 30, confidence: 70 } },
  };
  const evaluate = (timeframes, aggressive) => makeEngine().evaluate({ direction: 'BUY', timeframe: '1h', timeframes, aggressive });

  assert.equal(evaluate(allBullish, false).mtfAllowed, true);
  assert.equal(evaluate(allBullish, true).mtfAllowed, true);
  assert.equal(evaluate(mixedTimeframes(), false).mtfAllowed, false);
  assert.equal(evaluate(mixedTimeframes(), true).mtfAllowed, true);
  assert.equal(evaluate(bothHtfOppose, false).mtfAllowed, false);
  assert.equal(evaluate(bothHtfOppose, true).mtfAllowed, false);
  assert.equal(evaluate(mixedTimeframes(), false).confidence, evaluate(mixedTimeframes(), true).confidence);
});
