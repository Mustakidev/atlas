const {
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_DURATIONS_MS,
} = require('../network/binanceKlineClient');

const MAX_DATE_MS = 8640000000000000;
const PRIMARY_TIMEFRAME = '1h';
const PRIMARY_DURATION_MS = TIMEFRAME_DURATIONS_MS[PRIMARY_TIMEFRAME];
const PROVIDER_IDENTITY = 'binance-spot-klines';

class ProductionReplayMtfSourceError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProductionReplayMtfSourceError';
    this.code = code;

    for (const key of [
      'symbol',
      'timeframe',
      'failedTimeframe',
      'startTime',
      'endTime',
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
  throw new ProductionReplayMtfSourceError(code, message, details);
}

function isValidTimestamp(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && Number.isFinite(new Date(value).getTime());
}

function assertRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('INVALID_REQUEST', 'request must be a non-array object');
  }

  const { symbol, startTime, endTime } = request;
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,20}$/.test(symbol)) {
    fail('INVALID_REQUEST', 'symbol must be an uppercase alphanumeric Binance symbol', { symbol });
  }
  if (!isValidTimestamp(startTime) || !isValidTimestamp(endTime)) {
    fail('INVALID_REQUEST', 'startTime and endTime must be valid safe integer millisecond timestamps', {
      symbol,
      startTime,
      endTime,
    });
  }
  if (endTime <= startTime) {
    fail('INVALID_REQUEST', 'endTime must be greater than startTime', { symbol, startTime, endTime });
  }
  if (startTime % PRIMARY_DURATION_MS !== 0) {
    fail('UNALIGNED_HORIZON', 'startTime must align to 1h', { symbol, startTime, endTime });
  }
  if (endTime % PRIMARY_DURATION_MS !== 0) {
    fail('UNALIGNED_HORIZON', 'endTime must align to 1h', { symbol, startTime, endTime });
  }

  return { symbol, startTime, endTime };
}

function streamFailure(error, context, timeframe) {
  return new ProductionReplayMtfSourceError(
    'STREAM_FAILURE',
    `Historical ${timeframe} stream acquisition failed`,
    {
      ...context,
      timeframe,
      failedTimeframe: timeframe,
      originalCode: error?.code,
      cause: error,
    },
  );
}

function streamContractFailure(message, context, timeframe, details = {}) {
  fail('STREAM_CONTRACT', message, {
    ...context,
    timeframe,
    ...details,
  });
}

function crossStreamFailure(message, context, timeframe, field, expected, actual) {
  fail('CROSS_STREAM_MISMATCH', message, {
    ...context,
    timeframe,
    field,
    expected,
    actual,
  });
}

function assertDiagnostic(diagnostics, field, expected, context, timeframe) {
  if (diagnostics[field] !== expected) {
    crossStreamFailure(
      `Historical ${timeframe} diagnostics.${field} does not match the request`,
      context,
      timeframe,
      field,
      expected,
      diagnostics[field],
    );
  }
}

function validateStreamResult(result, context, timeframe, seenArrays, seenCandles) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    streamContractFailure('Historical stream result must be an object', context, timeframe);
  }
  if (!Array.isArray(result.candles)) {
    streamContractFailure('Historical stream result.candles must be an array', context, timeframe);
  }
  if (!result.diagnostics || typeof result.diagnostics !== 'object' || Array.isArray(result.diagnostics)) {
    streamContractFailure('Historical stream result.diagnostics must be an object', context, timeframe);
  }

  const { diagnostics, candles } = result;
  if (seenArrays.has(candles)) {
    streamContractFailure(
      `Historical ${timeframe} stream reuses the ${seenArrays.get(candles)} stream array`,
      context,
      timeframe,
    );
  }
  seenArrays.set(candles, timeframe);

  assertDiagnostic(diagnostics, 'provider', PROVIDER_IDENTITY, context, timeframe);
  assertDiagnostic(diagnostics, 'symbol', context.symbol, context, timeframe);
  assertDiagnostic(diagnostics, 'timeframe', timeframe, context, timeframe);
  assertDiagnostic(diagnostics, 'startTime', context.startTime, context, timeframe);
  assertDiagnostic(diagnostics, 'endTime', context.endTime, context, timeframe);
  assertDiagnostic(diagnostics, 'candleCount', candles.length, context, timeframe);

  const durationMs = TIMEFRAME_DURATIONS_MS[timeframe];
  const expectedCount = (context.endTime - context.startTime) / durationMs;
  if (candles.length !== expectedCount) {
    crossStreamFailure(
      `Historical ${timeframe} candle count does not match the requested horizon`,
      context,
      timeframe,
      'candleCount',
      expectedCount,
      candles.length,
    );
  }

  assertDiagnostic(diagnostics, 'firstOpenTime', context.startTime, context, timeframe);
  assertDiagnostic(
    diagnostics,
    'lastOpenTime',
    context.endTime - durationMs,
    context,
    timeframe,
  );

  for (const candle of candles) {
    if (!candle || typeof candle !== 'object' || Array.isArray(candle)) {
      streamContractFailure('Historical stream candles must be objects', context, timeframe);
    }
    if (Object.hasOwn(candle, 'closeTime')) {
      streamContractFailure('Historical stream candles must not expose closeTime', context, timeframe);
    }
    const owner = seenCandles.get(candle);
    if (owner !== undefined && owner !== timeframe) {
      streamContractFailure(
        `Historical ${timeframe} stream reuses a candle object from ${owner}`,
        context,
        timeframe,
      );
    }
    seenCandles.set(candle, timeframe);
  }

  return { candles, diagnostics };
}

function buildProvenance(context, streams) {
  const provenanceStreams = {};
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const diagnostics = streams[timeframe].diagnostics;
    provenanceStreams[timeframe] = {
      timeframe,
      independent: true,
      pageCount: diagnostics.pageCount,
      attemptCount: diagnostics.attemptCount,
      candleCount: diagnostics.candleCount,
      firstOpenTime: diagnostics.firstOpenTime,
      lastOpenTime: diagnostics.lastOpenTime,
    };
  }

  return {
    provider: PROVIDER_IDENTITY,
    symbol: context.symbol,
    requestedStartTime: context.startTime,
    requestedEndTime: context.endTime,
    streams: provenanceStreams,
  };
}

class ProductionReplayMtfSource {
  constructor({ client } = {}) {
    if (!client || typeof client.fetchCandles !== 'function') {
      throw new TypeError('client.fetchCandles must be a function');
    }
    this.client = client;
  }

  async fetch(request) {
    const context = assertRequest(request);
    const streams = {};
    const seenArrays = new Map();
    const seenCandles = new WeakMap();

    for (const timeframe of SUPPORTED_TIMEFRAMES) {
      let result;
      try {
        result = await this.client.fetchCandles({
          symbol: context.symbol,
          timeframe,
          startTime: context.startTime,
          endTime: context.endTime,
        });
      } catch (error) {
        throw streamFailure(error, context, timeframe);
      }

      streams[timeframe] = validateStreamResult(
        result,
        context,
        timeframe,
        seenArrays,
        seenCandles,
      );
    }

    const rawTimeframes = {};
    for (const timeframe of SUPPORTED_TIMEFRAMES) {
      rawTimeframes[timeframe] = [...streams[timeframe].candles];
    }

    return {
      rawInput: {
        schemaVersion: 2,
        primaryTimeframe: PRIMARY_TIMEFRAME,
        sourcePolicy: 'independent',
        timeframes: rawTimeframes,
      },
      provenance: buildProvenance(context, streams),
    };
  }
}

module.exports = {
  ProductionReplayMtfSource,
  ProductionReplayMtfSourceError,
  PRODUCTION_REPLAY_MTF_TIMEFRAMES: SUPPORTED_TIMEFRAMES,
  PRODUCTION_REPLAY_MTF_PROVIDER: PROVIDER_IDENTITY,
};
