const { normalizeReplayAnalyzerInput } = require('./replayAnalyzerInput');
const { throwIfAborted, isCancellation } = require('../core/cancellation');

const MAX_DATE_MS = 8_640_000_000_000_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const REQUEST_KEYS = Object.freeze(['symbol', 'startTime', 'endTime']);
const RESULT_KEYS = Object.freeze(['events', 'diagnostics']);
const EVENT_KEYS = Object.freeze(['timestamp', 'price', 'volume', 'change24h']);
const DIAGNOSTIC_KEYS = Object.freeze([
  'provider',
  'coinId',
  'vsCurrency',
  'targetStartTime',
  'targetEndTime',
  'acquisitionStartTime',
  'acquisitionEndTime',
  'eventCount',
  'firstEventTimestamp',
  'lastEventTimestamp',
  'rawPayloadSha256',
]);

class ProductionReplayAnalyzerSourceError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProductionReplayAnalyzerSourceError';
    this.code = code;

    for (const key of [
      'symbol',
      'field',
      'expected',
      'actual',
      'originalCode',
      'cause',
    ]) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}

function fail(code, message, details) {
  throw new ProductionReplayAnalyzerSourceError(code, message, details);
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

function assertPlainObject(value, label, code = 'INVALID_REQUEST') {
  if (!isPlainObject(value)) fail(code, `${label} must be a plain object`);
}

function assertExactKeys(value, expectedKeys, label, code = 'INVALID_REQUEST') {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || expectedKeys.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
    fail(code, `${label} must contain exactly ${expectedKeys.join(', ')}`);
  }
}

function isValidTimestamp(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && Number.isFinite(new Date(value).getTime());
}

function assertBoundIdentity({ client, symbol, coinId, vsCurrency } = {}) {
  if (!client || typeof client !== 'object' || Array.isArray(client)
    || typeof client.fetchHistoricalAnalyzerData !== 'function') {
    throw new TypeError('client.fetchHistoricalAnalyzerData must be a function');
  }
  if (typeof symbol !== 'string' || symbol.length === 0) {
    throw new TypeError('symbol must be a non-empty string');
  }
  if (typeof coinId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(coinId)) {
    throw new TypeError('coinId must be a lowercase CoinGecko identifier');
  }
  if (typeof vsCurrency !== 'string' || !/^[a-z][a-z0-9-]*$/.test(vsCurrency)) {
    throw new TypeError('vsCurrency must be a lowercase quote-currency identifier');
  }
}

function assertRequest(request, boundSymbol) {
  assertPlainObject(request, 'request');
  assertExactKeys(request, REQUEST_KEYS, 'request');

  if (typeof request.symbol !== 'string' || request.symbol.length === 0) {
    fail('INVALID_REQUEST', 'request.symbol must be a non-empty string');
  }
  if (request.symbol !== boundSymbol) {
    fail('SYMBOL_MISMATCH', 'request.symbol must match the bound symbol exactly', {
      symbol: request.symbol,
      expected: boundSymbol,
      actual: request.symbol,
    });
  }
  if (!isValidTimestamp(request.startTime)) {
    fail('INVALID_REQUEST', 'request.startTime must be a valid safe integer millisecond timestamp');
  }
  if (!isValidTimestamp(request.endTime)) {
    fail('INVALID_REQUEST', 'request.endTime must be a valid safe integer millisecond timestamp');
  }
  if (request.endTime <= request.startTime) {
    fail('INVALID_REQUEST', 'request.endTime must be greater than request.startTime');
  }

  return {
    symbol: request.symbol,
    startTime: request.startTime,
    endTime: request.endTime,
  };
}

function wrapSourceFailure(error) {
  return new ProductionReplayAnalyzerSourceError(
    'SOURCE_FAILURE',
    'Historical Analyzer source acquisition failed',
    {
      originalCode: error?.code,
      cause: error,
    },
  );
}

function assertEventTimestamp(timestamp, index) {
  if (!isValidTimestamp(timestamp)) {
    fail('SOURCE_CONTRACT', `events[${index}].timestamp must be a valid safe integer millisecond timestamp`, {
      field: 'timestamp',
      actual: timestamp,
    });
  }

  try {
    return new Date(timestamp).toISOString();
  } catch (error) {
    fail('SOURCE_CONTRACT', `events[${index}].timestamp cannot be converted to canonical ISO`, {
      field: 'timestamp',
      actual: timestamp,
      cause: error,
    });
  }
}

function assertDiagnostics(diagnostics, context, events) {
  assertPlainObject(diagnostics, 'result.diagnostics', 'SOURCE_CONTRACT');
  assertExactKeys(diagnostics, DIAGNOSTIC_KEYS, 'result.diagnostics', 'SOURCE_CONTRACT');

  const expectedCount = (context.endTime - context.startTime) / HOUR_MS;
  const checks = [
    ['provider', 'coingecko'],
    ['coinId', context.coinId],
    ['vsCurrency', context.vsCurrency],
    ['targetStartTime', context.startTime],
    ['targetEndTime', context.endTime],
    ['acquisitionStartTime', context.startTime - DAY_MS],
    ['acquisitionEndTime', context.endTime],
    ['eventCount', events.length],
    ['firstEventTimestamp', events[0]?.timestamp],
    ['lastEventTimestamp', events.at(-1)?.timestamp],
  ];

  for (const [field, expected] of checks) {
    if (diagnostics[field] !== expected) {
      fail('SOURCE_CONTRACT', `result.diagnostics.${field} does not match the source contract`, {
        field,
        expected,
        actual: diagnostics[field],
      });
    }
  }

  if (events.length !== expectedCount) {
    fail('SOURCE_CONTRACT', 'events.length does not match the requested hourly target count', {
      field: 'eventCount',
      expected: expectedCount,
      actual: events.length,
    });
  }
  if (typeof diagnostics.rawPayloadSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(diagnostics.rawPayloadSha256)) {
    fail('SOURCE_CONTRACT', 'result.diagnostics.rawPayloadSha256 must be 64 lowercase hexadecimal characters', {
      field: 'rawPayloadSha256',
      actual: diagnostics.rawPayloadSha256,
    });
  }
}

function validateDependencyResult(result, context) {
  assertPlainObject(result, 'result', 'SOURCE_CONTRACT');
  assertExactKeys(result, RESULT_KEYS, 'result', 'SOURCE_CONTRACT');

  if (!Array.isArray(result.events) || result.events.length === 0) {
    fail('SOURCE_CONTRACT', 'result.events must be a non-empty array', { field: 'events' });
  }

  const seenEvents = new WeakSet();
  const snapshots = [];
  for (let index = 0; index < result.events.length; index += 1) {
    if (!Object.hasOwn(result.events, index)) {
      fail('SOURCE_CONTRACT', 'result.events must be dense', {
        field: 'events',
        actual: index,
      });
    }

    const event = result.events[index];
    assertPlainObject(event, `result.events[${index}]`, 'SOURCE_CONTRACT');
    assertExactKeys(event, EVENT_KEYS, `result.events[${index}]`, 'SOURCE_CONTRACT');
    if (seenEvents.has(event)) {
      fail('SOURCE_CONTRACT', 'result.events must not share event object references', {
        field: 'events',
        actual: index,
      });
    }
    seenEvents.add(event);

    snapshots.push({
      timestamp: assertEventTimestamp(event.timestamp, index),
      price: event.price,
      volume: event.volume,
      change24h: event.change24h,
    });
  }

  assertDiagnostics(result.diagnostics, context, result.events);

  if (result.events[0].timestamp !== context.startTime) {
    fail('SOURCE_CONTRACT', 'first event timestamp must equal request.startTime', {
      field: 'timestamp',
      expected: context.startTime,
      actual: result.events[0].timestamp,
    });
  }
  if (result.events.at(-1).timestamp !== context.endTime - HOUR_MS) {
    fail('SOURCE_CONTRACT', 'last event timestamp must equal request.endTime minus one hour', {
      field: 'timestamp',
      expected: context.endTime - HOUR_MS,
      actual: result.events.at(-1).timestamp,
    });
  }

  return {
    snapshots,
    diagnostics: result.diagnostics,
    firstEventTimestamp: result.events[0].timestamp,
    lastEventTimestamp: result.events.at(-1).timestamp,
  };
}

class ProductionReplayAnalyzerSource {
  constructor(options = {}) {
    assertBoundIdentity(options);
    this.client = options.client;
    this.symbol = options.symbol;
    this.coinId = options.coinId;
    this.vsCurrency = options.vsCurrency;
    Object.freeze(this);
  }

  async fetch(request, { signal } = {}) {
    const context = assertRequest(request, this.symbol);
    throwIfAborted(signal);
    let result;
    try {
      const clientRequest = {
        startTime: context.startTime,
        endTime: context.endTime,
      };
      result = signal === undefined
        ? await this.client.fetchHistoricalAnalyzerData(clientRequest)
        : await this.client.fetchHistoricalAnalyzerData(clientRequest, { signal });
    } catch (error) {
      if (isCancellation(error, signal)) throw error;
      throw wrapSourceFailure(error);
    }
    throwIfAborted(signal);

    const validated = validateDependencyResult(result, {
      ...context,
      coinId: this.coinId,
      vsCurrency: this.vsCurrency,
    });

    const rawInput = {
      schemaVersion: 1,
      symbol: this.symbol,
      snapshots: validated.snapshots,
    };

    let analyzerInput;
    try {
      analyzerInput = normalizeReplayAnalyzerInput(rawInput);
    } catch (error) {
      throw new ProductionReplayAnalyzerSourceError(
        'NORMALIZATION_FAILURE',
        'Constructed Analyzer schema-v1 input was rejected',
        {
          originalCode: error?.code,
          cause: error,
        },
      );
    }

    const provenance = Object.freeze({
      sourceType: 'production-replay-analyzer',
      semanticMode: 'historical-equivalent',
      provider: 'coingecko',
      coinId: this.coinId,
      vsCurrency: this.vsCurrency,
      symbol: this.symbol,
      requestedStartTime: context.startTime,
      requestedEndTime: context.endTime,
      acquisitionStartTime: validated.diagnostics.acquisitionStartTime,
      acquisitionEndTime: validated.diagnostics.acquisitionEndTime,
      eventCount: analyzerInput.snapshots.length,
      firstEventTimestamp: validated.firstEventTimestamp,
      lastEventTimestamp: validated.lastEventTimestamp,
      rawPayloadSha256: validated.diagnostics.rawPayloadSha256,
    });

    return Object.freeze({ analyzerInput, provenance });
  }
}

module.exports = {
  ProductionReplayAnalyzerSource,
  ProductionReplayAnalyzerSourceError,
};
