const test = require('node:test');
const assert = require('node:assert/strict');

const { ComponentRegistry } = require('../../src/engine/componentRegistry');

function component(weight) {
  return { weight, calculate() {} };
}

test('registers and looks up components with the stored object shape', () => {
  const registry = new ComponentRegistry();
  const definition = component(0.3);

  assert.equal(registry.register('trend', definition), registry);
  assert.deepEqual(registry.get('trend'), definition);
  assert.equal(registry.has('trend'), true);
  assert.equal(registry.size, 1);
});

test('returns null for an unknown component', () => {
  assert.equal(new ComponentRegistry().get('missing'), null);
});

test('rejects duplicate names with the exact legacy error', () => {
  const registry = new ComponentRegistry();
  registry.register('trend', component(0.3));

  assert.throws(() => registry.register('trend', component(0.3)), {
    message: "Component 'trend' is already registered",
  });
});

test('rejects invalid calculators with the exact legacy error', () => {
  const registry = new ComponentRegistry();

  assert.throws(() => registry.register('trend', { weight: 0.3, calculate: null }), {
    message: "Component 'trend' must provide a calculate function",
  });
});

test('preserves insertion order for iteration, entries, and values', () => {
  const registry = new ComponentRegistry();
  registry.register('trend', component(0.3));
  registry.register('structure', component(0.25));
  registry.register('momentum', component(0.15));

  assert.deepEqual([...registry].map(([name]) => name), ['trend', 'structure', 'momentum']);
  assert.deepEqual([...registry.entries()].map(([name]) => name), ['trend', 'structure', 'momentum']);
  assert.deepEqual([...registry.values()].map(({ weight }) => weight), [0.3, 0.25, 0.15]);
});

test('reports live size and supports clear followed by registration', () => {
  const registry = new ComponentRegistry();
  registry.register('trend', component(0.3));
  registry.register('structure', component(0.25));

  assert.equal(registry.size, 2);
  assert.equal(registry.clear(), registry);
  assert.equal(registry.size, 0);
  assert.deepEqual([...registry], []);

  registry.register('afterClear', component(1));
  assert.equal(registry.size, 1);
  assert.deepEqual([...registry].map(([name]) => name), ['afterClear']);
});

test('produces identical iteration order for repeated reads', () => {
  const registry = new ComponentRegistry();
  registry.register('trend', component(0.3));
  registry.register('structure', component(0.25));
  registry.register('momentum', component(0.15));

  const first = [...registry].map(([name, value]) => [name, value.weight]);
  const second = [...registry].map(([name, value]) => [name, value.weight]);

  assert.deepEqual(first, second);
});
