const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ANALYTICAL_PATHS,
  GENERATED_RESPONSE_MAX_BYTES,
  createResourceAdmission,
} = require('../../src/core/resourceAdmission');

test('analytical admission owns exactly the four approved route paths', () => {
  assert.deepEqual([...ANALYTICAL_PATHS].sort(), [
    '/analytics',
    '/backtest',
    '/strategy/replay/v2',
    '/validation',
  ]);
});

function responseHarness() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    type(value) {
      this.headers['Content-Type'] = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
}

test('analytical admission has one slot, no queue, and idempotent release', () => {
  const admission = createResourceAdmission();
  const first = admission.acquireAnalytical();
  const second = admission.acquireAnalytical();

  assert.equal(typeof first, 'function');
  assert.equal(second, null);
  assert.deepEqual(admission.getStatus(), {
    activeAnalyticalCount: 1,
    analyticalCapacityRejects: 1,
    responseBudgetRejects: 0,
  });

  first();
  first();
  const third = admission.acquireAnalytical();
  assert.equal(typeof third, 'function');
  third();
  assert.equal(admission.getStatus().activeAnalyticalCount, 0);
});

test('analytical capacity rejection emits bounded operational evidence without changing admission', async () => {
  const events = [];
  const admission = createResourceAdmission({
    logger: {
      record: async event => {
        events.push(event);
        return { status: 'DURABLE_ASYNC_ACCEPTED' };
      },
    },
  });
  const release = admission.acquireAnalytical('/backtest');
  assert.equal(admission.acquireAnalytical('/backtest'), null);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ANALYTICAL_CAPACITY_REJECTED');
  assert.deepEqual(events[0].context, {
    code: 'ANALYTICAL_CAPACITY_EXCEEDED',
    path: '/backtest',
    capacity: 1,
    queueDepth: 1,
  });
  release();
});

test('generated response budget sends one serialized string at the exact boundary', () => {
  const admission = createResourceAdmission();
  const response = responseHarness();
  const emptyBytes = Buffer.byteLength(JSON.stringify({ data: '' }), 'utf8');
  let toJsonCalls = 0;
  const result = {
    data: 'a'.repeat(GENERATED_RESPONSE_MAX_BYTES - emptyBytes),
    toJSON() {
      toJsonCalls++;
      return { data: this.data };
    },
  };

  admission.sendGeneratedJson(response, result);

  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.body, 'string');
  assert.equal(Buffer.byteLength(response.body, 'utf8'), GENERATED_RESPONSE_MAX_BYTES);
  assert.equal(response.headers['Content-Type'], 'json');
  assert.equal(toJsonCalls, 1);
  assert.equal(admission.getStatus().responseBudgetRejects, 0);
});

test('generated response over budget is rejected without publishing the result', () => {
  const admission = createResourceAdmission();
  const response = responseHarness();
  const emptyBytes = Buffer.byteLength(JSON.stringify({ data: '' }), 'utf8');

  admission.sendGeneratedJson(response, {
    data: 'a'.repeat(GENERATED_RESPONSE_MAX_BYTES - emptyBytes + 1),
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    error: 'Response exceeds resource budget',
    code: 'RESPONSE_TOO_LARGE',
  });
  assert.equal(admission.getStatus().responseBudgetRejects, 1);
});
