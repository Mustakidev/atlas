const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DurableLogStore,
  HEALTH_STATES,
  MAX_TAIL_READ_BYTES,
} = require('../../src/logger/durableLogStore');

async function withTempDirectory(callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph11a-'));
  try {
    return await callback(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

function record(index) {
  return {
    schemaVersion: 1,
    eventId: `event-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    level: 'INFO',
    event: 'ATLAS_READY',
    source: 'test',
    category: 'operational',
    durability: 'DURABLE_ASYNC',
    message: `record-${index}`,
    context: { index },
  };
}

function line(index) {
  return `${JSON.stringify(record(index))}\n`;
}

test('initializes a fresh store and appends valid JSONL', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'logs', 'atlas-events.jsonl');
    const store = new DurableLogStore({ filePath });
    const status = await store.initialize();

    assert.equal(status.health, HEALTH_STATES.HEALTHY);
    const result = await store.append(line(1));
    assert.equal(result.status, 'DURABLE_ASYNC_ACCEPTED');
    assert.deepEqual(store.getRecentRecords(1)[0].context, { index: 1 });
    assert.equal((await fs.promises.readFile(filePath, 'utf8')).endsWith('\n'), true);
    await store.close();
  });
});

test('restores only the bounded current-file tail', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, Array.from({ length: 20 }, (_, index) => line(index)).join(''));
    const store = new DurableLogStore({ filePath, tailReadBytes: 256, maxRestoredRecords: 3 });
    await store.initialize();
    const restored = store.getRecentRecords(10);

    assert.ok(restored.length <= 3);
    assert.ok(restored.at(-1).eventId === 'event-19');
    await store.close();
  });
});

test('default tail restoration never reads more than two MiB', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    const lines = Array.from({ length: 180 }, (_, index) => JSON.stringify({
      ...record(index),
      message: 'x'.repeat(15000),
    }) + '\n');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, lines.join(''));

    let largestRead = 0;
    const base = fs.promises;
    const fsAdapter = {
      ...base,
      open: async (...args) => {
        const handle = await base.open(...args);
        return {
          stat: (...inner) => handle.stat(...inner),
          read: async (buffer, offset, length, position) => {
            largestRead = Math.max(largestRead, length);
            return handle.read(buffer, offset, length, position);
          },
          truncate: (...inner) => handle.truncate(...inner),
          sync: (...inner) => handle.sync(...inner),
          close: (...inner) => handle.close(...inner),
          write: (...inner) => handle.write(...inner),
        };
      },
    };
    const store = new DurableLogStore({ filePath, fsAdapter });
    await store.initialize();

    assert.ok(Buffer.byteLength(await fs.promises.readFile(filePath)) > MAX_TAIL_READ_BYTES);
    assert.ok(largestRead <= MAX_TAIL_READ_BYTES);
    await store.close();
  });
});

test('large tail starting mid-record restores later complete records without truncating', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    const lines = Array.from({ length: 180 }, (_, index) => JSON.stringify({
      ...record(index),
      message: 'x'.repeat(15000),
    }) + '\n');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, lines.join(''));
    const before = await fs.promises.readFile(filePath);
    let largestRead = 0;
    const base = fs.promises;
    const fsAdapter = {
      ...base,
      open: async (...args) => {
        const handle = await base.open(...args);
        return {
          stat: (...inner) => handle.stat(...inner),
          read: async (buffer, offset, length, position) => {
            largestRead = Math.max(largestRead, length);
            return handle.read(buffer, offset, length, position);
          },
          truncate: (...inner) => handle.truncate(...inner),
          sync: (...inner) => handle.sync(...inner),
          close: (...inner) => handle.close(...inner),
          write: (...inner) => handle.write(...inner),
        };
      },
    };

    const store = new DurableLogStore({ filePath, fsAdapter });
    const status = await store.initialize();

    assert.equal(status.health, HEALTH_STATES.HEALTHY);
    assert.equal(largestRead <= MAX_TAIL_READ_BYTES, true);
    assert.deepEqual(await fs.promises.readFile(filePath), before);
    assert.equal(store.getRecentRecords(1)[0].eventId, 'event-179');
    await store.close();
  });
});

test('large mid-record prefix plus incomplete final line repairs only the suffix', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    const completeLines = Array.from({ length: 180 }, (_, index) => JSON.stringify({
      ...record(index),
      message: 'x'.repeat(15000),
    }) + '\n').join('');
    const incomplete = '{"schemaVersion":1,"eventId":"incomplete","message":"unfinished';
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, completeLines + incomplete);
    let largestRead = 0;
    const base = fs.promises;
    const fsAdapter = {
      ...base,
      open: async (...args) => {
        const handle = await base.open(...args);
        return {
          stat: (...inner) => handle.stat(...inner),
          read: async (buffer, offset, length, position) => {
            largestRead = Math.max(largestRead, length);
            return handle.read(buffer, offset, length, position);
          },
          truncate: (...inner) => handle.truncate(...inner),
          sync: (...inner) => handle.sync(...inner),
          close: (...inner) => handle.close(...inner),
          write: (...inner) => handle.write(...inner),
        };
      },
    };

    const store = new DurableLogStore({ filePath, fsAdapter });
    const status = await store.initialize();
    const recovered = await fs.promises.readFile(filePath, 'utf8');

    assert.equal(status.health, HEALTH_STATES.HEALTHY);
    assert.equal(largestRead <= MAX_TAIL_READ_BYTES, true);
    assert.equal(recovered.includes('unfinished'), false);
    assert.equal(recovered.startsWith(completeLines), true);
    assert.equal(store.getRecentRecords(1)[0].context.recovery, 'PARTIAL_TAIL_TRUNCATED');
    await store.close();
  });
});

test('large no-newline tail preserves evidence and becomes unsafe', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    const valid = line(1);
    const incomplete = '{"message":"' + 'x'.repeat(MAX_TAIL_READ_BYTES + 1024);
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, valid + incomplete);
    const before = await fs.promises.readFile(filePath);
    let largestRead = 0;
    const base = fs.promises;
    const fsAdapter = {
      ...base,
      open: async (...args) => {
        const handle = await base.open(...args);
        return {
          stat: (...inner) => handle.stat(...inner),
          read: async (buffer, offset, length, position) => {
            largestRead = Math.max(largestRead, length);
            return handle.read(buffer, offset, length, position);
          },
          truncate: (...inner) => handle.truncate(...inner),
          sync: (...inner) => handle.sync(...inner),
          close: (...inner) => handle.close(...inner),
          write: (...inner) => handle.write(...inner),
        };
      },
    };

    const store = new DurableLogStore({ filePath, fsAdapter });
    const status = await store.initialize();

    assert.equal(status.health, HEALTH_STATES.UNSAFE);
    assert.equal(largestRead <= MAX_TAIL_READ_BYTES, true);
    assert.deepEqual(await fs.promises.readFile(filePath), before);
    assert.equal((await fs.promises.readdir(directory)).includes('atlas-events.jsonl.unsafe'), true);
    await store.close();
  });
});

test('truncates only an incomplete final line', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    await fs.promises.mkdir(directory, { recursive: true });
    const valid = line(1);
    await fs.promises.writeFile(filePath, `${valid}{"incomplete"`);

    const store = new DurableLogStore({ filePath });
    const status = await store.initialize();

    assert.equal(status.health, HEALTH_STATES.HEALTHY);
    assert.equal(store.getRecentRecords(1)[0].context.recovery, 'PARTIAL_TAIL_TRUNCATED');
    const recovered = await fs.promises.readFile(filePath, 'utf8');
    assert.equal(recovered.startsWith(valid), true);
    assert.equal(recovered.split('\n').filter(Boolean).length, 2);
    await store.close();
  });
});

test('truncate failure becomes unsafe with bounded error evidence', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, `${line(1)}{"incomplete"`);
    const base = fs.promises;
    const fsAdapter = {
      ...base,
      open: async (...args) => {
        if (args[1] === 'r+') throw Object.assign(new Error('truncate denied'), { code: 'E_TRUNCATE' });
        return base.open(...args);
      },
    };

    const store = new DurableLogStore({ filePath, fsAdapter });
    const status = await store.initialize();

    assert.equal(status.health, HEALTH_STATES.UNSAFE);
    assert.equal(status.error.code, 'E_TRUNCATE');
    await store.close();
  });
});

test('recovery fsync failure becomes unsafe without false health', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, `${line(1)}{"incomplete"`);
    const base = fs.promises;
    const fsAdapter = {
      ...base,
      open: async (...args) => {
        const handle = await base.open(...args);
        if (args[1] !== 'a') return handle;
        return {
          write: (...inner) => handle.write(...inner),
          sync: async () => { throw Object.assign(new Error('recovery sync denied'), { code: 'E_RECOVERY_SYNC' }); },
          close: (...inner) => handle.close(...inner),
        };
      },
    };

    const store = new DurableLogStore({ filePath, fsAdapter });
    const status = await store.initialize();

    assert.equal(status.health, HEALTH_STATES.UNSAFE);
    assert.equal(status.error.code, 'E_RECOVERY_SYNC');
    await store.close();
  });
});

test('quarantines a corrupt complete record and becomes unsafe', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, `${line(1)}not-json\n${line(2)}`);

    const store = new DurableLogStore({ filePath });
    const status = await store.initialize();
    const entries = await fs.promises.readdir(directory);

    assert.equal(status.health, HEALTH_STATES.UNSAFE);
    assert.ok(entries.some(entry => entry.startsWith('atlas-events.jsonl.corrupt.')));
    assert.ok(entries.includes('atlas-events.jsonl.unsafe'));
    await store.close();
  });
});

test('restores at most 500 current-file records without scanning rotations', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(filePath, Array.from({ length: 600 }, (_, index) => line(index)).join(''));
    await fs.promises.writeFile(`${filePath}.1`, line(999));
    const opened = [];
    const base = fs.promises;
    const fsAdapter = {
      ...base,
      open: async (...args) => {
        opened.push(args[0]);
        return base.open(...args);
      },
    };

    const store = new DurableLogStore({ filePath, fsAdapter });
    await store.initialize();

    assert.equal(store.getRecentRecords(1000).length, 500);
    assert.equal(opened.some(entry => entry === `${filePath}.1`), false);
    await store.close();
  });
});

test('critical append requires fsync while async append does not', async () => {
  const writes = [];
  let syncs = 0;
  const store = new DurableLogStore();
  store.initialized = true;
  store.fileHandle = {
    async stat() { return { size: 0 }; },
    async write(value) { writes.push(value); },
    async sync() { syncs += 1; },
  };
  store._ensureHandle = async () => {};

  await store.append(line(1));
  await store.append(line(2), { critical: true });

  assert.equal(writes.length, 2);
  assert.equal(syncs, 1);
});

test('serialized record boundary accepts exactly 16384 bytes and rejects the next byte', async () => {
  const store = new DurableLogStore();
  store.initialized = true;
  store._write = async serialized => ({
    status: 'DURABLE_ASYNC_ACCEPTED',
    record: JSON.parse(serialized),
  });
  const makeLine = padding => `${JSON.stringify({
    ...record(1),
    context: { padding: 'x'.repeat(padding) },
  })}\n`;
  let low = 0;
  let high = 16384;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(makeLine(middle), 'utf8') <= 16384) low = middle;
    else high = middle - 1;
  }
  const exact = makeLine(low);
  const oversized = makeLine(low + 1);

  assert.equal(Buffer.byteLength(exact, 'utf8'), 16384);
  assert.equal((await store.append(exact)).status, 'DURABLE_ASYNC_ACCEPTED');
  await assert.rejects(store.append(oversized), error => error.code === 'RECORD_TOO_LARGE');
});

test('queue admits exactly 64 records including the active writer', async () => {
  const store = new DurableLogStore();
  store.initialized = true;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  store._write = async serialized => {
    if (store._writes === undefined) {
      store._writes = 0;
    }
    store._writes += 1;
    if (store._writes === 1) await gate;
    return { status: 'DURABLE_ASYNC_ACCEPTED', record: JSON.parse(serialized) };
  };

  const accepted = Array.from({ length: 64 }, (_, index) => store.append(line(index)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.queueDepth, 64);
  const rejected = store.append(line(64));
  await assert.rejects(rejected, error => error.code === 'LOG_QUEUE_FULL');

  release();
  const results = await Promise.all(accepted);
  assert.equal(results.length, 64);
  assert.equal(store.queueDepth, 0);
});

test('failed async append releases its queue slot and permits later work', async () => {
  const store = new DurableLogStore();
  store.initialized = true;
  let attempts = 0;
  store._write = async serialized => {
    attempts += 1;
    if (attempts === 1) throw new Error('simulated failure');
    return { status: 'DURABLE_ASYNC_ACCEPTED', record: JSON.parse(serialized) };
  };

  await assert.rejects(store.append(line(1)), error => error.code === 'LOG_APPEND_FAILED');
  const result = await store.append(line(2));
  assert.equal(result.status, 'DURABLE_ASYNC_ACCEPTED');
  assert.equal(store.queueDepth, 0);
});

test('rotation keeps at most five rotated files and preserves the newest records', async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, 'atlas-events.jsonl');
    const store = new DurableLogStore({ filePath, maxFileBytes: 180, maxRotatedFiles: 5 });
    await store.initialize();
    for (let index = 0; index < 20; index += 1) await store.append(line(index), { critical: true });
    await store.close();

    const entries = await fs.promises.readdir(directory);
    const rotated = entries.filter(entry => /^atlas-events\.jsonl\.[1-5]$/.test(entry));
    assert.ok(rotated.length <= 5);
    assert.equal(entries.some(entry => /^atlas-events\.jsonl\.6$/.test(entry)), false);
  });
});
