const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EVENT_REGISTRY,
  Logger,
  StructuredLoggerError,
} = require('../../src/logger/logger');
const { DurableLogStore } = require('../../src/logger/durableLogStore');
const { REDACTED } = require('../../src/logger/redaction');

function makeConfig(overrides = {}) {
  const values = {
    LOG_LEVEL: 'INFO',
    API_KEY: 'api-secret-value',
    ATLAS_OPERATOR_PASSWORD_HASH: 'password-hash-secret',
    COINGECKO_API_KEY: 'provider-secret',
    ATLAS_LOG_FILE_PATH: undefined,
    ...overrides,
  };
  return { get: key => values[key] };
}

async function withTempDirectory(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph11a-'));
  try {
    return await callback(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

function silentConsole() {
  return { log() {}, error() {} };
}

test('registry contains only the locked minimum durable event set', () => {
  assert.deepEqual(Object.keys(EVENT_REGISTRY).sort(), [
    'ANALYTICAL_CAPACITY_REJECTED',
    'ATLAS_READY',
    'ATLAS_SHUTDOWN',
    'ATLAS_STARTING',
    'AUDIT_UNSAFE',
    'AUTH_LOGIN_FAILED',
    'AUTH_LOGIN_SUCCEEDED',
    'AUTH_LOGOUT',
    'DURABILITY_UNSAFE',
    'LIVE_MUTATION_COMMITTED',
    'LIVE_MUTATION_INTENT',
    'LIVE_STATE_INITIALIZED',
    'PAPER_TRADE_CLOSE_COMMITTED',
    'PAPER_TRADE_CLOSE_INTENT',
    'STATE_QUEUE_FULL',
  ].sort());
});

test('structured record is canonical, logger-owned, and allow-listed', async () => {
  await withTempDirectory(async directory => {
    const store = new DurableLogStore({ filePath: path.join(directory, 'events.jsonl') });
    const logger = new Logger(makeConfig(), { store, console: silentConsole() });
    await logger.initialize();
    const result = await logger.record({
      level: 'INFO',
      event: 'PAPER_TRADE_CLOSE_COMMITTED',
      source: 'test',
      category: 'audit',
      durability: 'DURABLE_CRITICAL',
      message: 'close committed',
      context: {
        tradeId: 'PT-1',
        outcome: 'CLOSED',
        ignored: 'must not persist',
      },
      mutationSequence: 3,
    });

    assert.equal(result.status, 'DURABLE_CRITICAL_CERTIFIED');
    assert.equal(result.record.schemaVersion, 1);
    assert.match(result.record.eventId, /^[0-9a-f-]{36}$/);
    assert.equal(typeof result.record.timestamp, 'string');
    assert.deepEqual(result.record.context, {
      tradeId: 'PT-1',
      outcome: 'CLOSED',
    });
    assert.equal(Object.hasOwn(result.record, 'timestamp'), true);
    await logger.close();
  });
});

test('structured message and context bounds reject only the first oversized byte', async () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  const exactMessage = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    durability: 'MEMORY_ONLY',
    message: 'm'.repeat(2048),
    context: {},
  });
  const oversizedMessage = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    durability: 'MEMORY_ONLY',
    message: 'm'.repeat(2049),
    context: {},
  });

  assert.equal(exactMessage.status, 'MEMORY_ONLY');
  assert.deepEqual(oversizedMessage, { status: 'REJECTED', code: 'MESSAGE_TOO_LARGE' });

  let low = 0;
  let high = 8192;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = Buffer.byteLength(JSON.stringify({ reason: 'x'.repeat(middle) }), 'utf8');
    if (bytes <= 8192) low = middle;
    else high = middle - 1;
  }
  const exactContext = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    durability: 'MEMORY_ONLY',
    message: 'context boundary',
    context: { reason: 'x'.repeat(low) },
  });
  const oversizedContext = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    durability: 'MEMORY_ONLY',
    message: 'context boundary',
    context: { reason: 'x'.repeat(low + 1) },
  });

  assert.equal(exactContext.status, 'MEMORY_ONLY');
  assert.deepEqual(oversizedContext, { status: 'REJECTED', code: 'CONTEXT_TOO_LARGE' });
});

test('unknown durable event, caller identity, and invalid class are rejected', async () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  await assert.rejects(
    logger.record({
      event: 'UNKNOWN_EVENT',
      source: 'test',
      category: 'audit',
      durability: 'DURABLE_CRITICAL',
      message: 'invalid',
    }),
    error => error instanceof StructuredLoggerError && error.code === 'UNKNOWN_EVENT',
  );
  const rejected = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    durability: 'INVALID',
    message: 'invalid',
  });
  assert.deepEqual(rejected, { status: 'REJECTED', code: 'INVALID_DURABILITY_CLASS' });
});

test('legacy helpers preserve positional memory behavior with redacted data', () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  const entry = logger.info('Legacy', 'message', { password: 'secret', safe: 'value' });

  assert.equal(entry.module, 'Legacy');
  assert.equal(entry.data.password, '[REDACTED]');
  assert.equal(entry.data.safe, 'value');
  assert.equal(logger.getLogs(1)[0].message, 'message');
});

test('memory retention remains bounded at 500 entries', () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  for (let index = 0; index < 501; index += 1) logger.info('Legacy', `message-${index}`);

  assert.equal(logger.getLogs(1000).length, 500);
  assert.equal(logger.getLogs(1)[0].message, 'message-500');
});

test('structured context reads only trusted keys from a large unknown root', async () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  const context = { code: 'READY' };
  for (let index = 0; index < 10000; index += 1) context[`attacker-${index}`] = 'secret';

  const result = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    message: 'ready',
    context,
  });

  assert.equal(result.status, 'MEMORY_ONLY');
  assert.deepEqual(result.record.context, { code: 'READY' });
});

test('structured context never invokes ownKeys on an unknown root proxy', async () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  let ownKeysCalls = 0;
  const context = new Proxy({ attacker: 'secret' }, {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error('ownKeys must not be called');
    },
  });

  const result = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    message: 'ready',
    context,
  });

  assert.equal(result.status, 'MEMORY_ONLY');
  assert.deepEqual(result.record.context, {});
  assert.equal(ownKeysCalls, 0);
});

test('structured context omits hostile nested objects without enumeration', async () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  let ownKeysCalls = 0;
  const hostile = new Proxy({ password: 'secret' }, {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error('nested ownKeys must not be called');
    },
  });

  const result = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    message: 'ready',
    context: { reason: hostile },
  });

  assert.equal(result.status, 'MEMORY_ONLY');
  assert.equal(result.record.context.reason, REDACTED);
  assert.equal(JSON.stringify(result.record).includes('secret'), false);
  assert.equal(ownKeysCalls, 0);
});

test('allowed secret strings remain redacted and arrays remain bounded', async () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  const secret = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    message: 'Authorization: Bearer hidden',
    context: { reason: 'token=hidden' },
  });
  assert.equal(secret.record.message, 'Authorization: [REDACTED]');
  assert.equal(secret.record.context.reason, 'token=[REDACTED]');

  const loggerRedaction = require('../../src/logger/redaction');
  const bounded = loggerRedaction.redact({ values: Array.from({ length: 100 }, (_, index) => index) });
  assert.equal(bounded.values.length, 65);
  assert.equal(bounded.values[64], REDACTED);
});

test('throwing allowed getters produce bounded redaction without escaping', async () => {
  const logger = new Logger(makeConfig(), { console: silentConsole() });
  const context = {};
  Object.defineProperty(context, 'reason', {
    enumerable: true,
    get() {
      throw new Error('getter failure');
    },
  });

  const result = await logger.record({
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    message: 'ready',
    context,
  });

  assert.equal(result.status, 'MEMORY_ONLY');
  assert.equal(result.record.context.reason, REDACTED);
});
