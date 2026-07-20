const express = require('express');
const { sanitizeQuery } = require('../middleware/validate');

function createRouter(deps) {
  const { apiManager, history, analyzer, candleEngine, logger, config, eventBus, cache, indicatorRegistry, structureEngine, confluenceEngine, validationEngine, mtfEngine, macdEngine, atrEngine, bollingerEngine, signalHistoryEngine, backtestEngine, analyticsEngine, paperTradeEngine, riskEngine, strategyReplayEngine, regimeEngine, regimeDecisionEngine, advanceRiskEngine, mtfConfirmationEngine, symbol, getLastDecision } = deps;
  const router = express.Router();

  router.use(sanitizeQuery);

  router.get('/market', (req, res) => {
    const snapshot = history.latest();
    if (!snapshot) {
      return res.json({
        connected: false,
        message: 'Waiting for first data fetch...',
      });
    }
    res.json({ connected: apiManager.isConnected(), ...snapshot });
  });

  router.get('/analysis', (req, res) => {
    const analysis = analyzer.getAnalysis();
    if (!analysis) {
      return res.json({
        connected: false,
        message: 'Analysis pending...',
      });
    }
    res.json({ connected: apiManager.isConnected(), ...analysis });
  });

  router.get('/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const snapshots = history.last(limit);
    res.json({ count: snapshots.length, history: snapshots });
  });

  router.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const level = req.query.level || null;
    const logs = logger.getLogs(limit, level);
    res.json({ count: logs.length, logs });
  });

  router.get('/status', (req, res) => {
    const health = apiManager.getHealth();
    const pipelineHealth = deps.getPipelineHealth ? deps.getPipelineHealth() : null;
    res.json({
      version: '1.0.0',
      uptime: process.uptime(),
      historySize: history.size(),
      cacheAge: deps.cache.getAge(),
      ...health,
      ...(pipelineHealth ? { pipeline: pipelineHealth } : {}),
    });
  });

  router.get('/config', (req, res) => {
    const cfg = config.getAll();
    res.json({
      port: cfg.PORT,
      refreshInterval: cfg.REFRESH_INTERVAL,
      cacheTTL: cfg.CACHE_TTL,
      maxHistory: cfg.MAX_HISTORY,
      logLevel: cfg.LOG_LEVEL,
      requestTimeout: cfg.REQUEST_TIMEOUT,
      maxRetries: cfg.MAX_RETRIES,
      initialBackoff: cfg.INITIAL_BACKOFF,
    });
  });

  router.get('/candles', (req, res) => {
    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 100;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const candles = candleEngine.getCandles(tf, limit);
    const active = candleEngine.getActive(tf);

    res.json({
      timeframe: tf,
      count: candles.length,
      active: active || null,
      candles,
    });
  });

  // ---------------------------------------------------------------------------
  // RSI — dedicated endpoint
  // ---------------------------------------------------------------------------
  router.get('/indicators/rsi', (req, res) => {
    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    // Get finalized candles only (exclude the active/in-progress candle)
    const allCandles = candleEngine.getCandles(tf, limit);
    const active = candleEngine.getActive(tf);
    let finalized = allCandles;
    if (active && allCandles.length > 0 &&
        allCandles[allCandles.length - 1].openTime === active.openTime) {
      finalized = allCandles.slice(0, -1);
    }

    // Calculate RSI
    const start = Date.now();
    const rsiResult = indicatorRegistry.get('RSI').calculate(finalized, tf);
    const duration = Date.now() - start;

    // Attach confidence (needs candle count)
    const confidence = rsiResult.ready
      ? Math.min(100, Math.round(50 + Math.max(0, finalized.length - 15) * 0.3))
      : null;
    rsiResult.confidence = confidence;

    // Log
    logger.info('RSI', `RSI Updated | ${tf} | ${rsiResult.ready ? rsiResult.value : 'N/A'} | ${duration}ms`);

    res.json({
      timeframe: tf,
      candleCount: finalized.length,
      rsi: rsiResult,
    });
  });

  // ---------------------------------------------------------------------------
  // EMA — dedicated endpoint (multi-period)
  // ---------------------------------------------------------------------------
  router.get('/indicators/ema', (req, res) => {
    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const periodParam = req.query.period ? parseInt(req.query.period) : null;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    // Get finalized candles only (exclude the active/in-progress candle)
    const allCandles = candleEngine.getCandles(tf, limit);
    const active = candleEngine.getActive(tf);
    let finalized = allCandles;
    if (active && allCandles.length > 0 &&
        allCandles[allCandles.length - 1].openTime === active.openTime) {
      finalized = allCandles.slice(0, -1);
    }

    const emaIndicator = indicatorRegistry.get('EMA');

    if (periodParam) {
      // Single period
      const validPeriods = emaIndicator.getPeriods();
      if (!validPeriods.includes(periodParam)) {
        return res.status(400).json({
          error: `Invalid period ${periodParam}`,
          supported: validPeriods,
        });
      }

      const start = Date.now();
      const result = emaIndicator.calculate(finalized, tf, periodParam);
      const duration = Date.now() - start;

      logger.info('EMA', `EMA | ${tf} | period=${periodParam} | value=${result.value} | trend=${result.trend} | ${duration}ms`);

      res.json(result);
    } else {
      // All periods
      const start = Date.now();
      const results = emaIndicator.calculateAll(finalized, tf);
      const duration = Date.now() - start;

      logger.info('EMA', `EMA All | ${tf} | ${Object.keys(results).length} periods | ${duration}ms`);

      // Build clean periods object
      const periodsResponse = {};
      for (const [period, result] of Object.entries(results)) {
        periodsResponse[period] = {
          value: result.value,
          trend: result.trend,
          ready: result.ready,
        };
      }

      res.json({
        symbol: results[Object.keys(results)[0]]?.symbol || 'BTCUSDT',
        timeframe: tf,
        periods: periodsResponse,
        candleCount: finalized.length,
        calculationTime: duration,
        lastUpdated: new Date().toISOString(),
        engineVersion: results[Object.keys(results)[0]]?.engineVersion || '1.0.0',
      });
    }
  });

  router.get('/indicators', (req, res) => {
    if (!indicatorRegistry) {
      return res.status(503).json({ error: 'Indicator engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const candles = candleEngine.getCandles(tf, limit);
    const specificIndicator = req.query.indicator || null;

    if (specificIndicator) {
      if (!indicatorRegistry.has(specificIndicator)) {
        return res.status(404).json({
          error: `Indicator '${specificIndicator}' not found`,
          available: indicatorRegistry.getNames(),
        });
      }
      const indicator = indicatorRegistry.get(specificIndicator);
      res.json({
        timeframe: tf,
        candleCount: candles.length,
        indicator: {
          ...indicator.getInfo(),
          result: indicator.calculate(candles),
        },
      });
    } else {
      res.json({
        timeframe: tf,
        candleCount: candles.length,
        indicators: indicatorRegistry.calculateAll(candles),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Confluence — unified market quality scoring
  // ---------------------------------------------------------------------------
  router.get('/confluence', (req, res) => {
    if (!confluenceEngine) {
      return res.status(503).json({ error: 'Confluence engine not available' });
    }

    const tf = req.query.timeframe ? req.query.timeframe.toLowerCase() : null;
    const limit = parseInt(req.query.limit) || 500;

    if (tf) {
      const valid = candleEngine.getAllTimeframes();
      if (!valid.includes(tf)) {
        return res.status(400).json({
          error: 'Invalid timeframe',
          supported: valid,
        });
      }

      const allCandles = candleEngine.getCandles(tf, limit);
      const active = candleEngine.getActive(tf);
      let finalized = allCandles;
      if (active && allCandles.length > 0 &&
          allCandles[allCandles.length - 1].openTime === active.openTime) {
        finalized = allCandles.slice(0, -1);
      }

      const start = Date.now();
      const result = confluenceEngine.calculate(finalized, tf);
      const duration = Date.now() - start;

      logger.info('Confluence', `Confluence | ${tf} | score=${result.score} | bias=${result.bias} | confidence=${result.confidence} | ${duration}ms`);

      res.json(result);
    } else {
      const start = Date.now();
      const results = confluenceEngine.calculateAll(limit);
      const duration = Date.now() - start;

      logger.info('Confluence', `Confluence All | ${Object.keys(results).length} timeframes | ${duration}ms`);

      res.json(results);
    }
  });

  // ---------------------------------------------------------------------------
  // Market Regime — market classification before trading signal evaluation
  // ---------------------------------------------------------------------------
  router.get('/market-regime', (req, res) => {
    if (!regimeEngine) {
      return res.status(503).json({ error: 'Market Regime engine not available' });
    }

    const tf = req.query.timeframe ? req.query.timeframe.toLowerCase() : null;
    const limit = parseInt(req.query.limit) || 500;

    if (tf) {
      const valid = candleEngine.getAllTimeframes();
      if (!valid.includes(tf)) {
        return res.status(400).json({
          error: 'Invalid timeframe',
          supported: valid,
        });
      }

      const allCandles = candleEngine.getCandles(tf, limit);
      const active = candleEngine.getActive(tf);
      let finalized = allCandles;
      if (active && allCandles.length > 0 &&
          allCandles[allCandles.length - 1].openTime === active.openTime) {
        finalized = allCandles.slice(0, -1);
      }

      const start = Date.now();
      const result = regimeEngine.calculate(finalized, tf);
      const duration = Date.now() - start;

      logger.info('MarketRegime', `Market Regime | ${tf} | regime=${result.regime} | conf=${result.confidence} | ${duration}ms`);

      res.json(result);
    } else {
      const start = Date.now();
      const results = regimeEngine.calculateAll(limit);
      const duration = Date.now() - start;

      logger.info('MarketRegime', `Market Regime All | ${Object.keys(results).length} timeframes | ${duration}ms`);

      res.json(results);
    }
  });

  // ---------------------------------------------------------------------------
  // MACD — Moving Average Convergence Divergence
  // ---------------------------------------------------------------------------
  router.get('/macd', (req, res) => {
    if (!macdEngine) {
      return res.status(503).json({ error: 'MACD engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const start = Date.now();
    const result = macdEngine.calculate(tf, limit);
    const duration = Date.now() - start;

    logger.info('MACD', `MACD | ${tf} | macd=${result.macd} | signal=${result.signal} | trend=${result.trend} | crossover=${result.crossover} | ${duration}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // ATR — Average True Range (Wilder's)
  // ---------------------------------------------------------------------------
  router.get('/atr', (req, res) => {
    if (!atrEngine) {
      return res.status(503).json({ error: 'ATR engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const start = Date.now();
    const result = atrEngine.calculate(tf, limit);
    const duration = Date.now() - start;

    logger.info('ATR', `ATR | ${tf} | atr=${result.atr} | volatility=${result.volatilityLevel} | trend=${result.volatilityTrend} | ${duration}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Bollinger Bands — volatility envelope
  // ---------------------------------------------------------------------------
  router.get('/bollinger', (req, res) => {
    if (!bollingerEngine) {
      return res.status(503).json({ error: 'Bollinger engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const start = Date.now();
    const result = bollingerEngine.calculate(tf, limit);
    const duration = Date.now() - start;

    logger.info('Bollinger', `Bollinger | ${tf} | middle=${result.middleBand} | upper=${result.upperBand} | lower=${result.lowerBand} | squeeze=${result.squeeze} | ${duration}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Structure — market structure detection (swing points, HH/HL/LH/LL, BOS)
  // ---------------------------------------------------------------------------
  router.get('/structure', (req, res) => {
    if (!structureEngine) {
      return res.status(503).json({ error: 'Structure engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const allCandles = candleEngine.getCandles(tf, limit);
    const active = candleEngine.getActive(tf);
    let finalized = allCandles;
    if (active && allCandles.length > 0 &&
        allCandles[allCandles.length - 1].openTime === active.openTime) {
      finalized = allCandles.slice(0, -1);
    }

    logger.info('Structure', `Structure analysis started | ${tf} | candles=${finalized.length}`);

    const start = Date.now();
    const result = structureEngine.calculate(finalized);
    const duration = Date.now() - start;

    logger.info('Structure', `Structure | ${tf} | pattern=${result.structure} | dir=${result.direction} | score=${result.score} | confidence=${result.confidence} | ${duration}ms`);

    res.json({ timeframe: tf, candleCount: finalized.length, ...result });
  });

  // ---------------------------------------------------------------------------
  // Signal History — completed market analysis records for backtesting
  // ---------------------------------------------------------------------------
  router.get('/signals', (req, res) => {
    if (!signalHistoryEngine) {
      return res.status(503).json({ error: 'Signal history engine not available' });
    }

    const limit = parseInt(req.query.limit) || 100;
    const symbolFilter = req.query.symbol || null;
    const tfFilter = req.query.timeframe || null;

    let records;
    if (symbolFilter && tfFilter) {
      records = signalHistoryEngine.all()
        .filter(r => r.symbol === symbolFilter && r.timeframe === tfFilter)
        .slice(-limit);
    } else if (symbolFilter) {
      records = signalHistoryEngine.last(limit, symbolFilter);
    } else if (tfFilter) {
      records = signalHistoryEngine.getByTimeframe(tfFilter).slice(-limit);
    } else {
      records = signalHistoryEngine.last(limit);
    }

    logger.info('SignalHistory', `GET /signals | symbol=${symbolFilter || '*'} | tf=${tfFilter || '*'} | count=${records.length}`);
    res.json({ count: records.length, records });
  });

  router.get('/signals/latest', (req, res) => {
    if (!signalHistoryEngine) {
      return res.status(503).json({ error: 'Signal history engine not available' });
    }

    const symbolFilter = req.query.symbol || null;
    const record = signalHistoryEngine.latest(symbolFilter);

    if (!record) {
      return res.json({ message: 'No signal records yet', record: null });
    }

    res.json(record);
  });

  router.get('/signals/stats', (req, res) => {
    if (!signalHistoryEngine) {
      return res.status(503).json({ error: 'Signal history engine not available' });
    }

    const symbolFilter = req.query.symbol || null;
    const stats = signalHistoryEngine.stats(symbolFilter);

    logger.info('SignalHistory', `GET /signals/stats | symbol=${symbolFilter || '*'} | total=${stats.totalRecords}`);
    res.json(stats);
  });

  // ---------------------------------------------------------------------------
  // Validation — mathematical proof of engine correctness
  // ---------------------------------------------------------------------------
  router.get('/validation', (req, res) => {
    if (!validationEngine) {
      return res.status(503).json({ error: 'Validation engine not available' });
    }

    const forceRerun = req.query.rerun === 'true';
    const result = validationEngine.runAll(forceRerun);

    logger.info('Validation', `Validation | overall=${result.overall} | ${result.calculationTime}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Multi-Timeframe Analysis — unified market assessment
  // ---------------------------------------------------------------------------
  router.get('/mtf', (req, res) => {
    if (!mtfEngine) {
      return res.status(503).json({ error: 'MTF engine not available' });
    }

    const limit = parseInt(req.query.limit) || 500;

    const start = Date.now();
    const result = mtfEngine.calculate(limit);
    const duration = Date.now() - start;

    logger.info('MTF', `MTF | bias=${result.overallBias} | confidence=${result.confidence} | agreement=${result.timeframeAgreement} | ${duration}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Backtest — historical signal replay
  // ---------------------------------------------------------------------------
  router.get('/backtest', (req, res) => {
    if (!backtestEngine) {
      return res.status(503).json({ error: 'Backtest engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const predictionCandles = parseInt(req.query.predictionCandles) || 5;
    const warmupCandles = parseInt(req.query.warmupCandles) || 50;
    const minSignalConfidence = parseInt(req.query.minSignalConfidence) || 0;

    const valid = candleEngine.getAllTimeframes();
    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const allCandles = candleEngine.getCandles(tf, limit);
    const active = candleEngine.getActive(tf);
    let finalized = allCandles;
    if (active && allCandles.length > 0 &&
        allCandles[allCandles.length - 1].openTime === active.openTime) {
      finalized = allCandles.slice(0, -1);
    }

    if (finalized.length === 0) {
      return res.json({
        symbol: config.get('SYMBOL') || 'BTCUSDT',
        timeframe: tf,
        reason: 'No finalized candle data available',
        signals: [],
        stats: { totalSignals: 0, bullishSignals: 0, bearishSignals: 0, winRate: 0, lossRate: 0, averageConfidence: 0, bestTimeframe: null, worstTimeframe: null },
      });
    }

    const start = Date.now();
    const result = backtestEngine.run({
      candles: finalized,
      timeframe: tf,
      predictionCandles,
      warmupCandles,
      minSignalConfidence,
    });
    const duration = Date.now() - start;

    logger.info('Backtest', `Backtest | ${tf} | signals=${result.signals.length} | win=${result.stats.winRate}% | ${duration}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Analytics — performance analytics from backtest and signal history
  // ---------------------------------------------------------------------------
  router.get('/analytics', (req, res) => {
    if (!analyticsEngine) {
      return res.status(503).json({ error: 'Analytics engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const limit = parseInt(req.query.limit) || 500;
    const predictionCandles = parseInt(req.query.predictionCandles) || 5;
    const warmupCandles = parseInt(req.query.warmupCandles) || 50;

    // Gather backtest data if candles are available
    let backtestResult = null;
    const valid = candleEngine.getAllTimeframes();
    if (valid.includes(tf)) {
      const allCandles = candleEngine.getCandles(tf, limit);
      const active = candleEngine.getActive(tf);
      let finalized = allCandles;
      if (active && allCandles.length > 0 &&
          allCandles[allCandles.length - 1].openTime === active.openTime) {
        finalized = allCandles.slice(0, -1);
      }
      if (finalized.length > 0 && backtestEngine) {
        backtestResult = backtestEngine.run({
          candles: finalized,
          timeframe: tf,
          predictionCandles,
          warmupCandles,
        });
      }
    }

    // Gather signal history data
    let signalHistory = [];
    if (signalHistoryEngine) {
      signalHistory = signalHistoryEngine.last(limit);
    }

    const start = Date.now();
    const result = analyticsEngine.analyze({ backtestResult, signalHistory });
    const duration = Date.now() - start;

    logger.info('Analytics', `Analytics | ${tf} | signals=${result.general.totalSignals} | accuracy=${result.accuracy.overall}% | ${duration}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Paper Trading — virtual trade management
  // ---------------------------------------------------------------------------

  router.get('/paper-trades', (req, res) => {
    if (!paperTradeEngine) {
      return res.status(503).json({ error: 'Paper trading engine not available' });
    }
    const open = paperTradeEngine.open();
    const closed = paperTradeEngine.history(50);
    const stats = paperTradeEngine.stats();
    const performance = paperTradeEngine.performance();
    const balance = paperTradeEngine.getBalance();
    logger.info('PaperTrades', `GET /paper-trades | open=${open.length} | closed=${closed.length} | balance=${balance}`);
    res.json({ open, closed, stats, performance, balance });
  });

  router.get('/paper-trades/open', (req, res) => {
    if (!paperTradeEngine) {
      return res.status(503).json({ error: 'Paper trading engine not available' });
    }
    res.json(paperTradeEngine.open());
  });

  router.get('/paper-trades/history', (req, res) => {
    if (!paperTradeEngine) {
      return res.status(503).json({ error: 'Paper trading engine not available' });
    }
    const limit = parseInt(req.query.limit) || 100;
    res.json(paperTradeEngine.history(limit));
  });

  router.get('/paper-trades/stats', (req, res) => {
    if (!paperTradeEngine) {
      return res.status(503).json({ error: 'Paper trading engine not available' });
    }
    res.json(paperTradeEngine.stats());
  });

  router.get('/paper-trades/performance', (req, res) => {
    if (!paperTradeEngine) {
      return res.status(503).json({ error: 'Paper trading engine not available' });
    }
    res.json(paperTradeEngine.performance());
  });

  router.post('/paper-trades/close', (req, res) => {
    if (!paperTradeEngine) {
      return res.status(503).json({ error: 'Paper trading engine not available' });
    }
    const { tradeId, reason } = req.body || {};
    if (!tradeId) {
      return res.status(400).json({ error: 'tradeId is required' });
    }
    const closed = paperTradeEngine.close(tradeId, reason || 'Manual');
    if (!closed) {
      return res.status(404).json({ error: 'Trade not found or already closed' });
    }
    logger.info('PaperTrades', `POST /paper-trades/close | ${tradeId} | reason=${reason || 'Manual'} | pnl=${closed.pnl}`);
    res.json(closed);
  });

  // ---------------------------------------------------------------------------
  // Risk Management — ATR-based stop loss/take profit evaluation
  // ---------------------------------------------------------------------------

  router.get('/risk', (req, res) => {
    if (!riskEngine) {
      return res.status(503).json({ error: 'Risk engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const entryPrice = parseFloat(req.query.entryPrice);
    const direction = (req.query.direction || 'BUY').toUpperCase();

    if (!entryPrice || entryPrice <= 0) {
      return res.status(400).json({ error: 'Valid entryPrice query parameter required' });
    }
    if (!['BUY', 'SELL'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be BUY or SELL' });
    }

    // Gather ATR data
    let atr = null;
    const valid = candleEngine.getAllTimeframes();
    if (valid.includes(tf) && atrEngine) {
      atr = atrEngine.calculate(tf);
    }

    // Gather trend data
    let trend = null;
    if (analyzer) {
      trend = analyzer.getAnalysis();
    }

    // Gather structure data
    let structure = null;
    if (structureEngine && candleEngine) {
      const candles = candleEngine.getCandles(tf, 100);
      if (candles.length > 0) {
        structure = structureEngine.calculate(candles);
      }
    }

    // Gather confluence data
    let confluence = null;
    if (confluenceEngine && candleEngine) {
      const candles = candleEngine.getCandles(tf, 100);
      if (candles.length > 0) {
        confluence = confluenceEngine.calculate(candles, tf);
      }
    }

    const result = riskEngine.evaluate({
      symbol: symbol,
      timeframe: tf,
      entryPrice,
      atr: atr || { ready: false, atr: null, atrPercentage: 0 },
      direction,
      trend,
      structure,
      confluence,
    });

    logger.info('Risk', `Risk | ${tf} | ${direction} @ ${entryPrice} | allowed=${result.tradeAllowed} | ${result.calculationTime}ms`);

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Advance Risk — dynamic position sizing, ATR SL/TP, daily limits, session risk
  // ---------------------------------------------------------------------------

  router.get('/advance-risk', (req, res) => {
    if (!advanceRiskEngine) {
      return res.status(503).json({ error: 'Advance Risk engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const entryPrice = parseFloat(req.query.entryPrice);
    const direction = (req.query.direction || 'BUY').toUpperCase();

    if (!entryPrice || entryPrice <= 0) {
      return res.status(400).json({ error: 'Valid entryPrice query parameter required' });
    }
    if (!['BUY', 'SELL'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be BUY or SELL' });
    }

    let atr = null, trend = null, structure = null, confluence = null, regime = null;
    const valid = candleEngine.getAllTimeframes();
    if (valid.includes(tf) && atrEngine) atr = atrEngine.calculate(tf);
    if (analyzer) trend = analyzer.getAnalysis();
    if (structureEngine && candleEngine) {
      const c = candleEngine.getCandles(tf, 100);
      if (c.length > 0) structure = structureEngine.calculate(c);
    }
    if (confluenceEngine && candleEngine) {
      const c = candleEngine.getCandles(tf, 100);
      if (c.length > 0) confluence = confluenceEngine.calculate(c, tf);
    }
    if (regimeEngine && candleEngine) {
      const c = candleEngine.getCandles(tf, 500);
      if (c.length > 0) {
        const r = regimeEngine.calculate(c, tf);
        regime = r.regime;
      }
    }

    const result = advanceRiskEngine.evaluate({
      symbol, timeframe: tf, entryPrice,
      atr: atr || { ready: false, atr: null, atrPercentage: 0 },
      direction, trend, structure, confluence, regime,
    });

    logger.info('AdvanceRisk', `GET /advance-risk | ${tf} | ${direction} @ ${entryPrice} | allowed=${result.tradeAllowed} | pos=${result.positionSize} | ${result.calculationTime}ms`);
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Advance Risk State — current risk engine state (daily limits, losses, session)
  // ---------------------------------------------------------------------------

  router.get('/advance-risk/state', (req, res) => {
    if (!advanceRiskEngine) {
      return res.status(503).json({ error: 'Advance Risk engine not available' });
    }
    res.json({ available: true, ...advanceRiskEngine.getState() });
  });

  // ---------------------------------------------------------------------------
  // MTF Confirmation — evaluate multi-timeframe alignment for a direction
  // ---------------------------------------------------------------------------

  router.get('/mtf-confirmation', (req, res) => {
    if (!mtfConfirmationEngine) {
      return res.status(503).json({ error: 'MTF Confirmation engine not available' });
    }

    const direction = (req.query.direction || 'BUY').toUpperCase();
    const tf = (req.query.timeframe || '1h').toLowerCase();
    const aggressive = req.query.aggressive === 'true';

    if (!['BUY', 'SELL'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be BUY or SELL' });
    }

    const mtfTimeframes = {};
    const mtfTFs = ['1m', '5m', '15m', '1h'];
    for (const mtfTF of mtfTFs) {
      const candles = candleEngine.getCandles(mtfTF, 100);
      const active = candleEngine.getActive(mtfTF);
      let finalized = candles;
      if (active && candles.length > 0 &&
          candles[candles.length - 1].openTime === active.openTime) {
        finalized = candles.slice(0, -1);
      }
      if (finalized.length >= 15 && confluenceEngine) {
        const c = confluenceEngine.calculate(finalized, mtfTF);
        const a = atrEngine.calculate(mtfTF);
        mtfTimeframes[mtfTF] = {
          confluence: { score: c.score, bias: c.bias, confidence: c.confidence },
          volatilityLevel: a?.volatilityLevel || null,
        };
      }
    }

    const result = mtfConfirmationEngine.evaluate({ direction, timeframe: tf, timeframes: mtfTimeframes, aggressive });
    logger.info('MTFConfirmation', `GET /mtf-confirmation | ${direction} | allowed=${result.mtfAllowed} | conf=${result.confidence}% | align=${result.alignmentScore}%`);
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Signal Inspector — real-time decision breakdown for debugging
  // ---------------------------------------------------------------------------

  router.get('/signal/inspector', (req, res) => {
    const decision = getLastDecision ? getLastDecision() : null;
    if (!decision) {
      return res.json({ available: false, message: 'No decision data yet — waiting for first pipeline cycle' });
    }
    res.json({ available: true, ...decision });
  });

  // ---------------------------------------------------------------------------
  // Market Regine Inspector (dedicated)
  // ---------------------------------------------------------------------------

  router.get('/market-regime/inspector', (req, res) => {
    if (!regimeEngine) {
      return res.status(503).json({ error: 'Market Regime engine not available' });
    }

    const tf = req.query.timeframe ? req.query.timeframe.toLowerCase() : '1h';
    const limit = parseInt(req.query.limit) || 500;
    const valid = candleEngine.getAllTimeframes();

    if (!valid.includes(tf)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        supported: valid,
      });
    }

    const allCandles = candleEngine.getCandles(tf, limit);
    const active = candleEngine.getActive(tf);
    let finalized = allCandles;
    if (active && allCandles.length > 0 &&
        allCandles[allCandles.length - 1].openTime === active.openTime) {
      finalized = allCandles.slice(0, -1);
    }

    const result = regimeEngine.calculate(finalized, tf);

    res.json({
      available: true,
      regime: result.regime,
      confidence: result.confidence,
      trendScore: result.trendScore,
      rangeScore: result.rangeScore,
      volatility: result.volatility,
      volatilityScore: result.volatilityScore,
      reason: result.decisionReason,
      components: {
        trend: {
          score: result.components?.trend?.score,
          reason: result.components?.trend?.reason,
        },
        range: {
          confidence: result.components?.range?.confidence,
          reason: result.components?.range?.reason,
        },
        volatility: {
          level: result.components?.volatility?.level,
          reason: result.components?.volatility?.reason,
        },
      },
      timeframe: tf,
      timestamp: result.timestamp,
      calculatedAt: result.calculatedAt,
    });
  });

  // ---------------------------------------------------------------------------
  // Regime Decision — regime-aware trade evaluation
  // ---------------------------------------------------------------------------

  router.get('/regime-decision', (req, res) => {
    if (!regimeDecisionEngine) {
      return res.status(503).json({ error: 'Regime Decision engine not available' });
    }

    const direction = (req.query.direction || 'BUY').toUpperCase();
    const regime = (req.query.regime || 'TRENDING_BULL').toUpperCase();
    const confidence = parseFloat(req.query.confidence) || 60;
    const confluenceScore = parseFloat(req.query.score) || 50;

    if (!['BUY', 'SELL'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be BUY or SELL' });
    }

    const decision = regimeDecisionEngine.evaluate({ regime, confidence, direction, confluenceScore });

    res.json({
      available: true,
      input: { regime, confidence, direction, confluenceScore },
      decision,
    });
  });

  // ---------------------------------------------------------------------------
  // Regime Decision Inspector — real-time regime decision breakdown
  // ---------------------------------------------------------------------------

  router.get('/regime-decision/inspector', (req, res) => {
    const decision = getLastDecision ? getLastDecision() : null;
    if (!decision) {
      return res.json({ available: false, message: 'No decision data yet' });
    }
    res.json({
      available: true,
      regime: decision.marketRegime || null,
      regimeDecision: decision.regimeDecision || null,
      confluence: decision.confluence || null,
      verdict: decision.verdict || null,
    });
  });

  // ---------------------------------------------------------------------------
  // Strategy Replay — historical execution pipeline replay
  // ---------------------------------------------------------------------------

  router.get('/strategy/replay', async (req, res) => {
    if (!strategyReplayEngine) {
      return res.status(503).json({ error: 'Strategy replay engine not available' });
    }

    const tf = (req.query.timeframe || '1h').toLowerCase();
    const days = parseInt(req.query.days) || 30;

    const valid = candleEngine.getAllTimeframes();
    if (!valid.includes(tf)) {
      return res.status(400).json({ error: 'Invalid timeframe', supported: valid });
    }

    let candles = candleEngine.getCandles(tf, 500);
    const active = candleEngine.getActive(tf);
    if (active && candles.length > 0 &&
        candles[candles.length - 1].openTime === active.openTime) {
      candles = candles.slice(0, -1);
    }

    if (candles.length === 0) {
      try {
        const fetch = require('node-fetch');
        const baseUrl = 'https://api.coingecko.com/api/v3';
        const ohlcRes = await fetch(`${baseUrl}/coins/bitcoin/ohlc?vs_currency=usd&days=${days}`);
        if (ohlcRes.ok) {
          const ohlcData = await ohlcRes.json();
          candles = ohlcData.map(([ts, open, high, low, close]) => ({
            openTime: ts,
            timestamp: new Date(ts).toISOString(),
            open, high, low, close,
            volume: 0,
          }));
        }
      } catch (e) {
        return res.status(500).json({ error: `Failed to fetch historical data: ${e.message}` });
      }
    }

    if (candles.length === 0) {
      return res.status(404).json({ error: 'No candle data available for replay' });
    }

    logger.info('StrategyReplay', `Starting replay | ${tf} | ${candles.length} candles | ${days} days`);

    const result = strategyReplayEngine.run(candles, tf);

    logger.info('StrategyReplay', `Replay complete | trades=${result.stats.totalTrades} | winRate=${result.stats.winRate}% | PF=${result.stats.profitFactor} | ${result.calculationTime}ms`);

    res.json(result);
  });

  return router;
}

module.exports = { createRouter };
