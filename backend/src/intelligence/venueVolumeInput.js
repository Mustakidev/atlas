'use strict';

const SCHEMA_VERSION = 1;

const TOP_LEVEL_KEYS = Object.freeze(['source', 'records']);
const SOURCE_KEYS = Object.freeze([
  'venue',
  'marketType',
  'symbol',
  'baseAsset',
  'quoteAsset',
]);
const RECORD_KEYS = Object.freeze([
  'openTime',
  'timestamp',
  'quoteVolume',
  'baseVolume',
  'tradeCount',
  'takerBuyBaseVolume',
  'takerBuyQuoteVolume',
  'isFinalized',
  'active',
  'closed',
]);
const OPTIONAL_RECORD_KEYS = Object.freeze([
  'baseVolume',
  'tradeCount',
  'takerBuyBaseVolume',
  'takerBuyQuoteVolume',
  'isFinalized',
  'active',
  'closed',
]);
const SOURCE_PLACEHOLDER = Object.freeze({
  venue: null,
  marketType: null,
  symbol: null,
  baseAsset: null,
  quoteAsset: null,
});
const AGGREGATE_VENUES = Object.freeze([
  'COINGECKO',
  'AGGREGATE',
  'MULTI_VENUE',
  'MULTI-VENUE',
  'ALL_VENUES',
]);

const SOURCE_PATTERNS = Object.freeze({
  venue: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  symbol: /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
  baseAsset: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  quoteAsset: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
});

function normalizeVenueVolumeInput(input) {
  if (!isObject(input)) return invalidResult(null, 'INVALID_INPUT');

  const topLevelIssue = firstUnknownKey(input, TOP_LEVEL_KEYS);
  if (topLevelIssue) return invalidResult(null, topLevelIssue);
  if (!Object.hasOwn(input, 'source')) return invalidResult(null, 'INVALID_SOURCE');
  if (!Object.hasOwn(input, 'records')) return invalidResult(null, 'INVALID_RECORDS');

  const sourceResult = normalizeSource(input.source);
  if (sourceResult.issue) return invalidResult(null, sourceResult.issue);

  if (!Array.isArray(input.records)) {
    return invalidResult(sourceResult.source, 'INVALID_RECORDS');
  }

  const normalizedRecords = [];
  for (let index = 0; index < input.records.length; index += 1) {
    if (!Object.hasOwn(input.records, index)) {
      return invalidResult(sourceResult.source, 'INVALID_RECORDS');
    }

    const recordResult = normalizeRecord(input.records[index]);
    if (recordResult.issue) return invalidResult(sourceResult.source, recordResult.issue);
    normalizedRecords.push(recordResult.record);
  }

  const duplicateIssue = findDuplicateTimestamp(normalizedRecords);
  if (duplicateIssue) return invalidResult(sourceResult.source, duplicateIssue);

  const orderingIssue = findOrderingIssue(normalizedRecords);
  if (orderingIssue) return invalidResult(sourceResult.source, orderingIssue);

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'READY',
    source: sourceResult.source,
    records: normalizedRecords,
    issues: [],
  };
}

function normalizeSource(source) {
  if (!isObject(source)) return { issue: 'INVALID_SOURCE' };

  const unknownKey = firstUnknownKey(source, SOURCE_KEYS);
  if (unknownKey) return { issue: unknownKey };

  const normalized = {};
  for (const field of SOURCE_KEYS) {
    if (!Object.hasOwn(source, field)) return { issue: 'INVALID_SOURCE' };

    const value = source[field];
    if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
      return { issue: 'INVALID_SOURCE' };
    }

    if (field !== 'marketType' && !SOURCE_PATTERNS[field].test(value)) {
      return { issue: 'INVALID_SOURCE' };
    }
    const canonical = value.toUpperCase();
    if (field === 'marketType' && canonical !== 'SPOT' && canonical !== 'PERPETUAL') {
      return { issue: 'INVALID_SOURCE' };
    }
    if (field === 'venue' && AGGREGATE_VENUES.includes(canonical)) {
      return { issue: 'INVALID_SOURCE' };
    }
    normalized[field] = canonical;
  }

  return { source: normalized };
}

function normalizeRecord(record) {
  if (!isObject(record)) return { issue: 'INVALID_RECORDS' };

  const unknownKey = firstUnknownKey(record, RECORD_KEYS);
  if (unknownKey) return { issue: unknownKey };

  if (!Object.hasOwn(record, 'openTime')) return { issue: 'INVALID_TIMESTAMP' };
  if (!Object.hasOwn(record, 'timestamp')) return { issue: 'INVALID_TIMESTAMP' };
  if (!Object.hasOwn(record, 'quoteVolume')) return { issue: 'INVALID_VOLUME' };

  if (!isFiniteNonNegativeNumber(record.quoteVolume)) return { issue: 'INVALID_VOLUME' };

  if (Object.hasOwn(record, 'baseVolume')
    && !isFiniteNonNegativeNumber(record.baseVolume)) {
    return { issue: 'INVALID_VOLUME' };
  }

  if (Object.hasOwn(record, 'tradeCount')
    && (!Number.isSafeInteger(record.tradeCount) || record.tradeCount < 0)) {
    return { issue: 'INVALID_TRADE_COUNT' };
  }

  if (Object.hasOwn(record, 'takerBuyQuoteVolume')) {
    if (!isFiniteNonNegativeNumber(record.takerBuyQuoteVolume)
      || record.takerBuyQuoteVolume > record.quoteVolume) {
      return { issue: 'INVALID_TAKER_VOLUME' };
    }
    if (record.quoteVolume === 0 && record.takerBuyQuoteVolume !== 0) {
      return { issue: 'INVALID_TAKER_VOLUME' };
    }
  }

  if (Object.hasOwn(record, 'takerBuyBaseVolume')) {
    if (!Object.hasOwn(record, 'baseVolume')
      || !isFiniteNonNegativeNumber(record.baseVolume)
      || !isFiniteNonNegativeNumber(record.takerBuyBaseVolume)
      || record.takerBuyBaseVolume > record.baseVolume) {
      return { issue: 'INVALID_TAKER_VOLUME' };
    }
  }

  for (const field of ['isFinalized', 'active', 'closed']) {
    if (Object.hasOwn(record, field) && typeof record[field] !== 'boolean') {
      return { issue: 'INVALID_RECORDS' };
    }
  }

  if (record.isFinalized === false || record.active === true || record.closed === false) {
    return { issue: 'ACTIVE_CANDLE' };
  }

  if (!Number.isSafeInteger(record.openTime)) return { issue: 'INVALID_TIMESTAMP' };

  let canonicalTimestamp;
  try {
    canonicalTimestamp = new Date(record.openTime).toISOString();
  } catch (_error) {
    return { issue: 'INVALID_TIMESTAMP' };
  }
  if (typeof record.timestamp !== 'string' || record.timestamp !== canonicalTimestamp) {
    return { issue: 'INVALID_TIMESTAMP' };
  }

  const normalized = {
    openTime: record.openTime,
    timestamp: canonicalTimestamp,
    quoteVolume: record.quoteVolume,
  };
  for (const field of OPTIONAL_RECORD_KEYS) {
    normalized[field] = Object.hasOwn(record, field) ? record[field] : null;
  }

  return { record: normalized };
}

function findDuplicateTimestamp(records) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.openTime)) return 'DUPLICATE_TIMESTAMP';
    seen.add(record.openTime);
  }
  return null;
}

function findOrderingIssue(records) {
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].openTime < records[index - 1].openTime) {
      return 'OUT_OF_ORDER_TIMESTAMP';
    }
  }
  return null;
}

function invalidResult(source, issue) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'INVALID_INPUT',
    source: source ? { ...source } : { ...SOURCE_PLACEHOLDER },
    records: [],
    issues: [issue],
  };
}

function firstUnknownKey(value, allowedKeys) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) return 'UNKNOWN_FIELD';
  }
  return null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

module.exports = { normalizeVenueVolumeInput };
