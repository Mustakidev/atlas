const crypto = require('node:crypto');
const path = require('node:path');

const { DurableLogStore, DEFAULT_LOG_FILE_PATH, HEALTH_STATES } = require('./durableLogStore');
const { redact, REDACTED, truncateUtf8 } = require('./redaction');

const LEVELS = Object.freeze({ SYSTEM: 0, ERROR: 1, WARNING: 2, SUCCESS: 3, INFO: 4 });
const CATEGORIES = new Set(['diagnostic', 'operational', 'security', 'audit', 'trading-decision']);
const DURABILITY_CLASSES = new Set(['MEMORY_ONLY', 'DURABLE_ASYNC', 'DURABLE_CRITICAL']);
const MAX_MEMORY_ENTRIES = 500;
const MAX_MESSAGE_BYTES = 2048;
const MAX_CONTEXT_BYTES = 8192;
const MAX_RECORD_BYTES = 16384;
const MAX_REDACTION_DEPTH = 6;
const MAX_CONTEXT_MEMBERS = 64;

const EVENT_CONTEXT_KEYS = Object.freeze({
  ATLAS_STARTING: ['code', 'reason', 'path', 'recovery'],
  ATLAS_READY: ['code', 'reason', 'path', 'recovery'],
  ATLAS_SHUTDOWN: ['code', 'reason'],
  AUTH_LOGIN_SUCCEEDED: ['principal', 'sourceIp', 'outcome'],
  AUTH_LOGIN_FAILED: ['reason', 'sourceIp', 'outcome'],
  AUTH_LOGOUT: ['principal', 'sourceIp', 'outcome'],
  LIVE_STATE_INITIALIZED: ['operation', 'mutationSequence', 'outcome'],
  PAPER_TRADE_CLOSE_INTENT: ['tradeId', 'reason', 'operation'],
  PAPER_TRADE_CLOSE_COMMITTED: ['tradeId', 'reason', 'operation', 'outcome', 'pnl', 'mutationSequence'],
  LIVE_MUTATION_INTENT: ['operation', 'mutationSequence', 'tradeId'],
  LIVE_MUTATION_COMMITTED: ['operation', 'mutationSequence', 'tradeId', 'outcome'],
  DURABILITY_UNSAFE: ['code', 'phase', 'operation', 'health'],
  AUDIT_UNSAFE: ['code', 'phase', 'operation', 'health'],
  STATE_QUEUE_FULL: ['code', 'operation', 'queueDepth', 'capacity'],
  ANALYTICAL_CAPACITY_REJECTED: ['code', 'path', 'capacity', 'queueDepth'],
});

const EVENT_REGISTRY = Object.freeze(Object.fromEntries([
  ['ATLAS_STARTING', 'operational'],
  ['ATLAS_READY', 'operational'],
  ['ATLAS_SHUTDOWN', 'operational'],
  ['AUTH_LOGIN_SUCCEEDED', 'security'],
  ['AUTH_LOGIN_FAILED', 'security'],
  ['AUTH_LOGOUT', 'security'],
  ['LIVE_STATE_INITIALIZED', 'audit'],
  ['PAPER_TRADE_CLOSE_INTENT', 'audit'],
  ['PAPER_TRADE_CLOSE_COMMITTED', 'audit'],
  ['LIVE_MUTATION_INTENT', 'audit'],
  ['LIVE_MUTATION_COMMITTED', 'audit'],
  ['DURABILITY_UNSAFE', 'operational'],
  ['AUDIT_UNSAFE', 'operational'],
  ['STATE_QUEUE_FULL', 'operational'],
  ['ANALYTICAL_CAPACITY_REJECTED', 'operational'],
].map(([event, category]) => [event, Object.freeze({
  category,
  contextKeys: Object.freeze([...(EVENT_CONTEXT_KEYS[event] || [])]),
})])));

class StructuredLoggerError extends Error {
  constructor(code, message, { cause = null, critical = false } = {}) {
    super(message, { cause: cause || undefined });
    this.name = 'StructuredLoggerError';
    this.code = code;
    this.cause = cause;
    this.critical = critical;
  }
}

class Logger {
  constructor(config, options = {}) {
    this.logs = [];
    this.maxLogs = MAX_MEMORY_ENTRIES;
    this.minLevel = LEVELS[config.get('LOG_LEVEL')] ?? LEVELS.INFO;
    this.console = options.console || console;
    this.secretValues = [
      config.get('API_KEY'),
      config.get('ATLAS_OPERATOR_PASSWORD_HASH'),
      config.get('COINGECKO_API_KEY'),
    ].filter(value => typeof value === 'string' && value.length > 0);

    const configuredPath = config.get('ATLAS_LOG_FILE_PATH');
    const filePath = typeof configuredPath === 'string' && path.isAbsolute(configuredPath)
      ? configuredPath
      : DEFAULT_LOG_FILE_PATH;
    this.store = options.store || new DurableLogStore({
      filePath,
      ...(options.storeOptions || {}),
    });
    this.restored = false;
  }

  async initialize() {
    const status = await this.store.initialize();
    if (!this.restored) {
      for (const record of this.store.getRecentRecords(this.maxLogs)) this._remember(record);
      this.restored = true;
    }
    return status;
  }

  getHealth() {
    return this.store.getStatus().health;
  }

  getStatus() {
    return this.store.getStatus();
  }

  async flush() {
    return this.store.flush();
  }

  async close() {
    return this.store.close();
  }

  record(eventInput) {
    const critical = eventInput?.durability === 'DURABLE_CRITICAL';
    let record;
    try {
      record = this._createRecord(eventInput);
    } catch (error) {
      const normalized = error instanceof StructuredLoggerError
        ? error
        : new StructuredLoggerError('INVALID_STRUCTURED_EVENT', 'Structured event is invalid', {
          cause: error,
          critical,
        });
      if (critical) return Promise.reject(normalized);
      return Promise.resolve({ status: 'REJECTED', code: normalized.code });
    }

    if (record.durability !== 'DURABLE_CRITICAL' && LEVELS[record.level] > this.minLevel) {
      return Promise.resolve({ status: 'FILTERED', record });
    }

    this._remember(record);
    this._print(record);
    const serialized = `${JSON.stringify(record)}\n`;

    if (record.durability === 'MEMORY_ONLY') {
      return Promise.resolve({ status: 'MEMORY_ONLY', record });
    }

    return this.store.append(serialized, { critical: record.durability === 'DURABLE_CRITICAL' })
      .then(result => ({ ...result, record }))
      .catch(error => {
        if (record.durability === 'DURABLE_CRITICAL') {
          throw new StructuredLoggerError(error.code || 'DURABLE_LOG_FAILED', 'Critical durable log certification failed', {
            cause: error,
            critical: true,
          });
        }
        return { status: 'DURABLE_ASYNC_FAILED', code: error.code || 'DURABLE_LOG_FAILED', record };
      });
  }

  _createRecord(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new StructuredLoggerError('INVALID_STRUCTURED_EVENT', 'Structured event must be an object');
    }
    if (Object.hasOwn(input, 'timestamp') || Object.hasOwn(input, 'eventId')) {
      throw new StructuredLoggerError('CALLER_IDENTITY_OVERRIDE', 'Timestamp and event ID are logger-owned');
    }

    const {
      level = 'INFO',
      event,
      source,
      category,
      durability = 'MEMORY_ONLY',
      message,
      context = {},
      correlationId,
      mutationSequence,
      cycle,
      tradeId,
    } = input;

    const normalizedLevel = String(level).toUpperCase();
    if (!Object.hasOwn(LEVELS, normalizedLevel)) {
      throw new StructuredLoggerError('INVALID_LOG_LEVEL', 'Structured event level is invalid');
    }
    if (!EVENT_REGISTRY[event]) {
      throw new StructuredLoggerError('UNKNOWN_EVENT', 'Structured event code is not registered');
    }
    if (!CATEGORIES.has(category) || EVENT_REGISTRY[event].category !== category) {
      throw new StructuredLoggerError('INVALID_EVENT_CATEGORY', 'Structured event category is invalid');
    }
    if (!DURABILITY_CLASSES.has(durability)) {
      throw new StructuredLoggerError('INVALID_DURABILITY_CLASS', 'Structured event durability is invalid');
    }
    if (typeof source !== 'string' || source.trim() === '') {
      throw new StructuredLoggerError('INVALID_EVENT_SOURCE', 'Structured event source is required');
    }
    if (typeof message !== 'string') {
      throw new StructuredLoggerError('INVALID_EVENT_MESSAGE', 'Structured event message is required');
    }
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new StructuredLoggerError('INVALID_EVENT_CONTEXT', 'Structured event context must be an object');
    }

    const allowed = EVENT_REGISTRY[event].contextKeys;
    const safeContext = redact(context, {
      maxDepth: MAX_REDACTION_DEPTH,
      maxMembers: MAX_CONTEXT_MEMBERS,
      secretValues: this.secretValues,
      allowedKeys: allowed,
    });
    const contextBytes = Buffer.byteLength(JSON.stringify(safeContext), 'utf8');
    if (contextBytes > MAX_CONTEXT_BYTES) {
      throw new StructuredLoggerError('CONTEXT_TOO_LARGE', 'Structured event context exceeds the maximum size');
    }

    const safeMessage = redact(message, { secretValues: this.secretValues });
    if (Buffer.byteLength(safeMessage, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new StructuredLoggerError('MESSAGE_TOO_LARGE', 'Structured event message exceeds the maximum size');
    }
    const record = {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level: normalizedLevel,
      event,
      source: truncateUtf8(redact(source, { secretValues: this.secretValues }), 128),
      category,
      durability,
      message: safeMessage,
      context: safeContext,
    };

    for (const [key, value] of Object.entries({ correlationId, mutationSequence, cycle, tradeId })) {
      if (value === undefined) continue;
      if (['mutationSequence', 'cycle'].includes(key)) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new StructuredLoggerError('INVALID_EVENT_CORRELATION', `${key} must be a non-negative safe integer`);
        }
        record[key] = value;
      } else if (typeof value === 'string' && value.length > 0) {
        record[key] = truncateUtf8(redact(value, { secretValues: this.secretValues }), 256);
      } else {
        throw new StructuredLoggerError('INVALID_EVENT_CORRELATION', `${key} must be a non-empty string`);
      }
    }

    const recordBytes = Buffer.byteLength(JSON.stringify(record) + '\n', 'utf8');
    if (recordBytes > MAX_RECORD_BYTES) {
      throw new StructuredLoggerError('RECORD_TOO_LARGE', 'Structured event exceeds the maximum record size');
    }
    return record;
  }

  _remember(entry) {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
  }

  _print(entry) {
    try {
      const context = Object.keys(entry.context).length ? ` ${JSON.stringify(entry.context)}` : '';
      this.console.log(`[${entry.timestamp}] [${entry.level.padEnd(7)}] [${entry.source}] ${entry.message}${context}`);
    } catch {
      try { this.console.error('[LOGGER_OUTPUT_FAILED]'); } catch { /* Last-resort output is optional. */ }
    }
  }

  _log(level, module, message, data = null) {
    const numericLevel = LEVELS[level];
    if (numericLevel === undefined || numericLevel > this.minLevel) return;

    let safeData;
    try {
      safeData = redact(data, {
        maxDepth: MAX_REDACTION_DEPTH,
        maxMembers: MAX_CONTEXT_MEMBERS,
        secretValues: this.secretValues,
      });
      const dataBytes = Buffer.byteLength(JSON.stringify(safeData), 'utf8');
      if (dataBytes > MAX_CONTEXT_BYTES) safeData = REDACTED;
    } catch {
      safeData = REDACTED;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message: truncateUtf8(redact(message, { secretValues: this.secretValues }), MAX_MESSAGE_BYTES),
      data: safeData,
    };
    this._remember(entry);

    try {
      const dataStr = safeData && safeData !== REDACTED ? ` ${JSON.stringify(safeData)}` : safeData === REDACTED ? ` ${REDACTED}` : '';
      this.console.log(`[${entry.timestamp}] [${level.padEnd(7)}] [${module}] ${entry.message}${dataStr}`);
    } catch {
      try { this.console.error('[LOGGER_OUTPUT_FAILED]'); } catch { /* Last-resort output is optional. */ }
    }

    return entry;
  }

  info(module, message, data) { return this._log('INFO', module, message, data); }
  success(module, message, data) { return this._log('SUCCESS', module, message, data); }
  warn(module, message, data) { return this._log('WARNING', module, message, data); }
  error(module, message, data) { return this._log('ERROR', module, message, data); }
  system(module, message, data) { return this._log('SYSTEM', module, message, data); }

  getLogs(limit = 50, level = null) {
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, this.maxLogs)) : 50;
    let result = this.logs;
    if (level) result = result.filter(entry => entry.level === String(level).toUpperCase());
    return result.slice(-safeLimit);
  }

  getRecentDurableLogs(limit = 100) {
    return this.store.getRecentRecords(limit);
  }
}

module.exports = {
  CATEGORIES,
  DURABILITY_CLASSES,
  EVENT_REGISTRY,
  HEALTH_STATES,
  LEVELS,
  Logger,
  MAX_CONTEXT_BYTES,
  MAX_MEMORY_ENTRIES,
  MAX_MESSAGE_BYTES,
  MAX_REDACTION_DEPTH,
  MAX_RECORD_BYTES,
  StructuredLoggerError,
};
