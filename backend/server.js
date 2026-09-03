const { ConfigManager } = require('./src/config/config');
const { Logger } = require('./src/logger/logger');
const { CacheEngine } = require('./src/engine/cache');
const { HistoryEngine } = require('./src/engine/history');
const { MarketAnalyzer } = require('./src/engine/analyzer');
const { RetryHandler } = require('./src/network/retry');
const { ApiManager } = require('./src/network/apiManager');
const { CandleEngine, sortHistoricalOhlcRows } = require('./src/engine/candles');
const { EventBus } = require('./src/core/eventBus');
const { createIndicatorRegistry } = require('./src/engine/indicators');
const { StructureEngine } = require('./src/engine/structure');
const { ConfluenceEngine } = require('./src/engine/confluence');
const { ValidationEngine } = require('./src/engine/validation');
const { MTFEngine } = require('./src/engine/mtf');
const { MACDEngine } = require('./src/engine/macd');
const { ATREngine } = require('./src/engine/atr');
const { BollingerEngine } = require('./src/engine/bollinger');
const { SignalHistoryEngine } = require('./src/engine/signalHistory');
const { BacktestEngine } = require('./src/engine/backtest');
const { AnalyticsEngine } = require('./src/engine/analytics');
const { PaperTradingEngine } = require('./src/engine/paperTrading');
const { RegimeEngine } = require('./src/market-regime/RegimeEngine');
const { RegimeDecisionEngine } = require('./src/market-regime/RegimeDecisionEngine');
const { AdvanceRiskEngine } = require('./src/engine/advanceRisk');
const { MTFConfirmationEngine } = require('./src/engine/mtfConfirmation');
const { createValidationDependencies } = require('./src/engine/validationDependencies');
const { createApp } = require('./src/app');
const { createProductionReplayComposition } = require('./src/application/productionReplayComposition');
const { createExecutionPipeline } = require('./src/core/executionPipeline');
const { createSystemClock } = require('./src/core/clock');
const { registerLiveSnapshotHandler } = require('./src/core/liveSnapshot');
const { createLifecycleController } = require('./src/core/lifecycleController');
const {
  throwIfAborted,
  isCancellation,
  createAbortError,
} = require('./src/core/cancellation');

const fetch = require('node-fetch');

const config = new ConfigManager();
const logger = new Logger(config);

const configValidation = config.validate();
for (const w of configValidation.warnings) {
  logger.warn('Config', w);
}
if (!configValidation.valid) {
  for (const e of configValidation.errors) {
    logger.error('Config', e);
  }
  logger.error('Config', 'Startup configuration validation failed — exiting');
  process.exit(1);
}
logger.system('Config', 'Startup configuration validated successfully');

const lifecycle = createLifecycleController({ logger });
lifecycle.installSignalHandlers();

const eventBus = new EventBus();
const symbol = config.get('SYMBOL');
const clock = createSystemClock();
const cache = new CacheEngine(config, logger, symbol);
const history = new HistoryEngine(config, logger, symbol);
const analyzer = new MarketAnalyzer(logger, symbol);
const candleEngine = new CandleEngine(config, logger, symbol);
const retry = new RetryHandler(config, logger);
const apiManager = new ApiManager(config, retry, cache, logger);
const indicatorRegistry = createIndicatorRegistry(symbol);
const structureEngine = new StructureEngine(logger, symbol);
const confluenceEngine = new ConfluenceEngine({ analyzer, indicatorRegistry, structureEngine, candleEngine, logger, config, symbol });
const mtfEngine = new MTFEngine({ confluenceEngine, structureEngine, indicatorRegistry, candleEngine, analyzer, logger, config, symbol });
const macdEngine = new MACDEngine({ candleEngine, logger, symbol });
const atrEngine = new ATREngine({ candleEngine, logger, symbol });
const bollingerEngine = new BollingerEngine({ candleEngine, logger, symbol });
const signalHistoryEngine = new SignalHistoryEngine({ config, logger, symbol, history, analyzer, structureEngine, candleEngine, indicatorRegistry, confluenceEngine, mtfEngine, macdEngine });
const backtestEngine = new BacktestEngine({ structureEngine, indicatorRegistry, logger, symbol });
const analyticsEngine = new AnalyticsEngine({ logger, symbol });
const paperTradeEngine = new PaperTradingEngine({ logger, symbol, clock });
const regimeEngine = new RegimeEngine({ indicatorRegistry, atrEngine, candleEngine, analyzer, logger, config, symbol });
const regimeDecisionEngine = new RegimeDecisionEngine({ logger, symbol });
const advanceRiskEngine = new AdvanceRiskEngine({ logger, symbol, paperTradeEngine, config, clock });

let productionReplayApplication = null;
const providerKey = config.get('COINGECKO_API_KEY');
if (typeof providerKey === 'string' && providerKey.trim() !== '') {
  try {
    const composition = createProductionReplayComposition({
      fetch,
      logger,
      config,
      clock,
      riskPolicySource: advanceRiskEngine,
      sleep: retry.sleep.bind(retry),
    });
    productionReplayApplication = composition.application;
  } catch {
    try {
      logger.error('Server', 'Canonical replay composition construction failed', {
        code: 'CANONICAL_REPLAY_COMPOSITION_FAILED',
      });
    } catch {
      // Startup termination must not depend on logging success.
    }
    process.exit(1);
  }
}

const mtfConfirmationEngine = new MTFConfirmationEngine({ logger, symbol, config });
const validationDependencyFactory = () => createValidationDependencies({ config, symbol });
const validationEngine = new ValidationEngine({
  ...validationDependencyFactory(),
  dependencyFactory: validationDependencyFactory,
});
const executionPipeline = createExecutionPipeline({
  config,
  logger,
  symbol,
  candleEngine,
  regimeEngine,
  confluenceEngine,
  atrEngine,
  analyzer,
  structureEngine,
  indicatorRegistry,
  macdEngine,
  bollingerEngine,
  regimeDecisionEngine,
  mtfConfirmationEngine,
  advanceRiskEngine,
  mtfEngine,
  paperTradeEngine,
  clock,
});

const app = createApp({
  config,
  logger,
  routes: {
    config,
    logger,
    apiManager,
    history,
    analyzer,
    candleEngine,
    eventBus,
    cache,
    indicatorRegistry,
    structureEngine,
    confluenceEngine,
    validationEngine,
    mtfEngine,
    macdEngine,
    atrEngine,
    bollingerEngine,
    signalHistoryEngine,
    backtestEngine,
    analyticsEngine,
    paperTradeEngine,
    regimeEngine,
    regimeDecisionEngine,
    advanceRiskEngine,
    mtfConfirmationEngine,
    productionReplayApplication,
    symbol,
  },
  getLastDecision: executionPipeline.getLastDecision,
  getPipelineHealth: executionPipeline.getPipelineHealth,
  lifecycle,
});

registerLiveSnapshotHandler({
  eventBus,
  history,
  analyzer,
  signalHistoryEngine,
  executionPipeline,
});

function ensureBootstrapActive(signal) {
  throwIfAborted(signal);
  if (lifecycle.isShuttingDown()) throw createAbortError('Bootstrap stopped by lifecycle shutdown');
}

async function seedHistoricalCandles({ signal } = {}) {
  const baseUrl = 'https://api.coingecko.com/api/v3';
  const coinId = 'bitcoin';
  const vsCurrency = 'usd';
  let seeded = 0;

  try {
    ensureBootstrapActive(signal);
    logger.system('Server', 'Seeding historical candles from CoinGecko...');

    const ohlcUrl = `${baseUrl}/coins/${coinId}/ohlc?vs_currency=${vsCurrency}&days=30`;
    const ohlcRes = signal === undefined
      ? await fetch(ohlcUrl)
      : await fetch(ohlcUrl, { signal });
    ensureBootstrapActive(signal);
    if (ohlcRes.ok) {
      const ohlcData = await ohlcRes.json();
      ensureBootstrapActive(signal);
      if (!Array.isArray(ohlcData)) {
        throw new TypeError('Historical OHLC response must be an array');
      }
      const sortedOhlcData = sortHistoricalOhlcRows(ohlcData);
      for (const [ts, open, high, low, close] of sortedOhlcData) {
        ensureBootstrapActive(signal);
        candleEngine.ingestHistoricalCandle('4h', {
          open: open,
          high: high,
          low: low,
          close,
          volume: 0,
          timestamp: new Date(ts).toISOString(),
        });
        seeded++;
      }
      logger.system('Server', `Seeded ${ohlcData.length} OHLC candles (4h, 30-day)`);
    } else {
      logger.warn('Server', `OHLC endpoint returned ${ohlcRes.status}`);
    }

    await retry.sleep(1500, signal);
    ensureBootstrapActive(signal);

    const marketChartUrl = `${baseUrl}/coins/${coinId}/market_chart?vs_currency=${vsCurrency}&days=2`;
    const mcRes = signal === undefined
      ? await fetch(marketChartUrl)
      : await fetch(marketChartUrl, { signal });
    ensureBootstrapActive(signal);
    if (mcRes.ok) {
      const mcData = await mcRes.json();
      ensureBootstrapActive(signal);
      const prices = mcData.prices || [];
      const volumes = mcData.total_volumes || [];
      for (let i = 0; i < prices.length; i++) {
        ensureBootstrapActive(signal);
        const [ts, price] = prices[i];
        const vol = volumes[i] ? volumes[i][1] : 0;
        candleEngine.ingest({
          symbol,
          price,
          volume: vol,
          timestamp: new Date(ts).toISOString(),
        });
        seeded++;
      }
      logger.system('Server', `Seeded ${prices.length} hourly candles (2-day market chart)`);
    } else {
      logger.warn('Server', `Market chart endpoint returned ${mcRes.status}`);
    }

    const totalPerTf = {};
    for (const tf of candleEngine.getAllTimeframes()) {
      const candles = candleEngine.getCandles(tf);
      totalPerTf[tf] = candles.length;
    }
    logger.system('Server', `Historical seed complete: ${seeded} snapshots → candles per timeframe`, totalPerTf);
  } catch (err) {
    if (isCancellation(err, signal) || lifecycle.isShuttingDown()) throw err;
    logger.warn('Server', `Historical seed failed: ${err.message} — proceeding without history`);
  }
}

async function fetchCycle({ signal } = {}) {
  if (signal?.aborted || lifecycle.isShuttingDown()) return;
  try {
    const result = await apiManager.fetchMarketData({ signal });
    if (signal?.aborted || lifecycle.isShuttingDown()) return;
    if (!result || result.status !== 'FRESH' || !result.snapshot) {
      logger.warn('Server', 'Live cycle skipped — market data is not fresh', {
        status: result?.status || 'INVALID_ACQUISITION_RESULT',
        cacheAgeMs: result?.provenance?.cacheAgeMs ?? null,
        fallbackReason: result?.provenance?.fallbackReason ?? null,
      });
      return;
    }

    const snapshot = result.snapshot;
    history.add(snapshot);
    const transition = candleEngine.ingest(snapshot);
    eventBus.emit('market:snapshot', snapshot, transition);
  } catch (err) {
    if (isCancellation(err, signal) || lifecycle.isShuttingDown()) return;
    apiManager.fail();
    logger.error('Server', 'Market-data acquisition failed before live-cycle admission', {
      error: err.message,
    });
  }
}

const port = config.get('PORT');
const interval = config.get('REFRESH_INTERVAL');

const server = app.listen(port, async () => {
  let bootstrapSignal;
  const bootstrap = lifecycle.startBootstrap(({ signal }) => {
    bootstrapSignal = signal;
    return seedHistoricalCandles({ signal });
  });
  lifecycle.markRunning();

  logger.system('Server', `Atlas v1.0 running on port ${port}`);
  logger.system('Server', `Config loaded`, {
    refreshInterval: interval,
    maxHistory: config.get('MAX_HISTORY'),
    cacheTTL: config.get('CACHE_TTL'),
    logLevel: config.get('LOG_LEVEL'),
  });

  try {
    if (bootstrap) await bootstrap;
    if (bootstrapSignal?.aborted || lifecycle.isShuttingDown() || lifecycle.getState() !== 'RUNNING') return;

    const initialCycle = lifecycle.startLiveCycle(({ signal }) => fetchCycle({ signal }));
    if (initialCycle) initialCycle.catch(error => logger.error('Server', 'Initial live cycle failed', { error: error.message }));
    lifecycle.startLiveScheduler(interval, ({ signal }) => fetchCycle({ signal }));
  } catch (error) {
    if (isCancellation(error, bootstrapSignal) || lifecycle.isShuttingDown()) return;
    lifecycle.fatal(`startup: ${error.message}`);
  }
});

lifecycle.attachServer(server);
server.on('error', error => lifecycle.fatal(`http-server: ${error.message}`));
