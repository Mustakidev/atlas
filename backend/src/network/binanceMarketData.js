const { throwIfAborted, isCancellation } = require('../core/cancellation');

const DEFAULT_BASE_URL = 'https://data-api.binance.vision';
const BAR_DURATION_MS = 60_000;
const MAX_KLINE_LIMIT = 1000;

// Atlas timeframe -> Binance kline interval used to seed each candle series.
const SEED_INTERVALS = Object.freeze({
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '12h': '12h',
  '24h': '1d',
});

const INTERVAL_DURATIONS_MS = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
});

class BinanceMarketDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BinanceMarketDataError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.headers !== undefined) this.headers = details.headers;
  }
}

function fail(code, message, details) {
  throw new BinanceMarketDataError(code, message, details);
}

function parseDecimal(value, field) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    fail('PROVIDER_CONTRACT', `Binance ${field} must be a decimal string`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) fail('PROVIDER_CONTRACT', `Binance ${field} must be finite`);
  return number;
}

function parseSignedDecimal(value, field) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    fail('PROVIDER_CONTRACT', `Binance ${field} must be a decimal string`);
  }
  return Number(value);
}

function parseKline(row, interval) {
  if (!Array.isArray(row) || row.length < 7) fail('PROVIDER_CONTRACT', 'Binance kline row is malformed');
  const openTime = row[0];
  const closeTime = row[6];
  const durationMs = INTERVAL_DURATIONS_MS[interval];
  if (!Number.isSafeInteger(openTime) || openTime % durationMs !== 0) {
    fail('PROVIDER_CONTRACT', 'Binance kline openTime is not aligned to its interval');
  }
  if (closeTime !== openTime + durationMs - 1) {
    fail('PROVIDER_CONTRACT', 'Binance kline closeTime does not match its interval');
  }
  const candle = {
    openTime,
    closeTime,
    open: parseDecimal(row[1], 'open'),
    high: parseDecimal(row[2], 'high'),
    low: parseDecimal(row[3], 'low'),
    close: parseDecimal(row[4], 'close'),
    volume: parseDecimal(row[5], 'volume'),
  };
  if (candle.low <= 0 || candle.high < candle.low
    || candle.open < candle.low || candle.open > candle.high
    || candle.close < candle.low || candle.close > candle.high) {
    fail('PROVIDER_CONTRACT', 'Binance kline OHLC values are inconsistent');
  }
  return candle;
}

function toCandle({ openTime, open, high, low, close, volume }) {
  return { openTime, open, high, low, close, volume, timestamp: new Date(openTime).toISOString() };
}

/**
 * Live market data from Binance spot klines.
 *
 * Each live cycle returns the 1-minute bars that closed since the caller's last
 * ingested bar plus the bar still forming. Candle engines aggregate closed bars
 * exactly into every timeframe, so OHLCV is exchange-accurate instead of being
 * approximated from sparse price polling.
 */
class BinanceMarketData {
  constructor({ fetch, config, logger, retry, cache, clock, baseUrl } = {}) {
    if (typeof fetch !== 'function') throw new TypeError('fetch must be a function');
    if (!config || typeof config.get !== 'function') throw new TypeError('config.get must be a function');
    if (!retry || typeof retry.execute !== 'function') throw new TypeError('retry.execute must be a function');
    this.fetch = fetch;
    this.logger = logger;
    this.retry = retry;
    this.cache = cache || null;
    this.clock = clock || { nowMs: () => Date.now() };
    this.symbol = config.get('SYMBOL') || 'BTCUSDT';
    this.baseUrl = baseUrl || config.get('BINANCE_BASE_URL') || DEFAULT_BASE_URL;
    this.timeout = config.get('REQUEST_TIMEOUT') || 10000;
    this.connected = false;
    this.lastFetchTime = null;
    this.consecutiveFailures = 0;
  }

  async _getJson(path, params, signal) {
    const url = new URL(path, this.baseUrl);
    url.search = new URLSearchParams(params).toString();
    return this.retry.execute(async () => {
      throwIfAborted(signal);
      const options = { timeout: this.timeout };
      if (signal !== undefined) options.signal = signal;
      const response = await this.fetch(url.toString(), options);
      throwIfAborted(signal);
      if (!response || typeof response.status !== 'number') {
        fail('PROVIDER_CONTRACT', 'Binance response has no HTTP status');
      }
      if (response.status === 429 || response.status === 418) {
        fail('RATE_LIMITED', 'Binance rate limit response', {
          status: 429,
          headers: { 'retry-after': response.headers?.get?.('retry-after') ?? undefined },
        });
      }
      if (response.status < 200 || response.status >= 300) {
        fail('HTTP_ERROR', `Binance HTTP ${response.status}`, { status: response.status });
      }
      return response.json();
    }, signal === undefined ? undefined : { signal });
  }

  async fetchKlines(interval, { limit = 500, startTime, endTime, signal } = {}) {
    if (!Object.hasOwn(INTERVAL_DURATIONS_MS, interval)) {
      throw new TypeError(`Unsupported Binance interval: ${interval}`);
    }
    const params = {
      symbol: this.symbol,
      interval,
      limit: String(Math.min(Math.max(1, limit), MAX_KLINE_LIMIT)),
    };
    if (startTime !== undefined) params.startTime = String(startTime);
    if (endTime !== undefined) params.endTime = String(endTime);
    const body = await this._getJson('/api/v3/klines', params, signal);
    if (!Array.isArray(body)) fail('PROVIDER_CONTRACT', 'Binance klines response must be an array');
    const candles = body.map(row => parseKline(row, interval));
    for (let index = 1; index < candles.length; index++) {
      if (candles[index].openTime <= candles[index - 1].openTime) {
        fail('PROVIDER_CONTRACT', 'Binance klines must be strictly chronological');
      }
    }
    return candles;
  }

  _splitClosed(candles, nowMs) {
    const closed = [];
    let forming = null;
    for (const candle of candles) {
      if (candle.closeTime < nowMs) closed.push(toCandle(candle));
      else forming = toCandle(candle);
    }
    return { closed, forming };
  }

  async fetchMarketData({ signal, sinceOpenTime = null } = {}) {
    throwIfAborted(signal);
    try {
      const klineRequest = Number.isSafeInteger(sinceOpenTime)
        ? { startTime: sinceOpenTime + BAR_DURATION_MS, limit: MAX_KLINE_LIMIT, signal }
        : { limit: 2, signal };
      const [klines, ticker] = await Promise.all([
        this.fetchKlines('1m', klineRequest),
        this._getJson('/api/v3/ticker/24hr', { symbol: this.symbol }, signal),
      ]);
      throwIfAborted(signal);

      const observedAtMs = this.clock.nowMs();
      const { closed, forming } = this._splitClosed(klines, observedAtMs);
      const snapshot = this.buildSnapshot(ticker, observedAtMs, closed, forming);

      this.connected = true;
      this.lastFetchTime = new Date(observedAtMs);
      this.consecutiveFailures = 0;
      if (this.cache) {
        const { bars, forming, ...summary } = snapshot;
        this.cache.store(summary);
      }

      return {
        status: 'FRESH',
        snapshot,
        provenance: {
          source: 'Binance',
          observedAt: snapshot.timestamp,
          sourceTimestamp: forming ? forming.timestamp : null,
          effectiveAgeMs: 0,
          cacheAgeMs: null,
          fallbackReason: null,
        },
      };
    } catch (error) {
      if (isCancellation(error, signal)) throw error;
      this.fail();
      return {
        status: error?.code === 'PROVIDER_CONTRACT' ? 'INVALID_PROVIDER_DATA' : 'PROVIDER_UNAVAILABLE',
        snapshot: null,
        provenance: {
          source: 'Binance',
          observedAt: null,
          sourceTimestamp: null,
          effectiveAgeMs: null,
          cacheAgeMs: null,
          fallbackReason: error?.code || 'PROVIDER_UNAVAILABLE',
        },
      };
    }
  }

  buildSnapshot(ticker, observedAtMs, bars, forming) {
    if (!ticker || typeof ticker !== 'object' || ticker.symbol !== this.symbol) {
      fail('PROVIDER_CONTRACT', 'Binance ticker does not match the configured symbol');
    }
    const price = parseDecimal(ticker.lastPrice, 'lastPrice');
    if (!(price > 0)) fail('PROVIDER_CONTRACT', 'Binance lastPrice must be positive');
    return {
      symbol: this.symbol,
      exchange: 'Binance',
      price,
      open: parseDecimal(ticker.openPrice, 'openPrice'),
      high: parseDecimal(ticker.highPrice, 'highPrice'),
      low: parseDecimal(ticker.lowPrice, 'lowPrice'),
      volume: parseDecimal(ticker.quoteVolume, 'quoteVolume'),
      change24h: parseSignedDecimal(ticker.priceChangePercent, 'priceChangePercent'),
      timestamp: new Date(observedAtMs).toISOString(),
      bars,
      forming,
    };
  }

  /**
   * Seeds every Atlas timeframe from Binance's native interval plus a run of
   * closed 1-minute bars for the MarketAnalyzer history.
   */
  async fetchSeed({ candleLimit = 500, historyBars = 1440, signal } = {}) {
    const nowMs = this.clock.nowMs();
    const timeframes = {};
    for (const [timeframe, interval] of Object.entries(SEED_INTERVALS)) {
      throwIfAborted(signal);
      const candles = await this.fetchKlines(interval, { limit: candleLimit + 1, signal });
      timeframes[timeframe] = this._splitClosed(candles, nowMs);
    }

    const historyCandles = [];
    let endTime;
    while (historyCandles.length < historyBars) {
      throwIfAborted(signal);
      const page = await this.fetchKlines('1m', {
        limit: Math.min(MAX_KLINE_LIMIT, historyBars - historyCandles.length + 1),
        ...(endTime === undefined ? {} : { endTime }),
        signal,
      });
      const closedPage = page.filter(candle => candle.closeTime < nowMs);
      if (closedPage.length === 0) break;
      historyCandles.unshift(...closedPage);
      endTime = closedPage[0].openTime - 1;
      if (page.length < 2) break;
    }

    return {
      timeframes,
      history: historyCandles.slice(-historyBars).map(toCandle),
    };
  }

  isConnected() {
    return this.connected;
  }

  getLastFetchTime() {
    return this.lastFetchTime;
  }

  fail() {
    this.connected = false;
    this.consecutiveFailures++;
    this.logger?.error?.('BinanceMarketData', 'Fetch failed', {
      consecutiveFailures: this.consecutiveFailures,
    });
  }

  getHealth() {
    return {
      connected: this.connected,
      lastFetch: this.lastFetchTime,
      consecutiveFailures: this.consecutiveFailures,
      cacheAvailable: this.cache ? this.cache.has() : false,
      provider: 'Binance',
    };
  }
}

module.exports = {
  BAR_DURATION_MS,
  BinanceMarketData,
  BinanceMarketDataError,
  DEFAULT_BASE_URL,
  SEED_INTERVALS,
};
