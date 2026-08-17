const DEFAULT_BASE_URL = 'https://data-api.binance.vision';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const MAX_FALLBACK_BACKOFF_MS = 30000;
const MAX_PAGE_SIZE = 1000;
const MAX_DATE_MS = 8640000000000000;

const TIMEFRAME_DURATIONS_MS = Object.freeze({
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
});

const SUPPORTED_TIMEFRAMES = Object.freeze(Object.keys(TIMEFRAME_DURATIONS_MS));

class BinanceKlineClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BinanceKlineClientError';
    this.code = code;
    this.retryable = details.retryable ?? false;

    for (const key of [
      'symbol',
      'timeframe',
      'cursor',
      'status',
      'retryable',
      'attempts',
      'lastCode',
      'retryAfterMs',
      'cause',
    ]) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}

function fail(code, message, details) {
  throw new BinanceKlineClientError(code, message, details);
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

function normalizeConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be a non-array object');
  }

  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('config.baseUrl must be a non-empty string');
  }
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new TypeError('config.baseUrl must use HTTP or HTTPS');
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === 'config.baseUrl must use HTTP or HTTPS') {
      throw error;
    }
    throw new TypeError('config.baseUrl must be a valid URL');
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('config.timeoutMs must be a positive safe integer');
  }

  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    throw new TypeError(`config.pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }

  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > DEFAULT_MAX_ATTEMPTS) {
    throw new TypeError(`config.maxAttempts must be an integer between 1 and ${DEFAULT_MAX_ATTEMPTS}`);
  }

  const initialBackoffMs = config.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  if (!Number.isSafeInteger(initialBackoffMs) || initialBackoffMs < 0) {
    throw new TypeError('config.initialBackoffMs must be a non-negative safe integer');
  }

  return Object.freeze({
    baseUrl,
    timeoutMs,
    pageSize,
    maxAttempts,
    initialBackoffMs,
  });
}

function isValidDateMs(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && Number.isFinite(new Date(value).getTime());
}

function assertRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('INVALID_REQUEST', 'request must be a non-array object');
  }

  const { symbol, timeframe, startTime, endTime } = request;
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,20}$/.test(symbol)) {
    fail('INVALID_REQUEST', 'symbol must be an uppercase alphanumeric Binance symbol', { symbol });
  }
  if (!Object.hasOwn(TIMEFRAME_DURATIONS_MS, timeframe)) {
    fail('UNSUPPORTED_TIMEFRAME', `Unsupported Binance kline timeframe: ${String(timeframe)}`, {
      symbol,
      timeframe,
    });
  }
  if (!isValidDateMs(startTime) || !isValidDateMs(endTime)) {
    fail('INVALID_REQUEST', 'startTime and endTime must be valid safe integer millisecond timestamps', {
      symbol,
      timeframe,
    });
  }
  if (endTime <= startTime) {
    fail('INVALID_REQUEST', 'endTime must be greater than startTime', { symbol, timeframe });
  }

  const durationMs = TIMEFRAME_DURATIONS_MS[timeframe];
  if (startTime % durationMs !== 0) {
    fail('UNALIGNED_HORIZON', `startTime must align to ${timeframe}`, { symbol, timeframe, cursor: startTime });
  }
  if (endTime % durationMs !== 0) {
    fail('UNALIGNED_HORIZON', `endTime must align to ${timeframe}`, { symbol, timeframe, cursor: endTime });
  }

  return Object.freeze({
    symbol,
    timeframe,
    startTime,
    endTime,
    durationMs,
    expectedCount: (endTime - startTime) / durationMs,
  });
}

function parseDecimal(value, field, context) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    fail('PROVIDER_CONTRACT', `Provider ${field} must be a decimal string`, context);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail('PROVIDER_CONTRACT', `Provider ${field} must convert to a finite number`, context);
  }
  return number;
}

function parseProviderTimestamp(value, field, context) {
  if (!isValidDateMs(value)) {
    fail('PROVIDER_CONTRACT', `Provider ${field} must be a safe integer millisecond timestamp`, context);
  }
  return value;
}

function hasOwnIndex(row, index) {
  return Object.hasOwn(row, index);
}

function mapProviderRow(row, requestContext) {
  const { symbol, timeframe, durationMs } = requestContext;
  if (!Array.isArray(row) || row.length < 12) {
    fail('PROVIDER_CONTRACT', 'Provider kline row must contain at least 12 positions', {
      symbol,
      timeframe,
    });
  }
  for (let index = 0; index < 12; index++) {
    if (!hasOwnIndex(row, index)) {
      fail('PROVIDER_CONTRACT', `Provider kline row is missing position ${index}`, { symbol, timeframe });
    }
  }

  const openTime = parseProviderTimestamp(row[0], 'openTime', { symbol, timeframe });
  const open = parseDecimal(row[1], 'open', { symbol, timeframe, cursor: openTime });
  const high = parseDecimal(row[2], 'high', { symbol, timeframe, cursor: openTime });
  const low = parseDecimal(row[3], 'low', { symbol, timeframe, cursor: openTime });
  const close = parseDecimal(row[4], 'close', { symbol, timeframe, cursor: openTime });
  const volume = parseDecimal(row[5], 'volume', { symbol, timeframe, cursor: openTime });
  const closeTime = parseProviderTimestamp(row[6], 'closeTime', { symbol, timeframe, cursor: openTime });
  parseDecimal(row[7], 'quoteAssetVolume', { symbol, timeframe, cursor: openTime });
  if (!Number.isSafeInteger(row[8]) || row[8] < 0) {
    fail('PROVIDER_CONTRACT', 'Provider numberOfTrades must be a non-negative safe integer', {
      symbol,
      timeframe,
      cursor: openTime,
    });
  }
  parseDecimal(row[9], 'takerBuyBaseAssetVolume', { symbol, timeframe, cursor: openTime });
  parseDecimal(row[10], 'takerBuyQuoteAssetVolume', { symbol, timeframe, cursor: openTime });
  if (typeof row[11] !== 'string') {
    fail('PROVIDER_CONTRACT', 'Provider unused kline field must be a string', {
      symbol,
      timeframe,
      cursor: openTime,
    });
  }

  if (closeTime !== openTime + durationMs - 1) {
    fail('PROVIDER_CONTRACT', 'Provider closeTime does not match timeframe duration', {
      symbol,
      timeframe,
      cursor: openTime,
    });
  }

  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  if (Object.hasOwn(headers, name)) return headers[name];
  const lowerName = name.toLowerCase();
  if (Object.hasOwn(headers, lowerName)) return headers[lowerName];
  const matchingName = Object.keys(headers).find(key => key.toLowerCase() === lowerName);
  if (matchingName !== undefined) return headers[matchingName];
  return undefined;
}

function parseRetryAfterMs(headers) {
  const value = getHeader(headers, 'retry-after');
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return seconds * 1000;
}

function createHttpError(response, requestContext) {
  const { symbol, timeframe, cursor } = requestContext;
  const status = response.status;
  if (status === 429) {
    return new BinanceKlineClientError('RATE_LIMITED', 'Binance rate limit response', {
      symbol,
      timeframe,
      cursor,
      status,
      retryable: true,
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }

  return new BinanceKlineClientError('HTTP_ERROR', `Binance HTTP ${status}`, {
    symbol,
    timeframe,
    cursor,
    status,
    retryable: status >= 500 && status <= 599,
  });
}

function isTimeoutError(error) {
  return error?.type === 'request-timeout'
    || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'].includes(error?.code)
    || error?.name === 'TimeoutError'
    || /timeout/i.test(error?.message || '');
}

function toTransportError(error, requestContext) {
  if (error instanceof BinanceKlineClientError) return error;
  const code = isTimeoutError(error) ? 'TIMEOUT' : 'NETWORK_ERROR';
  return new BinanceKlineClientError(code, `Binance ${code.toLowerCase()}`, {
    ...requestContext,
    retryable: true,
    cause: error,
  });
}

class BinanceKlineClient {
  constructor({ fetch, logger, sleep, config } = {}) {
    assertFunction(fetch, 'fetch');
    assertFunction(sleep, 'sleep');
    if (!logger || typeof logger !== 'object') throw new TypeError('logger must be an object');
    for (const method of ['info', 'warn', 'error']) assertFunction(logger[method], `logger.${method}`);

    this.fetch = fetch;
    this.logger = logger;
    this.sleep = sleep;
    this.config = normalizeConfig(config);
  }

  buildPageUrl(requestContext, cursor) {
    const url = new URL('/api/v3/klines', this.config.baseUrl);
    url.search = new URLSearchParams({
      symbol: requestContext.symbol,
      interval: requestContext.timeframe,
      startTime: String(cursor),
      endTime: String(requestContext.endTime - 1),
      limit: String(this.config.pageSize),
      timeZone: '0',
    }).toString();
    return url;
  }

  async requestPage(requestContext, cursor) {
    const url = this.buildPageUrl(requestContext, cursor);
    let response;
    try {
      response = await this.fetch(url.toString(), { timeout: this.config.timeoutMs });
    } catch (error) {
      throw toTransportError(error, { ...requestContext, cursor });
    }

    if (!response || typeof response.status !== 'number') {
      fail('PROVIDER_CONTRACT', 'Provider response must expose an HTTP status', {
        ...requestContext,
        cursor,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw createHttpError(response, { ...requestContext, cursor });
    }
    if (typeof response.json !== 'function') {
      fail('PROVIDER_CONTRACT', 'Provider response must expose json()', { ...requestContext, cursor });
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new BinanceKlineClientError('PROVIDER_CONTRACT', 'Provider response was not valid JSON', {
        ...requestContext,
        cursor,
        cause: error,
      });
    }
    return body;
  }

  calculateRetryDelay(error, retryIndex) {
    if (error.code === 'RATE_LIMITED' && error.retryAfterMs !== undefined) {
      return error.retryAfterMs;
    }

    const baseDelay = this.config.initialBackoffMs * (2 ** retryIndex);
    const fallbackDelay = error.code === 'RATE_LIMITED' ? baseDelay * 2 : baseDelay;
    return Math.min(fallbackDelay, MAX_FALLBACK_BACKOFF_MS);
  }

  async requestPageWithRetry(requestContext, cursor, attempts) {
    let lastError;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      attempts.count += 1;
      try {
        const body = await this.requestPage(requestContext, cursor);
        return body;
      } catch (error) {
        lastError = error instanceof BinanceKlineClientError
          ? error
          : toTransportError(error, { ...requestContext, cursor });

        if (!lastError.retryable || attempt === this.config.maxAttempts) break;

        const delayMs = this.calculateRetryDelay(lastError, attempt - 1);
        this.logger.warn('BinanceKlineClient', 'Retrying historical kline request', {
          symbol: requestContext.symbol,
          timeframe: requestContext.timeframe,
          cursor,
          status: lastError.status,
          attempt,
          maxAttempts: this.config.maxAttempts,
          delayMs,
        });
        await this.sleep(delayMs);
      }
    }

    if (lastError.retryable) {
      throw new BinanceKlineClientError('RETRY_EXHAUSTED', 'Binance historical kline retries exhausted', {
        symbol: requestContext.symbol,
        timeframe: requestContext.timeframe,
        cursor,
        status: lastError.status,
        retryable: false,
        attempts: this.config.maxAttempts,
        lastCode: lastError.code,
        cause: lastError,
      });
    }
    throw lastError;
  }

  validatePage(body, requestContext, cursor, seenOpenTimes) {
    if (!Array.isArray(body)) {
      fail('PROVIDER_CONTRACT', 'Provider kline response must be an array', {
        ...requestContext,
        cursor,
      });
    }
    if (body.length === 0) {
      fail('INCOMPLETE_HISTORY', 'Provider returned an empty page before the requested horizon ended', {
        ...requestContext,
        cursor,
      });
    }
    if (body.length > this.config.pageSize) {
      fail('PROVIDER_CONTRACT', 'Provider returned more rows than the requested page size', {
        ...requestContext,
        cursor,
      });
    }

    const pageCandles = body.map(row => mapProviderRow(row, requestContext));
    let previousOpenTime = null;
    for (const candle of pageCandles) {
      if (candle.openTime < requestContext.startTime || candle.openTime >= requestContext.endTime) {
        fail('PAGINATION_ERROR', 'Provider candle is outside the requested horizon', {
          ...requestContext,
          cursor: candle.openTime,
        });
      }
      if (candle.openTime % requestContext.durationMs !== 0) {
        fail('PAGINATION_ERROR', 'Provider candle is not aligned to the requested timeframe', {
          ...requestContext,
          cursor: candle.openTime,
        });
      }
      if (seenOpenTimes.has(candle.openTime)) {
        fail('PAGINATION_ERROR', 'Provider returned a duplicate or overlapping candle', {
          ...requestContext,
          cursor: candle.openTime,
        });
      }
      if (previousOpenTime !== null) {
        const spacing = candle.openTime - previousOpenTime;
        if (spacing !== requestContext.durationMs) {
          fail('PAGINATION_ERROR', 'Provider candle spacing contains an order error or gap', {
            ...requestContext,
            cursor: candle.openTime,
          });
        }
      }
      previousOpenTime = candle.openTime;
    }

    if (pageCandles[0].openTime !== cursor) {
      fail('PAGINATION_ERROR', 'Provider page does not begin at the expected cursor', {
        ...requestContext,
        cursor: pageCandles[0].openTime,
      });
    }

    for (const candle of pageCandles) seenOpenTimes.add(candle.openTime);
    return pageCandles;
  }

  async fetchCandles(request) {
    const requestContext = assertRequest(request);
    const candles = [];
    const seenOpenTimes = new Set();
    const attempts = { count: 0 };
    let pageCount = 0;
    let cursor = requestContext.startTime;

    while (cursor < requestContext.endTime) {
      const body = await this.requestPageWithRetry(requestContext, cursor, attempts);
      const pageCandles = this.validatePage(body, requestContext, cursor, seenOpenTimes);
      candles.push(...pageCandles);
      pageCount += 1;

      const lastOpenTime = pageCandles.at(-1).openTime;
      const nextCursor = lastOpenTime + requestContext.durationMs;
      if (!Number.isSafeInteger(nextCursor) || nextCursor > requestContext.endTime) {
        fail('PAGINATION_ERROR', 'Provider pagination advanced beyond the requested horizon', {
          ...requestContext,
          cursor: nextCursor,
        });
      }
      cursor = nextCursor;
    }

    if (cursor !== requestContext.endTime) {
      fail('PAGINATION_ERROR', 'Provider pagination did not terminate at the requested end', {
        ...requestContext,
        cursor,
      });
    }
    if (candles.length !== requestContext.expectedCount) {
      fail('INCOMPLETE_HISTORY', 'Provider returned an unexpected candle count', {
        ...requestContext,
        cursor,
      });
    }
    if (candles[0]?.openTime !== requestContext.startTime
      || candles.at(-1)?.openTime !== requestContext.endTime - requestContext.durationMs) {
      fail('INCOMPLETE_HISTORY', 'Provider returned unexpected horizon boundaries', {
        ...requestContext,
        cursor,
      });
    }

    return {
      candles,
      diagnostics: {
        provider: 'binance-spot-klines',
        symbol: requestContext.symbol,
        timeframe: requestContext.timeframe,
        startTime: requestContext.startTime,
        endTime: requestContext.endTime,
        pageCount,
        attemptCount: attempts.count,
        candleCount: candles.length,
        firstOpenTime: candles[0].openTime,
        lastOpenTime: candles.at(-1).openTime,
      },
    };
  }
}

module.exports = {
  BinanceKlineClient,
  BinanceKlineClientError,
  DEFAULT_BASE_URL,
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_DURATIONS_MS,
};
