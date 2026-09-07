const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Logger } = require('../../src/logger/logger');
const { DurableLogStore, HEALTH_STATES } = require('../../src/logger/durableLogStore');

async function withTempDirectory(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph11a-'));
  try {
    return await callback(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

function config() {
  return { get: key => ({
    LOG_LEVEL: 'INFO',
    API_KEY: '',
    ATLAS_OPERATOR_PASSWORD_HASH: '',
    COINGECKO_API_KEY: '',
    ATLAS_LOG_FILE_PATH: undefined,
  }[key]) };
}

test('critical persistence survives logger restart and restores recent durable records', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    const first = new Logger(config(), {
      store: new DurableLogStore({ filePath }),
      console: { log() {}, error() {} },
    });
    await first.initialize();
    const written = await first.record({
      event: 'ATLAS_READY',
      source: 'integration-test',
      category: 'operational',
      durability: 'DURABLE_CRITICAL',
      message: 'ready',
      context: { code: 'READY' },
    });
    assert.equal(written.status, 'DURABLE_CRITICAL_CERTIFIED');
    await first.close();

    const secondStore = new DurableLogStore({ filePath });
    const second = new Logger(config(), { store: secondStore, console: { log() {}, error() {} } });
    const status = await second.initialize();
    assert.equal(status.health, HEALTH_STATES.HEALTHY);
    assert.equal(second.getRecentDurableLogs(1)[0].event, 'ATLAS_READY');
    await second.close();
  });
});

test('async durable failure returns bounded failure without throwing', async () => {
  const store = new DurableLogStore();
  store.initialized = true;
  store.health = HEALTH_STATES.HEALTHY;
  store._write = async () => { throw new Error('simulated append failure'); };
  const logger = new Logger(config(), { store, console: { log() {}, error() {} } });

  const result = await logger.record({
    event: 'ANALYTICAL_CAPACITY_REJECTED',
    source: 'integration-test',
    category: 'operational',
    durability: 'DURABLE_ASYNC',
    message: 'capacity rejected',
    context: { code: 'FULL', path: '/api/test' },
  });

  assert.equal(result.status, 'DURABLE_ASYNC_FAILED');
  assert.equal(store.getStatus().health, HEALTH_STATES.DEGRADED);
});
