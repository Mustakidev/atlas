const crypto = require('node:crypto');
const { throwIfAborted, isCancellation } = require('../core/cancellation');

const DEFAULT_BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFAULT_COIN_ID = 'bitcoin';
const DEFAULT_VS_CURRENCY = 'usd';
const DEFAULT_TIMEOUT_MS = 10000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PRE_ROLL_MS = DAY_MS;
const MAX_HOURLY_ACQUISITION_MS = 100 * DAY_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;

class CoinGeckoHistoricalAnalyzerClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoinGeckoHistoricalAnalyzerClientError';
    this.code = code;

    for (const key of ['status', 'field', 'series', 'timestamp']) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}

function fail(code, message, details) {
  throw new CoinGeckoHistoricalAnalyzerClientError(code, message, details);
}

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
}

function isValidDateMs(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && Number.isFinite(new Date(value).getTime());
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

  const apiKey = config.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new TypeError('config.apiKey must be a non-empty string');
  }

  const coinId = config.coinId ?? DEFAULT_COIN_ID;
  if (typeof coinId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(coinId)) {
    throw new TypeError('config.coinId must be a lowercase CoinGecko identifier');
  }

  const vsCurrency = config.vsCurrency ?? DEFAULT_VS_CURRENCY;
  if (typeof vsCurrency !== 'string' || !/^[a-z][a-z0-9-]*$/.test(vsCurrency)) {
    throw new TypeError('config.vsCurrency must be a valid lowercase currency identifier');
  }

  const timeout = config.timeout ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TypeError('config.timeout must be a positive safe integer');
  }

  return Object.freeze({ baseUrl, apiKey, coinId, vsCurrency, timeout });
}

function assertRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('INVALID_REQUEST', 'request must be a non-array object');
  }

  const { startTime, endTime } = request;
  if (!isValidDateMs(startTime) || !isValidDateMs(endTime)) {
    fail('INVALID_REQUEST', 'startTime and endTime must be valid safe integer millisecond timestamps');
  }
  if (startTime < PRE_ROLL_MS) {
    fail('INVALID_REQUEST', 'startTime must leave room for the 24-hour pre-roll');
  }
  if (endTime <= startTime) {
    fail('INVALID_REQUEST', 'endTime must be greater than startTime');
  }
  const acquisitionStartTime = startTime - PRE_ROLL_MS;
  const acquisitionDuration = endTime - acquisitionStartTime;
  if (acquisitionDuration > MAX_HOURLY_ACQUISITION_MS) {
    fail('INVALID_REQUEST', 'acquisition range must not exceed 100 days');
  }
  if (startTime % HOUR_MS !== 0 || endTime % HOUR_MS !== 0) {
    fail('INVALID_REQUEST', 'startTime and endTime must align to one-hour boundaries');
  }

  return Object.freeze({
    startTime,
    endTime,
    acquisitionStartTime,
    acquisitionEndTime: endTime,
    expectedTargetCount: (endTime - startTime) / HOUR_MS,
    expectedAcquisitionCount: acquisitionDuration / HOUR_MS + 1,
  });
}

function buildUrl(config, request) {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const url = new URL(`${encodeURIComponent(config.coinId)}/market_chart/range`, `${baseUrl}/coins/`);
  url.search = new URLSearchParams({
    vs_currency: config.vsCurrency,
    from: String(request.acquisitionStartTime / 1000),
    to: String(request.acquisitionEndTime / 1000),
    interval: 'hourly',
    precision: 'full',
  }).toString();
  return url;
}

function assertPoint(point, series, index) {
  if (!Array.isArray(point) || point.length !== 2
    || !Object.hasOwn(point, 0) || !Object.hasOwn(point, 1)) {
    fail('PROVIDER_CONTRACT', `Provider ${series} point ${index} must be a two-element array`, { series });
  }

  const [timestamp, value] = point;
  if (!isValidDateMs(timestamp)) {
    fail('INVALID_NUMERIC_VALUE', `Provider ${series} timestamp ${index} must be a safe integer millisecond timestamp`, {
      series,
      field: 'timestamp',
      timestamp,
    });
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('INVALID_NUMERIC_VALUE', `Provider ${series} value ${index} must be finite`, {
      series,
      field: 'value',
      timestamp,
    });
  }
  if (series === 'prices' && value <= 0) {
    fail('INVALID_NUMERIC_VALUE', `Provider price ${index} must be greater than zero`, {
      series,
      field: 'value',
      timestamp,
    });
  }
  if (series === 'total_volumes' && value < 0) {
    fail('INVALID_NUMERIC_VALUE', `Provider volume ${index} must be non-negative`, {
      series,
      field: 'value',
      timestamp,
    });
  }
}

function validateSeries(series, name) {
  if (!Array.isArray(series) || series.length === 0) {
    fail('INCOMPLETE_HORIZON', `Provider ${name} must contain the complete acquisition range`, { series: name });
  }

  const timestamps = [];
  const seen = new Set();
  for (let index = 0; index < series.length; index += 1) {
    assertPoint(series[index], name, index);
    const timestamp = series[index][0];
    if (seen.has(timestamp)) {
      fail('DUPLICATE_TIMESTAMP', `Provider ${name} contains a duplicate timestamp`, {
        series: name,
        timestamp,
      });
    }
    if (timestamps.length > 0 && timestamp < timestamps[timestamps.length - 1]) {
      fail('NON_MONOTONIC_TIMESTAMP', `Provider ${name} timestamps must be strictly increasing`, {
        series: name,
        timestamp,
      });
    }
    seen.add(timestamp);
    timestamps.push(timestamp);
  }

  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] - timestamps[index - 1] !== HOUR_MS) {
      fail('UNSUPPORTED_CADENCE', `Provider ${name} cadence must be exactly hourly`, {
        series: name,
        timestamp: timestamps[index],
      });
    }
  }

  return timestamps;
}

function validateCoverage(timestamps, name, request, seriesLength) {
  if (seriesLength !== request.expectedAcquisitionCount
    || timestamps[0] !== request.acquisitionStartTime
    || timestamps[timestamps.length - 1] !== request.acquisitionEndTime) {
    fail('INCOMPLETE_HORIZON', `Provider ${name} does not cover the complete acquisition range`, {
      series: name,
      timestamp: timestamps[0] !== request.acquisitionStartTime
        ? timestamps[0]
        : timestamps[timestamps.length - 1],
    });
  }
}

function hashRawPayload(payload) {
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    fail('PROVIDER_CONTRACT', 'Provider response could not be serialized deterministically');
  }
  if (typeof serialized !== 'string') {
    fail('PROVIDER_CONTRACT', 'Provider response could not be serialized deterministically');
  }
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function validateRoot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('PROVIDER_CONTRACT', 'Provider response root must be a non-array object');
  }
  if (!Object.hasOwn(payload, 'prices')) fail('PROVIDER_CONTRACT', 'Provider response is missing prices');
  if (!Object.hasOwn(payload, 'total_volumes')) {
    fail('PROVIDER_CONTRACT', 'Provider response is missing total_volumes');
  }
}

function createEvents(payload, request, priceTimestamps, volumeTimestamps) {
  if (priceTimestamps.length !== volumeTimestamps.length
    || priceTimestamps.some((timestamp, index) => timestamp !== volumeTimestamps[index])) {
    fail('TIMESTAMP_MISMATCH', 'Provider prices and total_volumes timestamps must match exactly');
  }

  const prices = payload.prices;
  const volumes = payload.total_volumes;
  const pricesByTimestamp = new Map(prices.map(point => [point[0], point[1]]));
  const events = [];

  for (let index = 0; index < prices.length; index += 1) {
    const timestamp = priceTimestamps[index];
    if (timestamp < request.startTime || timestamp >= request.endTime) continue;

    const referenceTimestamp = timestamp - PRE_ROLL_MS;
    if (!pricesByTimestamp.has(referenceTimestamp)) {
      fail('MISSING_24H_REFERENCE', 'Provider price is missing its exact 24-hour reference', {
        timestamp,
      });
    }
    const price = prices[index][1];
    const referencePrice = pricesByTimestamp.get(referenceTimestamp);
    const volume = volumes[index][1];
    const change24h = (price / referencePrice - 1) * 100;
    if (!Number.isFinite(change24h)) {
      fail('INVALID_NUMERIC_VALUE', 'Derived change24h must be finite', {
        field: 'change24h',
        timestamp,
      });
    }

    events.push({ timestamp, price, volume, change24h });
  }

  if (events.length !== request.expectedTargetCount) {
    fail('INCOMPLETE_HORIZON', 'Provider response did not produce the complete target horizon');
  }
  return events;
}

async function readProviderResponse(fetch, url, config, signal) {
  throwIfAborted(signal);
  let response;
  try {
    const fetchOptions = {
      headers: { 'x-cg-demo-api-key': config.apiKey },
      timeout: config.timeout,
    };
    if (signal !== undefined) fetchOptions.signal = signal;
    response = await fetch(url.toString(), fetchOptions);
    throwIfAborted(signal);
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    fail('PROVIDER_UNAVAILABLE', 'CoinGecko request failed');
  }

  if (!response || typeof response.status !== 'number') {
    fail('PROVIDER_CONTRACT', 'CoinGecko response must expose an HTTP status');
  }
  if (response.status === 401 || response.status === 403) {
    fail('UNAUTHORIZED', `CoinGecko authorization failed with HTTP ${response.status}`, { status: response.status });
  }
  if (response.status === 429) {
    fail('RATE_LIMITED', 'CoinGecko rate limit response', { status: response.status });
  }
  if (response.status >= 500 && response.status <= 599) {
    fail('PROVIDER_UNAVAILABLE', `CoinGecko unavailable with HTTP ${response.status}`, { status: response.status });
  }
  if (response.status < 200 || response.status >= 300) {
    fail('PROVIDER_CONTRACT', `CoinGecko returned unexpected HTTP ${response.status}`, { status: response.status });
  }
  if (typeof response.json !== 'function') {
    fail('PROVIDER_CONTRACT', 'CoinGecko response must expose json()');
  }

  try {
    const payload = await response.json();
    throwIfAborted(signal);
    return payload;
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    fail('PROVIDER_CONTRACT', 'CoinGecko response was not valid JSON');
  }
}

class CoinGeckoHistoricalAnalyzerClient {
  #fetch;

  #config;

  constructor({ fetch, logger, config } = {}) {
    assertFunction(fetch, 'fetch');
    if (logger !== undefined && (!logger || typeof logger !== 'object')) {
      throw new TypeError('logger must be an object');
    }
    this.#fetch = fetch;
    this.#config = normalizeConfig(config);
  }

  async fetchHistoricalAnalyzerData(request, { signal } = {}) {
    const normalizedRequest = assertRequest(request);
    throwIfAborted(signal);
    const url = buildUrl(this.#config, normalizedRequest);
    const payload = await readProviderResponse(this.#fetch, url, this.#config, signal);
    throwIfAborted(signal);
    validateRoot(payload);
    const rawPayloadSha256 = hashRawPayload(payload);
    const priceTimestamps = validateSeries(payload.prices, 'prices');
    const volumeTimestamps = validateSeries(payload.total_volumes, 'total_volumes');
    if (priceTimestamps.length !== volumeTimestamps.length
      || priceTimestamps.some((timestamp, index) => timestamp !== volumeTimestamps[index])) {
      fail('TIMESTAMP_MISMATCH', 'Provider prices and total_volumes timestamps must match exactly');
    }
    validateCoverage(priceTimestamps, 'prices', normalizedRequest, payload.prices.length);
    validateCoverage(volumeTimestamps, 'total_volumes', normalizedRequest, payload.total_volumes.length);
    const events = createEvents(payload, normalizedRequest, priceTimestamps, volumeTimestamps);
    throwIfAborted(signal);

    return {
      events,
      diagnostics: {
        provider: 'coingecko',
        coinId: this.#config.coinId,
        vsCurrency: this.#config.vsCurrency,
        targetStartTime: normalizedRequest.startTime,
        targetEndTime: normalizedRequest.endTime,
        acquisitionStartTime: normalizedRequest.acquisitionStartTime,
        acquisitionEndTime: normalizedRequest.acquisitionEndTime,
        eventCount: events.length,
        firstEventTimestamp: events[0].timestamp,
        lastEventTimestamp: events[events.length - 1].timestamp,
        rawPayloadSha256,
      },
    };
  }
}

module.exports = {
  CoinGeckoHistoricalAnalyzerClient,
  CoinGeckoHistoricalAnalyzerClientError,
};
