const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HEALTH_STATES = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  UNSAFE: 'UNSAFE',
});

const DEFAULT_LOG_FILE_PATH = path.resolve(__dirname, '../../runtime-data/logs/atlas-events.jsonl');
const MAX_QUEUE_DEPTH = 64;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
const MAX_TAIL_READ_BYTES = 2 * 1024 * 1024;
const MAX_RESTORED_RECORDS = 500;
const MAX_RECORD_BYTES = 16384;

class DurableLogStoreError extends Error {
  constructor(code, message, { cause = null, critical = false } = {}) {
    super(message, { cause: cause || undefined });
    this.name = 'DurableLogStoreError';
    this.code = code;
    this.cause = cause;
    this.critical = critical;
  }
}

function isNotFound(error) {
  return error?.code === 'ENOENT';
}

function assertAbsoluteFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '' || !path.isAbsolute(filePath)) {
    throw new TypeError('filePath must be a nonblank absolute path');
  }
  return filePath;
}

function isStructuredRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === 1
    && typeof value.eventId === 'string'
    && typeof value.timestamp === 'string'
    && typeof value.level === 'string'
    && typeof value.event === 'string'
    && typeof value.source === 'string'
    && typeof value.category === 'string'
    && typeof value.durability === 'string'
    && typeof value.message === 'string'
    && value.context
    && typeof value.context === 'object'
    && !Array.isArray(value.context);
}

function boundedError(error, fallbackCode, critical = false) {
  if (error instanceof DurableLogStoreError) return error;
  return new DurableLogStoreError(
    error?.code || fallbackCode,
    error?.message ? String(error.message).slice(0, 256) : fallbackCode,
    { cause: error, critical },
  );
}

class DurableLogStore {
  constructor({
    filePath = DEFAULT_LOG_FILE_PATH,
    fsAdapter = fs.promises,
    now = () => Date.now(),
    maxQueueDepth = MAX_QUEUE_DEPTH,
    maxFileBytes = MAX_FILE_BYTES,
    maxRotatedFiles = MAX_ROTATED_FILES,
    tailReadBytes = MAX_TAIL_READ_BYTES,
    maxRestoredRecords = MAX_RESTORED_RECORDS,
  } = {}) {
    this.filePath = assertAbsoluteFilePath(filePath);
    this.parentPath = path.dirname(this.filePath);
    this.baseName = path.basename(this.filePath);
    this.markerPath = `${this.filePath}.unsafe`;
    this.fs = fsAdapter;
    this.now = now;
    this.maxQueueDepth = maxQueueDepth;
    this.maxFileBytes = maxFileBytes;
    this.maxRotatedFiles = maxRotatedFiles;
    this.tailReadBytes = tailReadBytes;
    this.maxRestoredRecords = maxRestoredRecords;

    this.health = HEALTH_STATES.DEGRADED;
    this.initialized = false;
    this.initializing = null;
    this.fileHandle = null;
    this.queue = Promise.resolve();
    this.queueDepth = 0;
    this.pending = new Set();
    this.recentRecords = [];
  }

  async initialize() {
    if (this.initialized) return this.getStatus();
    if (this.initializing) return this.initializing;

    this.initializing = this._initialize().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  async _initialize() {
    try {
      await this.fs.mkdir(this.parentPath, { recursive: true, mode: 0o700 });
      const entries = await this.fs.readdir(this.parentPath).catch(error => {
        throw boundedError(error, 'LOG_DIRECTORY_READ_FAILED');
      });
      const hasMarker = entries.includes(path.basename(this.markerPath));
      const rotatedPattern = new RegExp(`^${escapeRegExp(this.baseName)}\\.[1-${this.maxRotatedFiles}]$`);
      const hasRotated = entries.some(entry => rotatedPattern.test(entry));
      const currentExists = entries.includes(this.baseName);
      const unexpectedRotated = entries.some(entry => (
        entry.startsWith(`${this.baseName}.`)
        && !rotatedPattern.test(entry)
        && entry !== path.basename(this.markerPath)
      ));

      if (hasMarker || unexpectedRotated) this._setHealth(HEALTH_STATES.UNSAFE);
      if (!currentExists && hasRotated) this._setHealth(HEALTH_STATES.UNSAFE);

      if (!currentExists) {
        const handle = await this.fs.open(this.filePath, 'a', 0o600);
        await handle.close();
      } else {
        try {
          await this._restoreCurrentTail();
        } catch (error) {
          if (error?.code !== 'LOG_CORRUPT_RECORD') throw error;
          await this._quarantineCurrent();
        }
      }

      this.initialized = true;
      if (this.health !== HEALTH_STATES.UNSAFE) this._certifyHealthy();
      return this.getStatus();
    } catch (error) {
      this._setHealth(HEALTH_STATES.UNSAFE);
      this.initialized = true;
      return this.getStatus({ error: boundedError(error, 'LOG_INITIALIZATION_FAILED', true) });
    }
  }

  async _restoreCurrentTail() {
    const handle = await this.fs.open(this.filePath, 'r');
    try {
      const stats = await handle.stat();
      const size = Number(stats.size);
      const start = Math.max(0, size - this.tailReadBytes);
      const length = size - start;
      if (length === 0) return;

      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, start);
      const text = buffer.subarray(0, result.bytesRead).toString('utf8');
      const firstNewline = start > 0 ? text.indexOf('\n') : -1;
      if (start > 0 && firstNewline < 0) {
        this._setHealth(HEALTH_STATES.UNSAFE);
        await this._writeUnsafeMarker('LOG_PARTIAL_TAIL_UNCERTAIN');
        return;
      }
      const parseText = start > 0 ? text.slice(firstNewline + 1) : text;
      const lines = parseText.split('\n');
      const hasPartialTail = lines.length > 0 && lines[lines.length - 1] !== '';
      if (hasPartialTail) {
        lines.pop();
        const lastNewlineInText = text.lastIndexOf('\n');
        const truncateOffset = lastNewlineInText >= 0
          ? start + Buffer.byteLength(text.slice(0, lastNewlineInText + 1), 'utf8')
          : start;
        await this._truncateCurrent(truncateOffset);
        this._setHealth(HEALTH_STATES.DEGRADED);
      }

      for (const line of lines) {
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          throw new DurableLogStoreError('LOG_CORRUPT_RECORD', 'A complete JSONL record is invalid', {
            cause: error,
            critical: true,
          });
        }
        if (!isStructuredRecord(record)) {
          throw new DurableLogStoreError('LOG_CORRUPT_RECORD', 'A complete JSONL record has an invalid schema', {
            critical: true,
          });
        }
        this._remember(record);
      }
      if (hasPartialTail) await this._writeRecoveryMarker();
    } finally {
      await handle.close();
    }
  }

  async _truncateCurrent(offset) {
    const handle = await this.fs.open(this.filePath, 'r+');
    try {
      await handle.truncate(offset);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async _quarantineCurrent() {
    const quarantinePath = `${this.filePath}.corrupt.${this.now()}.${crypto.randomUUID()}`;
    try {
      await this.fs.rename(this.filePath, quarantinePath);
    } finally {
      this.recentRecords = [];
      this._setHealth(HEALTH_STATES.UNSAFE);
      await this._writeUnsafeMarker('LOG_CORRUPT_RECORD');
      const handle = await this.fs.open(this.filePath, 'a', 0o600);
      await handle.close();
    }
  }

  async _writeRecoveryMarker() {
    const marker = {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      timestamp: new Date(this.now()).toISOString(),
      level: 'WARNING',
      event: 'ATLAS_STARTING',
      source: 'DurableLogStore',
      category: 'operational',
      durability: 'DURABLE_CRITICAL',
      message: 'Recovered incomplete JSONL tail',
      context: { recovery: 'PARTIAL_TAIL_TRUNCATED' },
    };
    const serialized = `${JSON.stringify(marker)}\n`;
    const handle = await this.fs.open(this.filePath, 'a', 0o600);
    try {
      await handle.write(serialized);
      await handle.sync();
      this._remember(marker);
    } finally {
      await handle.close();
    }
  }

  async append(serializedRecord, { critical = false } = {}) {
    await this.initialize();
    if (!this.initialized || this.health === HEALTH_STATES.UNSAFE) {
      throw new DurableLogStoreError('LOG_UNSAFE', 'Durable logging is unsafe', { critical });
    }
    if (typeof serializedRecord !== 'string' || !serializedRecord.endsWith('\n')) {
      throw new DurableLogStoreError('INVALID_LOG_RECORD', 'Durable record must be newline terminated', { critical });
    }

    const bytes = Buffer.byteLength(serializedRecord, 'utf8');
    if (bytes > MAX_RECORD_BYTES) {
      throw new DurableLogStoreError('RECORD_TOO_LARGE', 'Durable record exceeds the maximum size', { critical });
    }
    try {
      if (!isStructuredRecord(JSON.parse(serializedRecord))) throw new Error('schema');
    } catch (error) {
      throw new DurableLogStoreError('INVALID_LOG_RECORD', 'Durable record schema is invalid', {
        cause: error,
        critical,
      });
    }
    if (this.queueDepth >= this.maxQueueDepth) {
      if (critical) {
        this._setHealth(HEALTH_STATES.UNSAFE);
        await this._writeUnsafeMarker('LOG_QUEUE_FULL');
      }
      else this._setHealth(HEALTH_STATES.DEGRADED);
      throw new DurableLogStoreError('LOG_QUEUE_FULL', 'Durable log queue is full', { critical });
    }

    this.queueDepth++;
    const operation = this.queue.then(async () => {
      try {
        return await this._write(serializedRecord, { critical, bytes });
      } catch (error) {
        const normalized = boundedError(error, 'LOG_APPEND_FAILED', critical);
        if (critical) {
          this._setHealth(HEALTH_STATES.UNSAFE);
          await this._writeUnsafeMarker(normalized.code);
        }
        else this._setHealth(HEALTH_STATES.DEGRADED);
        throw normalized;
      } finally {
        this.queueDepth--;
      }
    });
    this.queue = operation.catch(() => {});
    this.pending.add(operation);
    operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  async _write(serializedRecord, { critical, bytes }) {
    await this._ensureHandle();
    const stats = await this.fileHandle.stat();
    if (Number(stats.size) + bytes > this.maxFileBytes) {
      await this._rotate();
      await this._ensureHandle();
    }

    await this.fileHandle.write(serializedRecord);
    if (critical) await this.fileHandle.sync();
    const record = JSON.parse(serializedRecord);
    this._remember(record);
    if (critical) this._certifyHealthy();
    return {
      status: critical ? 'DURABLE_CRITICAL_CERTIFIED' : 'DURABLE_ASYNC_ACCEPTED',
      record,
    };
  }

  async _ensureHandle() {
    if (this.fileHandle) return;
    this.fileHandle = await this.fs.open(this.filePath, 'a', 0o600);
  }

  async _rotate() {
    if (!this.fileHandle) return;
    await this.fileHandle.sync();
    await this.fileHandle.close();
    this.fileHandle = null;

    const temporary = `${this.filePath}.rotate.${process.pid}.${crypto.randomUUID()}.tmp`;
    const evicted = `${this.filePath}.evicted.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await this.fs.rename(this.filePath, temporary);
      const oldest = this.rotatedPath(this.maxRotatedFiles);
      if (await exists(this.fs, oldest)) await this.fs.rename(oldest, evicted);

      for (let index = this.maxRotatedFiles - 1; index >= 1; index -= 1) {
        const source = this.rotatedPath(index);
        const destination = this.rotatedPath(index + 1);
        if (await exists(this.fs, source)) {
          if (await exists(this.fs, destination)) await this.fs.unlink(destination);
          await this.fs.rename(source, destination);
        }
      }

      const firstRotated = this.rotatedPath(1);
      if (await exists(this.fs, firstRotated)) await this.fs.unlink(firstRotated);
      await this.fs.rename(temporary, firstRotated);
      const fresh = await this.fs.open(this.filePath, 'a', 0o600);
      await fresh.close();
      if (await exists(this.fs, evicted)) await this.fs.unlink(evicted);
    } catch (error) {
      this._setHealth(HEALTH_STATES.UNSAFE);
      await this._writeUnsafeMarker('LOG_ROTATION_UNCERTAIN');
      throw new DurableLogStoreError('LOG_ROTATION_UNCERTAIN', 'Durable log rotation is uncertain', {
        cause: error,
        critical: true,
      });
    }
  }

  rotatedPath(index) {
    return `${this.filePath}.${index}`;
  }

  _remember(record) {
    this.recentRecords.push(record);
    if (this.recentRecords.length > this.maxRestoredRecords) this.recentRecords.shift();
  }

  async _writeUnsafeMarker(reason) {
    try {
      await this.fs.writeFile(this.markerPath, `${JSON.stringify({ reason, timestamp: new Date(this.now()).toISOString() })}\n`, {
        mode: 0o600,
      });
    } catch {
      // Preserve the primary storage failure.
    }
  }

  _setHealth(next) {
    const order = { [HEALTH_STATES.HEALTHY]: 0, [HEALTH_STATES.DEGRADED]: 1, [HEALTH_STATES.UNSAFE]: 2 };
    if (order[next] >= order[this.health]) this.health = next;
  }

  _certifyHealthy() {
    if (this.health !== HEALTH_STATES.UNSAFE) this.health = HEALTH_STATES.HEALTHY;
  }

  getRecentRecords(limit = 100) {
    const bounded = Math.max(0, Math.min(Number.isSafeInteger(limit) ? limit : 100, this.maxRestoredRecords));
    return this.recentRecords.slice(-bounded).map(record => JSON.parse(JSON.stringify(record)));
  }

  getStatus(extra = {}) {
    return Object.freeze({
      health: this.health,
      initialized: this.initialized,
      queueDepth: this.queueDepth,
      maxQueueDepth: this.maxQueueDepth,
      activeFileBytes: null,
      ...extra,
    });
  }

  async flush() {
    const pending = Array.from(this.pending);
    const results = await Promise.allSettled(pending);
    if (this.fileHandle) await this.fileHandle.sync();
    const failed = results.some(result => result.status === 'rejected');
    if (failed) this._setHealth(HEALTH_STATES.DEGRADED);
    return this.getStatus({ flushed: true, failed });
  }

  async close() {
    await this.flush();
    if (this.fileHandle) {
      await this.fileHandle.close();
      this.fileHandle = null;
    }
    return this.getStatus({ closed: true });
  }
}

async function exists(fsAdapter, filePath) {
  try {
    await fsAdapter.stat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  DEFAULT_LOG_FILE_PATH,
  DurableLogStore,
  DurableLogStoreError,
  HEALTH_STATES,
  MAX_FILE_BYTES,
  MAX_QUEUE_DEPTH,
  MAX_RECORD_BYTES,
  MAX_RESTORED_RECORDS,
  MAX_ROTATED_FILES,
  MAX_TAIL_READ_BYTES,
};
