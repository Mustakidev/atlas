const REPLAY_ANALYZER_SCHEMA_VERSION = 1;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'symbol', 'snapshots']);
const SNAPSHOT_KEYS = Object.freeze(['timestamp', 'price', 'volume', 'change24h']);

class ReplayAnalyzerInputError extends TypeError {
  constructor(code, message, details = {}) {
    const path = details.path
      || (details.index === undefined
        ? undefined
        : `snapshots[${details.index}]${details.field ? `.${details.field}` : ''}`);
    super(path ? `${message} at ${path}` : message);
    this.name = 'ReplayAnalyzerInputError';
    this.code = code;
    this.path = path;
    this.index = details.index;
    this.field = details.field;
  }
}

function fail(code, message, details) {
  throw new ReplayAnalyzerInputError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertPlainObject(value, path, code = 'INVALID_INPUT', index) {
  if (!isPlainObject(value)) {
    fail(code, `${path} must be a plain object`, {
      path,
      ...(index === undefined ? {} : { index }),
    });
  }
}

function rejectUnknownProperties(value, allowedKeys, path, index) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      fail('UNKNOWN_PROPERTY', `${path}.${String(key)} is not supported`, {
        path: `${path}.${String(key)}`,
        ...(index === undefined ? {} : { index }),
      });
    }
  }
}

function assertTimestamp(value, index) {
  if (typeof value !== 'string') {
    fail('INVALID_TIMESTAMP', 'Timestamp must be an ISO date-time with an explicit timezone', {
      index,
      field: 'timestamp',
    });
  }

  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    fail('INVALID_TIMESTAMP', 'Timestamp must be an ISO date-time with an explicit timezone', {
      index,
      field: 'timestamp',
    });
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    fail('INVALID_TIMESTAMP', 'Timestamp contains an invalid calendar or offset value', {
      index,
      field: 'timestamp',
    });
  }

  const timestampMs = new Date(value).getTime();
  if (!Number.isFinite(timestampMs)) {
    fail('INVALID_TIMESTAMP', 'Timestamp must be a finite JavaScript Date value', {
      index,
      field: 'timestamp',
    });
  }

  const canonical = new Date(timestampMs).toISOString();
  return { timestampMs, canonical };
}

function assertNumber(value, code, label, index, field, predicate, requirement) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) {
    const suffix = requirement ? ` ${requirement}` : '';
    fail(code, `${label} must be a finite number${suffix}`, { index, field });
  }
}

function normalizeSnapshot(snapshot, index, seenSnapshots, seenTimestamps, previousTimestampMs) {
  const path = `snapshots[${index}]`;
  assertPlainObject(snapshot, path, 'INVALID_SNAPSHOTS', index);
  if (seenSnapshots.has(snapshot)) {
    fail('SHARED_SNAPSHOT_REFERENCE', 'Snapshot object is shared within the input array', {
      index,
      path,
    });
  }
  seenSnapshots.add(snapshot);
  rejectUnknownProperties(snapshot, SNAPSHOT_KEYS, path, index);

  for (const [field, code] of [
    ['timestamp', 'INVALID_TIMESTAMP'],
    ['price', 'INVALID_PRICE'],
    ['volume', 'INVALID_VOLUME'],
    ['change24h', 'INVALID_CHANGE24H'],
  ]) {
    if (!Object.hasOwn(snapshot, field)) {
      fail(code, `Snapshot is missing ${field}`, { index, field });
    }
  }

  const { timestampMs, canonical } = assertTimestamp(snapshot.timestamp, index);
  if (seenTimestamps.has(timestampMs)) {
    fail('DUPLICATE_TIMESTAMP', 'Snapshot timestamp must be unique', {
      index,
      field: 'timestamp',
    });
  }
  seenTimestamps.add(timestampMs);
  if (previousTimestampMs !== null) {
    if (timestampMs === previousTimestampMs) {
      fail('DUPLICATE_TIMESTAMP', 'Snapshot timestamp must be unique', {
        index,
        field: 'timestamp',
      });
    }
    if (timestampMs < previousTimestampMs) {
      fail('NON_MONOTONIC_TIMESTAMP', 'Snapshot timestamps must be strictly increasing', {
        index,
        field: 'timestamp',
      });
    }
  }

  assertNumber(snapshot.price, 'INVALID_PRICE', 'Snapshot price', index, 'price', value => value > 0, 'greater than zero');
  assertNumber(snapshot.volume, 'INVALID_VOLUME', 'Snapshot volume', index, 'volume', value => value >= 0, 'greater than or equal to zero');
  assertNumber(snapshot.change24h, 'INVALID_CHANGE24H', 'Snapshot change24h', index, 'change24h', () => true, '');

  return {
    snapshot: Object.freeze({
      timestamp: canonical,
      price: snapshot.price,
      volume: snapshot.volume,
      change24h: snapshot.change24h,
    }),
    timestampMs,
  };
}

function normalizeReplayAnalyzerInput(input) {
  assertPlainObject(input, 'input');
  rejectUnknownProperties(input, TOP_LEVEL_KEYS, 'input');

  if (input.schemaVersion !== REPLAY_ANALYZER_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be 1', { path: 'schemaVersion' });
  }
  if (typeof input.symbol !== 'string' || input.symbol.length === 0) {
    fail('INVALID_SYMBOL', 'symbol must be a non-empty string', { path: 'symbol' });
  }
  if (!Array.isArray(input.snapshots) || input.snapshots.length === 0) {
    fail('INVALID_SNAPSHOTS', 'snapshots must be a non-empty array', { path: 'snapshots' });
  }

  const normalizedSnapshots = [];
  const seenSnapshots = new WeakSet();
  const seenTimestamps = new Set();
  let previousTimestampMs = null;

  for (let index = 0; index < input.snapshots.length; index++) {
    if (!Object.hasOwn(input.snapshots, index)) {
      fail('INVALID_SNAPSHOTS', 'snapshots must be dense', { path: `snapshots[${index}]`, index });
    }

    const normalized = normalizeSnapshot(
      input.snapshots[index],
      index,
      seenSnapshots,
      seenTimestamps,
      previousTimestampMs,
    );
    normalizedSnapshots.push(normalized.snapshot);
    previousTimestampMs = normalized.timestampMs;
  }

  return Object.freeze({
    schemaVersion: REPLAY_ANALYZER_SCHEMA_VERSION,
    symbol: input.symbol,
    snapshots: Object.freeze(normalizedSnapshots),
  });
}

module.exports = {
  normalizeReplayAnalyzerInput,
  ReplayAnalyzerInputError,
  REPLAY_ANALYZER_SCHEMA_VERSION,
};
