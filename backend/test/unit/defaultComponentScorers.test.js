const test = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultComponents } = require('../../src/engine/defaultComponentScorers');

const CANDLES = [{ timestamp: 1 }, { timestamp: 2 }];
const CONTEXT = { analysis: null, analyzerTf: '1H', tf: '1h' };

function createComponents({ structureResult, rsiResult, rsiIndicator = true, structureError, rsiError } = {}) {
  const structureEngine = {
    calculate(candles) {
      assert.equal(candles, CANDLES);
      if (structureError) throw structureError;
      return structureResult || { ready: true, score: 80, direction: 'bullish', confidence: 80 };
    },
  };
  const indicatorRegistry = {
    get(name) {
      assert.equal(name, 'RSI');
      if (!rsiIndicator) return null;
      return {
        calculate(candles, tf) {
          assert.equal(candles, CANDLES);
          assert.equal(tf, '1h');
          if (rsiError) throw rsiError;
          return rsiResult || { ready: true, strength: 80, value: 60, state: 'Neutral', confidence: 80 };
        },
      };
    },
  };

  return createDefaultComponents({ structureEngine, indicatorRegistry });
}

function component(components, name) {
  return components.find(definition => definition.name === name);
}

function calculate(components, name, context = CONTEXT, candles = CANDLES, tf = '1h') {
  return component(components, name).calculate(candles, tf, context);
}

test('returns the exact ordered definitions, weights, and keys', () => {
  const components = createComponents();

  assert.deepEqual(components.map(({ name }) => name), ['trend', 'structure', 'momentum', 'rsi', 'volatility']);
  assert.deepEqual(components.map(({ weight }) => weight), [0.30, 0.25, 0.15, 0.15, 0.15]);
  for (const definition of components) {
    assert.deepEqual(Object.keys(definition), ['name', 'weight', 'calculate']);
    assert.equal(typeof definition.calculate, 'function');
  }
});

test('trend preserves missing-data, direction, confidence, rounding, and clamping behavior', () => {
  const components = createComponents();

  assert.deepEqual(calculate(components, 'trend'), {
    score: null, direction: null, available: false, reason: 'No analysis data',
  });
  assert.deepEqual(calculate(components, 'trend', { analysis: { trend: {} }, analyzerTf: '1H' }), {
    score: null, direction: null, available: false, reason: 'No trend data for 1H',
  });
  assert.deepEqual(calculate(components, 'trend', {
    analysis: { trend: { '1H': 'Bullish' }, confidence: { '1H': 81 } }, analyzerTf: '1H',
  }), { score: 93, direction: 'bullish', available: true, confidence: 81 });
  assert.deepEqual(calculate(components, 'trend', {
    analysis: { trend: { '1H': 'Bearish' }, confidence: { '1H': 81 } }, analyzerTf: '1H',
  }), { score: 7, direction: 'bearish', available: true, confidence: 81 });
  assert.deepEqual(calculate(components, 'trend', {
    analysis: { trend: { '1H': 'Sideways' } }, analyzerTf: '1H',
  }), { score: 50, direction: 'sideways', available: true, confidence: 0 });
  assert.deepEqual(calculate(components, 'trend', {
    analysis: { trend: { '1H': 'Bullish' }, confidence: { '1H': 0 } }, analyzerTf: '1H',
  }), { score: 65, direction: 'bullish', available: true, confidence: 0 });
  assert.equal(calculate(components, 'trend', {
    analysis: { trend: { '1H': 'Bullish' }, confidence: { '1H': Infinity } }, analyzerTf: '1H',
  }).score, 100);
});

test('structure preserves dependency identity, arguments, ready output, and errors', () => {
  const structureError = new Error('structure failed');
  const components = createComponents({ structureResult: { ready: false, reason: 'not ready' } });

  assert.deepEqual(calculate(components, 'structure'), {
    score: null, direction: null, available: false, reason: 'not ready',
  });
  assert.deepEqual(calculate(createComponents({ structureResult: {
    ready: true, score: 72, direction: 'bearish', confidence: 61,
  } }), 'structure'), {
    score: 72, direction: 'bearish', available: true, confidence: 61,
  });
  assert.throws(() => calculate(createComponents({ structureError }), 'structure'), {
    message: 'structure failed',
  });
});

test('structure invokes the exact injected engine once with the unchanged arguments', () => {
  const calls = [];
  const structureEngine = {
    calculate(...args) {
      calls.push(args);
      return { ready: true, score: 70, direction: 'bullish', confidence: 75 };
    },
  };
  const components = createDefaultComponents({
    structureEngine,
    indicatorRegistry: { get: () => null },
  });

  const result = calculate(components, 'structure');

  assert.deepEqual(result, { score: 70, direction: 'bullish', available: true, confidence: 75 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0], CANDLES);
});

test('momentum preserves threshold, rounding, clamping, and confidence fallback behavior', () => {
  const components = createComponents();
  const withMomentum = value => ({
    analysis: { momentum: { '1H': value } }, analyzerTf: '1H',
  });

  assert.deepEqual(calculate(components, 'momentum', withMomentum(44.4)), {
    score: 44, direction: 'bearish', available: true, confidence: 50,
  });
  assert.deepEqual(calculate(components, 'momentum', withMomentum(45)), {
    score: 45, direction: 'neutral', available: true, confidence: 50,
  });
  assert.deepEqual(calculate(components, 'momentum', withMomentum(50)), {
    score: 50, direction: 'neutral', available: true, confidence: 50,
  });
  assert.deepEqual(calculate(components, 'momentum', withMomentum(55)), {
    score: 55, direction: 'neutral', available: true, confidence: 50,
  });
  assert.deepEqual(calculate(components, 'momentum', withMomentum(55.6)), {
    score: 56, direction: 'bullish', available: true, confidence: 50,
  });
  assert.equal(calculate(components, 'momentum', withMomentum(-20)).score, 0);
  assert.equal(calculate(components, 'momentum', withMomentum(120)).score, 100);
  assert.deepEqual(calculate(components, 'momentum', {
    analysis: { momentum: { '1H': 60 }, confidence: { '1H': 0 } }, analyzerTf: '1H',
  }), { score: 60, direction: 'bullish', available: true, confidence: 50 });
  assert.deepEqual(calculate(components, 'momentum', {
    analysis: { momentum: {} }, analyzerTf: '1H',
  }), { score: null, direction: null, available: false, reason: 'No momentum data for 1H' });
  assert.deepEqual(calculate(components, 'momentum', {
    analysis: null, analyzerTf: '1H',
  }), { score: null, direction: null, available: false, reason: 'No analysis data' });
});

test('RSI preserves lookup key, arguments, states, direction, fallback, and errors', () => {
  const components = createComponents({ rsiResult: { ready: false, reason: 'insufficient RSI' } });
  assert.deepEqual(calculate(components, 'rsi'), {
    score: null, direction: null, available: false, reason: 'insufficient RSI',
  });
  assert.deepEqual(calculate(createComponents({ rsiResult: {
    ready: true, strength: 80, value: 80, state: 'Overbought', confidence: 80,
  } }), 'rsi'), { score: 80, direction: 'neutral', available: true, confidence: 80 });
  assert.deepEqual(calculate(createComponents({ rsiResult: {
    ready: true, strength: 20, value: 20, state: 'Oversold', confidence: 80,
  } }), 'rsi'), { score: 20, direction: 'neutral', available: true, confidence: 80 });
  assert.deepEqual(calculate(createComponents({ rsiResult: {
    ready: true, strength: 70, value: 60, state: 'Neutral', confidence: 80,
  } }), 'rsi'), { score: 70, direction: 'bullish', available: true, confidence: 80 });
  assert.deepEqual(calculate(createComponents({ rsiResult: {
    ready: true, strength: 30, value: 40, state: 'Neutral', confidence: 80,
  } }), 'rsi'), { score: 30, direction: 'bearish', available: true, confidence: 80 });
  assert.deepEqual(calculate(createComponents({ rsiResult: {
    ready: true, strength: 50, value: 50, state: 'Neutral', confidence: 0,
  } }), 'rsi'), { score: 50, direction: 'neutral', available: true, confidence: 50 });
  assert.deepEqual(calculate(createComponents({ rsiIndicator: false }), 'rsi'), {
    score: null, direction: null, available: false, reason: 'RSI indicator not registered',
  });
  assert.throws(() => calculate(createComponents({ rsiError: new Error('RSI failed') }), 'rsi'), {
    message: 'RSI failed',
  });
});

test('volatility preserves missing data, mappings, alternatives, and confidence semantics', () => {
  const components = createComponents();
  const withVolatility = (volatility, confidence) => ({
    analysis: { volatility: { '1H': volatility }, ...(confidence === undefined ? {} : { confidence: { '1H': confidence } }) },
    analyzerTf: '1H',
  });

  assert.deepEqual(calculate(components, 'volatility'), {
    score: null, direction: null, available: false, reason: 'No analysis data',
  });
  assert.deepEqual(calculate(components, 'volatility', {
    analysis: { volatility: {} }, analyzerTf: '1H',
  }), { score: null, direction: null, available: false, reason: 'No volatility data for 1H' });
  assert.deepEqual(calculate(components, 'volatility', withVolatility('Low', 80)), {
    score: 85, direction: null, available: true, confidence: 80,
  });
  assert.deepEqual(calculate(components, 'volatility', withVolatility('Medium', 0)), {
    score: 50, direction: null, available: true, confidence: 50,
  });
  assert.deepEqual(calculate(components, 'volatility', withVolatility('High')), {
    score: 15, direction: null, available: true, confidence: 50,
  });
});

test('volatility preserves legacy missing-value behavior for all falsy values', () => {
  const components = createComponents();

  for (const value of [undefined, null, '', 0, false]) {
    assert.deepEqual(calculate(components, 'volatility', {
      analysis: { volatility: { '1H': value } }, analyzerTf: '1H',
    }), {
      score: null,
      direction: null,
      available: false,
      reason: 'No volatility data for 1H',
    });
  }
});

test('factory does not mutate injected dependencies or context and is deterministic', () => {
  const structureEngine = { calculate: () => ({ ready: true, score: 50, direction: 'neutral', confidence: 50 }) };
  const indicatorRegistry = { get: () => ({ calculate: () => ({ ready: true, strength: 50, value: 50, state: 'Neutral', confidence: 50 }) }) };
  const context = { analysis: { momentum: { '1H': 50 } }, analyzerTf: '1H', tf: '1h' };
  const beforeContext = JSON.parse(JSON.stringify(context));
  const components = createDefaultComponents({ structureEngine, indicatorRegistry });
  const repeated = components.map(definition => definition.name === 'momentum'
    ? definition.calculate(CANDLES, '1h', context)
    : definition.name === 'structure'
      ? definition.calculate(CANDLES, '1h', context)
      : definition.name === 'rsi'
        ? definition.calculate(CANDLES, '1h', context)
        : definition.calculate(CANDLES, '1h', { ...context, analysis: {
          ...context.analysis,
          trend: { '1H': 'Sideways' },
          volatility: { '1H': 'Medium' },
        } }));

  assert.deepEqual(repeated, components.map(definition => definition.name === 'momentum'
    ? definition.calculate(CANDLES, '1h', context)
    : definition.name === 'structure'
      ? definition.calculate(CANDLES, '1h', context)
      : definition.name === 'rsi'
        ? definition.calculate(CANDLES, '1h', context)
        : definition.calculate(CANDLES, '1h', { ...context, analysis: {
          ...context.analysis,
          trend: { '1H': 'Sideways' },
          volatility: { '1H': 'Medium' },
        } })));
  assert.deepEqual(context, beforeContext);
  assert.deepEqual(Object.keys(structureEngine), ['calculate']);
  assert.deepEqual(Object.keys(indicatorRegistry), ['get']);
});

test('factory returns fresh definitions while preserving order and weights', () => {
  const deps = {
    structureEngine: { calculate: () => ({}) },
    indicatorRegistry: { get: () => null },
  };
  const a = createDefaultComponents(deps);
  const b = createDefaultComponents(deps);

  assert.notEqual(a, b);
  assert.deepEqual(a.map(({ name }) => name), b.map(({ name }) => name));
  assert.deepEqual(a.map(({ weight }) => weight), b.map(({ weight }) => weight));
  for (let index = 0; index < a.length; index++) {
    assert.notEqual(a[index], b[index]);
  }
});
