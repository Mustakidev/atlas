const { createProductionReplayApplication } = require('./productionReplayApplication');
const { ProductionReplayMtfSource } = require('../engine/productionReplayMtfSource');
const { ProductionReplayAnalyzerSource } = require('../engine/productionReplayAnalyzerSource');
const { BinanceKlineClient } = require('../network/binanceKlineClient');
const { CoinGeckoHistoricalAnalyzerClient } = require('../network/coingeckoHistoricalAnalyzerClient');

const PRODUCTION_SYMBOL = 'BTCUSDT';
const COINGECKO_COIN_ID = 'bitcoin';
const COINGECKO_VS_CURRENCY = 'usd';

class ProductionReplayCompositionError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionReplayCompositionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionReplayCompositionError(code, message);
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_DEPENDENCY', `${name} must be a non-array object`);
  }
}

function assertFunction(value, name) {
  if (typeof value !== 'function') fail('INVALID_DEPENDENCY', `${name} must be a function`);
}

function assertLogger(logger) {
  assertObject(logger, 'logger');
  for (const method of ['info', 'warn', 'error']) {
    assertFunction(logger[method], `logger.${method}`);
  }
}

function assertConfig(config) {
  assertObject(config, 'config');
  assertFunction(config.get, 'config.get');
}

function assertClock(clock) {
  assertObject(clock, 'clock');
  assertFunction(clock.nowMs, 'clock.nowMs');
  assertFunction(clock.monotonicMs, 'clock.monotonicMs');
}

function assertRiskPolicySource(riskPolicySource) {
  if (riskPolicySource === undefined || riskPolicySource === null) return;
  assertObject(riskPolicySource, 'riskPolicySource');
  assertFunction(riskPolicySource.getPolicy, 'riskPolicySource.getPolicy');
}

function readCoinGeckoApiKey(config) {
  const value = config.get('COINGECKO_API_KEY');
  if (typeof value !== 'string' || value.trim() === '') {
    fail('MISSING_PROVIDER_CREDENTIAL', 'COINGECKO_API_KEY must be a non-empty string');
  }
  return value.trim();
}

function createProductionReplayComposition({
  fetch,
  logger,
  config,
  clock,
  riskPolicySource,
  sleep,
} = {}) {
  assertFunction(fetch, 'fetch');
  assertLogger(logger);
  assertConfig(config);
  assertClock(clock);
  assertFunction(sleep, 'sleep');
  assertRiskPolicySource(riskPolicySource);

  const apiKey = readCoinGeckoApiKey(config);

  const binanceClient = new BinanceKlineClient({
    fetch,
    logger,
    sleep,
    config: {
      timeoutMs: config.get('REQUEST_TIMEOUT'),
      initialBackoffMs: config.get('INITIAL_BACKOFF'),
    },
  });
  const mtfSource = new ProductionReplayMtfSource({ client: binanceClient });

  const coinGeckoClient = new CoinGeckoHistoricalAnalyzerClient({
    fetch,
    logger,
    config: { apiKey },
  });
  const analyzerSource = new ProductionReplayAnalyzerSource({
    client: coinGeckoClient,
    symbol: PRODUCTION_SYMBOL,
    coinId: COINGECKO_COIN_ID,
    vsCurrency: COINGECKO_VS_CURRENCY,
  });

  const application = createProductionReplayApplication({
    mtfSource,
    analyzerSource,
    logger,
    config,
    clock,
    riskPolicySource,
  });

  return Object.freeze({ application });
}

module.exports = { createProductionReplayComposition };
