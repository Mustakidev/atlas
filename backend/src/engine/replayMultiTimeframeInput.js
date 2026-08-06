const MAX_DATE_MS = 8640000000000000;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const REQUIRED_ROOT_KEYS = new Set(['schemaVersion', 'primaryTimeframe', 'sourcePolicy', 'timeframes']);
const SUPPORTED_CANDLE_KEYS = new Set([
  'openTime',
  'timestamp',
  'open',
  'high',
  'low',
  'close',
  'volume',
]);

const REPLAY_MTF_SCHEMA_VERSION = 2;
const REPLAY_MTF_TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '1h']);
const REPLAY_MTF_DURATIONS_MS = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
});

class ReplayMultiTimeframeInputError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ReplayMultiTimeframeInputError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReplayMultiTimeframeInputError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) fail('INVALID_OBJECT', `${path} must be a non-array object`);
}

function ownKeys(value) {
  return Reflect.ownKeys(value);
}

function rejectUnknownKeys(value, allowedKeys, path) {
  for (const key of ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      fail('UNKNOWN_PROPERTY', `${path}.${String(key)} is not supported`);
    }
  }
}

function assertTimestampMs(value, path) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_DATE_MS) {
    fail('INVALID_TIMESTAMP', `${path} must be a valid integer millisecond timestamp`);
  }
  if (!Number.isFinite(new Date(value).getTime())) {
    fail('INVALID_TIMESTAMP', `${path} must be a valid date timestamp`);
  }
  return value;
}

function parseTimestampString(value, path) {
  if (typeof value !== 'string') {
    fail('INVALID_TIMESTAMP', `${path} must be an ISO date-time with an explicit timezone`);
  }

  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    fail('INVALID_TIMESTAMP', `${path} must be an ISO date-time with an explicit timezone`);
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

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    fail('INVALID_TIMESTAMP', `${path} contains an invalid calendar or time value`);
  }

  const timestampMs = new Date(value).getTime();
  if (!Number.isFinite(timestampMs)) {
    fail('INVALID_TIMESTAMP', `${path} must be a valid date string`);
  }

  return assertTimestampMs(timestampMs, path);
}

function resolveOpenTime(candle, path) {
  const hasOpenTime = Object.hasOwn(candle, 'openTime');
  const hasTimestamp = Object.hasOwn(candle, 'timestamp');

  if (!hasOpenTime && !hasTimestamp) {
    fail('MISSING_TIMESTAMP', `${path} requires openTime or timestamp`);
  }

  const openTime = hasOpenTime
    ? assertTimestampMs(candle.openTime, `${path}.openTime`)
    : undefined;
  const timestampMs = hasTimestamp
    ? parseTimestampString(candle.timestamp, `${path}.timestamp`)
    : undefined;

  if (hasOpenTime && hasTimestamp && openTime !== timestampMs) {
    fail('INVALID_TIMESTAMP', `${path}.timestamp must match openTime`);
  }

  return openTime === undefined ? timestampMs : openTime;
}

function validateOhlcv(candle, path) {
  for (const field of ['open', 'high', 'low', 'close', 'volume']) {
    if (!Number.isFinite(candle[field])) {
      fail('INVALID_CANDLE', `${path}.${field} must be finite`);
    }
  }

  for (const field of ['open', 'high', 'low', 'close']) {
    if (candle[field] <= 0) {
      fail('INVALID_CANDLE', `${path}.${field} must be greater than zero`);
    }
  }
  if (candle.volume < 0) {
    fail('INVALID_VOLUME', `${path}.volume must be greater than or equal to zero`);
  }
  if (candle.high < candle.open || candle.high < candle.low || candle.high < candle.close) {
    fail('INCONSISTENT_OHLC', `${path}.high must be greater than or equal to open, low, and close`);
  }
  if (candle.low > candle.open || candle.low > candle.high || candle.low > candle.close) {
    fail('INCONSISTENT_OHLC', `${path}.low must be less than or equal to open, high, and close`);
  }
}

function normalizeCandle(candle, timeframe, index, candleOwners) {
  const path = `timeframes.${timeframe}[${index}]`;
  assertPlainObject(candle, path);
  rejectUnknownKeys(candle, SUPPORTED_CANDLE_KEYS, path);

  if (candleOwners.has(candle)) {
    fail('SHARED_CANDLE_REFERENCE', `${path} reuses a candle object from ${candleOwners.get(candle)}`);
  }
  candleOwners.set(candle, path);

  validateOhlcv(candle, path);
  const openTime = resolveOpenTime(candle, path);
  const durationMs = REPLAY_MTF_DURATIONS_MS[timeframe];
  const closeTime = openTime + durationMs;

  try {
    assertTimestampMs(closeTime, `${path}.closeTime`);
  } catch (error) {
    if (error instanceof ReplayMultiTimeframeInputError) throw error;
    fail('INVALID_TIMESTAMP', `${path}.closeTime must be a valid timestamp`);
  }

  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

function validateStreamSpacing(candles, timeframe) {
  const durationMs = REPLAY_MTF_DURATIONS_MS[timeframe];
  for (let index = 0; index < candles.length; index++) {
    const path = `timeframes.${timeframe}[${index}].openTime`;
    const openTime = candles[index].openTime;
    if (openTime % durationMs !== 0) {
      fail('MISALIGNED_TIMESTAMP', `${path} is not aligned to ${timeframe}`);
    }
    if (index === 0) continue;

    const previousOpenTime = candles[index - 1].openTime;
    const difference = openTime - previousOpenTime;
    if (difference < 0) {
      fail('UNSORTED_CANDLES', `${path} must be ordered ascending`);
    }
    if (difference === 0) {
      fail('DUPLICATE_TIMESTAMP', `${path} duplicates the previous openTime`);
    }
    if (difference > durationMs) {
      fail('CANDLE_GAP', `timeframes.${timeframe} contains a gap between indexes ${index - 1} and ${index}`);
    }
  }
}

function normalizeStream(rawCandles, timeframe, seenArrays, candleOwners) {
  const path = `timeframes.${timeframe}`;
  if (!Array.isArray(rawCandles)) fail('INVALID_STREAM', `${path} must be an array`);
  if (rawCandles.length === 0) fail('EMPTY_STREAM', `${path} must be a non-empty array`);
  if (seenArrays.has(rawCandles)) {
    fail('SHARED_STREAM_REFERENCE', `${path} reuses an array from ${seenArrays.get(rawCandles)}`);
  }
  seenArrays.set(rawCandles, path);

  const normalizedCandles = rawCandles.map((candle, index) =>
    normalizeCandle(candle, timeframe, index, candleOwners));
  validateStreamSpacing(normalizedCandles, timeframe);
  return normalizedCandles;
}

function validateCoverage(stream, timeframe, primaryStart, primaryEnd) {
  if (stream[0].openTime > primaryStart || stream[stream.length - 1].closeTime < primaryEnd) {
    fail('INSUFFICIENT_COVERAGE', `timeframes.${timeframe} does not cover the primary replay horizon`);
  }
}

function normalizeReplayMultiTimeframeInput(rawInput) {
  assertPlainObject(rawInput, 'input');
  rejectUnknownKeys(rawInput, REQUIRED_ROOT_KEYS, 'input');

  for (const key of REQUIRED_ROOT_KEYS) {
    if (!Object.hasOwn(rawInput, key)) fail('MISSING_PROPERTY', `input.${key} is required`);
  }
  if (rawInput.schemaVersion !== REPLAY_MTF_SCHEMA_VERSION) {
    fail('INVALID_SCHEMA_VERSION', 'input.schemaVersion must be 2');
  }
  if (rawInput.primaryTimeframe !== '1h') {
    fail('INVALID_PRIMARY_TIMEFRAME', 'input.primaryTimeframe must be exactly 1h');
  }
  if (rawInput.sourcePolicy !== 'independent') {
    fail('INVALID_SOURCE_POLICY', 'input.sourcePolicy must be exactly independent');
  }
  assertPlainObject(rawInput.timeframes, 'input.timeframes');

  const timeframeKeys = new Set(REPLAY_MTF_TIMEFRAMES);
  rejectUnknownKeys(rawInput.timeframes, timeframeKeys, 'timeframes');
  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    if (!Object.hasOwn(rawInput.timeframes, timeframe)) {
      fail('MISSING_TIMEFRAME', `timeframes.${timeframe} is required`);
    }
  }

  const seenArrays = new Map();
  const candleOwners = new WeakMap();
  const normalizedTimeframes = {};
  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    normalizedTimeframes[timeframe] = normalizeStream(
      rawInput.timeframes[timeframe],
      timeframe,
      seenArrays,
      candleOwners,
    );
  }

  if (normalizedTimeframes['1h'].length < 51) {
    fail('INSUFFICIENT_HISTORY', 'timeframes.1h must contain at least 51 candles');
  }
  for (const timeframe of REPLAY_MTF_TIMEFRAMES.slice(0, -1)) {
    if (normalizedTimeframes[timeframe].length < 15) {
      fail('INSUFFICIENT_HISTORY', `timeframes.${timeframe} must contain at least 15 candles`);
    }
  }

  const primary = normalizedTimeframes['1h'];
  const primaryStart = primary[0].openTime;
  const primaryEnd = primary[primary.length - 1].closeTime;
  for (const timeframe of REPLAY_MTF_TIMEFRAMES.slice(0, -1)) {
    validateCoverage(normalizedTimeframes[timeframe], timeframe, primaryStart, primaryEnd);
  }

  const outputTimeframes = {};
  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    outputTimeframes[timeframe] = Object.freeze(normalizedTimeframes[timeframe].map(candle => Object.freeze(candle)));
  }

  return Object.freeze({
    schemaVersion: REPLAY_MTF_SCHEMA_VERSION,
    primaryTimeframe: '1h',
    sourcePolicy: 'independent',
    timeframes: Object.freeze(outputTimeframes),
  });
}

module.exports = {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_SCHEMA_VERSION,
  REPLAY_MTF_TIMEFRAMES,
  REPLAY_MTF_DURATIONS_MS,
};
