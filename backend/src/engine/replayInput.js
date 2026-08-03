const { assertTimestamp } = require('../core/clock');
const { TIMEFRAMES } = require('./candles');

const SCHEMA_VERSION = 1;
const MIN_REPLAY_CANDLES = 51;
const MIN_HISTORICAL_OPEN_TIME_MS = 100000000000;
const SUPPORTED_TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAMES));
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

class ReplayInputError extends TypeError {
  constructor(code, message, details = {}) {
    const path = details.path
      || (details.index === undefined
        ? undefined
        : `candles[${details.index}]${details.field ? `.${details.field}` : ''}`);
    super(path ? `${message} at ${path}` : message);
    this.name = 'ReplayInputError';
    this.code = code;
    if (details.index !== undefined) this.index = details.index;
    if (details.field !== undefined) this.field = details.field;
    if (path !== undefined) this.path = path;
  }
}

function fail(code, message, details) {
  throw new ReplayInputError(code, message, details);
}

function normalizeTimeframe(timeframe) {
  if (timeframe === undefined) return '1h';
  if (typeof timeframe !== 'string') {
    fail('INVALID_TIMEFRAME', 'Replay timeframe must be a supported string');
  }

  const normalized = timeframe.trim().toLowerCase();
  if (!normalized || !Object.hasOwn(TIMEFRAMES, normalized)) {
    fail('INVALID_TIMEFRAME', `Unsupported replay timeframe: ${timeframe}`);
  }

  return normalized;
}

function validateTimestampMs(value, index, field) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    fail('INVALID_TIMESTAMP', 'Timestamp must be a non-negative integer', { index, field });
  }

  try {
    assertTimestamp(value, field);
  } catch {
    fail('INVALID_TIMESTAMP', 'Timestamp is outside the valid JavaScript Date range', { index, field });
  }

  if (value > 0 && value < MIN_HISTORICAL_OPEN_TIME_MS) {
    fail('INVALID_TIMESTAMP_UNIT', 'Timestamp must be milliseconds, not seconds', { index, field });
  }

  return value;
}

function parseTimestampString(value, index) {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    fail('INVALID_TIMESTAMP', 'Timestamp must be an ISO date-time with an explicit timezone', { index, field: 'timestamp' });
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
    fail('INVALID_TIMESTAMP', 'Timestamp contains an invalid calendar or time value', { index, field: 'timestamp' });
  }

  const timestampMs = new Date(value).getTime();
  if (!Number.isFinite(timestampMs)) {
    fail('INVALID_TIMESTAMP', 'Timestamp must be a valid date string', { index, field: 'timestamp' });
  }

  return validateTimestampMs(timestampMs, index, 'timestamp');
}

function resolveOpenTime(candle, index) {
  const hasOpenTime = candle.openTime !== undefined && candle.openTime !== null;
  const hasTimestamp = candle.timestamp !== undefined && candle.timestamp !== null;

  let openTime;
  if (hasOpenTime) {
    openTime = validateTimestampMs(candle.openTime, index, 'openTime');
  }

  let timestampMs;
  if (hasTimestamp) {
    if (typeof candle.timestamp !== 'string') {
      fail('INVALID_TIMESTAMP', 'Timestamp must be a date string', { index, field: 'timestamp' });
    }
    timestampMs = parseTimestampString(candle.timestamp, index);
  }

  if (!hasOpenTime && !hasTimestamp) {
    fail('MISSING_TIMESTAMP', 'Candle requires openTime or timestamp', { index });
  }
  if (hasOpenTime && hasTimestamp && openTime !== timestampMs) {
    fail('INVALID_TIMESTAMP', 'Timestamp and openTime must represent the same millisecond', { index, field: 'timestamp' });
  }

  return openTime === undefined ? timestampMs : openTime;
}

function normalizeCandle(candle, index) {
  if (!candle || typeof candle !== 'object' || Array.isArray(candle)) {
    fail('INVALID_CANDLE', 'Candle must be an object', { index });
  }

  for (const field of ['open', 'high', 'low', 'close']) {
    if (candle[field] === undefined || candle[field] === null) {
      fail('MISSING_OHLC', `Candle is missing ${field}`, { index, field });
    }
    if (!Number.isFinite(candle[field])) {
      fail('INVALID_CANDLE', `Candle ${field} must be finite`, { index, field });
    }
  }

  if (candle.volume === undefined || candle.volume === null
    || !Number.isFinite(candle.volume) || candle.volume < 0) {
    fail('INVALID_VOLUME', 'Candle volume must be finite and non-negative', { index, field: 'volume' });
  }

  const { open, high, low, close, volume } = candle;
  if (high < low || open < low || open > high || close < low || close > high) {
    fail('INCONSISTENT_OHLC', 'Candle OHLC values are inconsistent', { index });
  }

  const openTime = resolveOpenTime(candle, index);
  return Object.freeze({
    openTime,
    timestamp: new Date(openTime).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  });
}

function normalizeReplayInput(candles, timeframe = '1h') {
  if (!Array.isArray(candles)) {
    fail('INPUT_MUST_BE_ARRAY', 'Replay input must be a candle array');
  }

  const normalizedTimeframe = normalizeTimeframe(timeframe);
  if (candles.length === 0) {
    fail('EMPTY_CANDLES', 'Replay input must contain candles');
  }
  if (candles.length < MIN_REPLAY_CANDLES) {
    fail('INSUFFICIENT_CANDLES', `Replay input requires at least ${MIN_REPLAY_CANDLES} candles`);
  }

  const normalizedCandles = [];
  const seen = new Set();
  for (let index = 0; index < candles.length; index++) {
    const candle = normalizeCandle(candles[index], index);
    if (seen.has(candle.openTime)) {
      fail('DUPLICATE_TIMESTAMP', 'Candle timestamp must be unique', { index, field: 'openTime' });
    }
    if (index > 0 && candle.openTime < normalizedCandles[index - 1].openTime) {
      fail('NON_CHRONOLOGICAL_INPUT', 'Candle timestamps must be strictly chronological', { index, field: 'openTime' });
    }
    seen.add(candle.openTime);
    normalizedCandles.push(candle);
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    timeframe: normalizedTimeframe,
    candles: Object.freeze(normalizedCandles),
  });
}

module.exports = {
  MIN_REPLAY_CANDLES,
  ReplayInputError,
  SUPPORTED_TIMEFRAMES,
  normalizeReplayInput,
};
