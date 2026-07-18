const express = require('express');
const cors = require('cors');
const path = require('path');

const { ConfigManager } = require('./src/config/config');
const { Logger } = require('./src/logger/logger');
const { CacheEngine } = require('./src/engine/cache');
const { HistoryEngine } = require('./src/engine/history');
const { MarketAnalyzer } = require('./src/engine/analyzer');
const { RetryHandler } = require('./src/network/retry');
const { ApiManager } = require('./src/network/apiManager');
const { CandleEngine } = require('./src/engine/candles');
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
const { RiskEngine } = require('./src/engine/risk');
const { StrategyReplayEngine } = require('./src/engine/strategyReplay');
const { createRouter } = require('./src/routes/routes');

const fetch = require('node-fetch');

const config = new ConfigManager();
const logger = new Logger(config);
const eventBus = new EventBus();
const symbol = config.get('SYMBOL');
const cache = new CacheEngine(config, logger, symbol);
const history = new HistoryEngine(config, logger, symbol);
const analyzer = new MarketAnalyzer(logger, symbol);
const candleEngine = new CandleEngine(config, logger, symbol);
const retry = new RetryHandler(config, logger);
const apiManager = new ApiManager(config, retry, cache, logger);
const indicatorRegistry = createIndicatorRegistry(symbol);
const structureEngine = new StructureEngine(logger, symbol);
const confluenceEngine = new ConfluenceEngine({ analyzer, indicatorRegistry, structureEngine, candleEngine, logger, config, symbol });
const validationEngine = new ValidationEngine({ analyzer, indicatorRegistry, structureEngine, candleEngine, logger, symbol });
const mtfEngine = new MTFEngine({ confluenceEngine, structureEngine, indicatorRegistry, candleEngine, analyzer, logger, config, symbol });
const macdEngine = new MACDEngine({ candleEngine, logger, symbol });
const atrEngine = new ATREngine({ candleEngine, logger, symbol });
const bollingerEngine = new BollingerEngine({ candleEngine, logger, symbol });
const signalHistoryEngine = new SignalHistoryEngine({ config, logger, symbol, history, analyzer, structureEngine, candleEngine, indicatorRegistry, confluenceEngine, mtfEngine, macdEngine });
const backtestEngine = new BacktestEngine({ structureEngine, indicatorRegistry, logger, symbol });
const analyticsEngine = new AnalyticsEngine({ logger, symbol });
const paperTradeEngine = new PaperTradingEngine({ logger, symbol });
const riskEngine = new RiskEngine({ logger, symbol });
const strategyReplayEngine = new StrategyReplayEngine({ logger, symbol, config });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const router = createRouter({ apiManager, history, analyzer, candleEngine, logger, config, eventBus, cache, indicatorRegistry, structureEngine, confluenceEngine, validationEngine, mtfEngine, macdEngine, atrEngine, bollingerEngine, signalHistoryEngine, backtestEngine, analyticsEngine, paperTradeEngine, riskEngine, strategyReplayEngine, symbol, getLastDecision: () => lastDecision });
app.use('/api', router);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

let lastSignalTime = 0;
const SIGNAL_COOLDOWN_MS = 60000;
let pipelineCycleCount = 0;
let lastDecision = null;

eventBus.on('market:snapshot', (snapshot) => {
  analyzer.analyze(history);
  signalHistoryEngine.record();
  runExecutionPipeline(snapshot);
});

function runExecutionPipeline(snapshot) {
  pipelineCycleCount++;
  const tf = '1h';
  const price = snapshot?.price;

  const divider = '─'.repeat(50);
  console.log(`\n${divider}`);
  console.log(`[Pipeline] Cycle #${pipelineCycleCount} | ${new Date().toLocaleTimeString()} | Price: $${price || 'N/A'}`);

  const riskThreshold = config.get('CONFLUENCE_BULLISH_THRESHOLD') || 65;
  const bearThreshold = config.get('CONFLUENCE_BEARISH_THRESHOLD') || 35;

  const decision = {
    timestamp: new Date().toISOString(),
    cycle: pipelineCycleCount,
    price: price || null,
    timeframe: tf,
    confluence: null,
    thresholds: { bullish: riskThreshold, bearish: bearThreshold },
    gates: {},
    engines: {},
    risk: null,
    verdict: { tradeOpened: false, rejectionReason: null, trade: null },
  };

  if (!price || price <= 0) {
    decision.verdict.rejectionReason = 'No valid price data';
    lastDecision = decision;
    console.log(`  Confluence Score: --`);
    console.log(`  Bias: --`);
    console.log(`  Trade Allowed: NO`);
    console.log(`  Execution Triggered: NO`);
    console.log(`  Reason: No valid price data`);
    console.log(divider);
    return;
  }

  const allCandles = candleEngine.getCandles(tf, 500);
  const active = candleEngine.getActive(tf);
  let finalized = allCandles;
  if (active && allCandles.length > 0 &&
      allCandles[allCandles.length - 1].openTime === active.openTime) {
    finalized = allCandles.slice(0, -1);
  }

  if (finalized.length < 15) {
    decision.verdict.rejectionReason = `Insufficient candles (${finalized.length}/15 minimum)`;
    lastDecision = decision;
    console.log(`  Confluence Score: --`);
    console.log(`  Bias: --`);
    console.log(`  Trade Allowed: NO`);
    console.log(`  Execution Triggered: NO`);
    console.log(`  Reason: Insufficient candles (${finalized.length}/15 minimum)`);
    console.log(divider);
    return;
  }

  const confluence = confluenceEngine.calculate(finalized, tf);
  decision.confluence = { score: confluence.score, bias: confluence.bias, confidence: confluence.confidence, components: confluence.components };

  const atr = atrEngine.calculate(tf);
  const trend = analyzer.getAnalysis();
  const structureResult = structureEngine.calculate(finalized);
  const rsiResult = indicatorRegistry.get('RSI')?.calculate(finalized, tf);
  const emaResult = indicatorRegistry.get('EMA')?.calculate(finalized, tf, 20);
  const macdResult = macdEngine.calculate(tf);
  const bollingerResult = bollingerEngine.calculate(tf);

  decision.engines.trend = trend;
  decision.engines.structure = { ...structureResult };
  decision.engines.rsi = rsiResult ? { ready: rsiResult.ready, value: rsiResult.value, state: rsiResult.state } : null;
  decision.engines.ema = emaResult ? { ready: emaResult.ready, value: emaResult.value, trend: emaResult.trend } : null;
  decision.engines.macd = macdResult ? { ready: macdResult.ready, macd: macdResult.macd, signal: macdResult.signal, histogram: macdResult.histogram, trend: macdResult.trend } : null;
  decision.engines.atr = atr ? { ready: atr.ready, atr: atr.atr, atrPercentage: atr.atrPercentage, volatilityLevel: atr.volatilityLevel, volatilityTrend: atr.volatilityTrend } : null;
  decision.engines.bollinger = bollingerResult ? { ready: bollingerResult.ready, middleBand: bollingerResult.middleBand, upperBand: bollingerResult.upperBand, lowerBand: bollingerResult.lowerBand, pricePosition: bollingerResult.pricePosition, percentB: bollingerResult.percentB, squeeze: bollingerResult.squeeze } : null;

  const trendDir = trend?.trend?.['1H'] || trend?.trend?.[tf] || 'Sideways';
  decision.gates.trend = { pass: trendDir !== 'Sideways', value: trendDir, detail: `1H trend: ${trendDir}` };

  const structDir = structureResult?.direction || 'Neutral';
  decision.gates.structure = { pass: structDir !== 'Neutral' && (structureResult?.score > 0), value: structDir, detail: `${structureResult?.structure || '--'} (score: ${structureResult?.score || 0})` };

  const rsiVal = rsiResult?.ready ? rsiResult.value : null;
  const rsiPass = rsiVal != null && (rsiVal > 55 || rsiVal < 45);
  decision.gates.rsi = { pass: rsiPass, value: rsiVal != null ? rsiVal : '--', detail: rsiVal != null ? `${rsiVal} (${rsiResult.state || 'Neutral'})` : 'Not ready' };

  const emaTrend = emaResult?.trend || 'N/A';
  const emaPass = emaResult?.ready && (emaTrend === 'Above' || emaTrend === 'Below');
  decision.gates.ema = { pass: emaPass, value: emaTrend, detail: emaResult?.ready ? `Value: ${emaResult.value} (${emaTrend})` : 'Not ready' };

  const macdTrend = macdResult?.trend || 'Neutral';
  const macdPass = macdResult?.ready && macdTrend !== 'Neutral';
  decision.gates.macd = { pass: macdPass, value: macdTrend, detail: macdResult?.ready ? `MACD: ${macdResult.macd} | Signal: ${macdResult.signal} | Hist: ${macdResult.histogram}` : 'Not ready' };

  decision.gates.atr = { pass: atr?.ready || false, value: atr?.ready ? `$${atr.atr}` : '--', detail: atr?.ready ? `${atr.atrPercentage}% | Volatility: ${atr.volatilityLevel} | Trend: ${atr.volatilityTrend}` : 'Not ready' };

  const bbPos = bollingerResult?.pricePosition || 'Inside Bands';
  const bbPass = bollingerResult?.ready && (bbPos === 'Above Upper' || bbPos === 'Below Lower');
  const bbPB = (bollingerResult?.ready && bollingerResult.upperBand !== bollingerResult.lowerBand)
    ? ((price - bollingerResult.lowerBand) / (bollingerResult.upperBand - bollingerResult.lowerBand) * 100).toFixed(1)
    : '--';
  decision.engines.bollinger = { ready: bollingerResult?.ready, middleBand: bollingerResult?.middleBand, upperBand: bollingerResult?.upperBand, lowerBand: bollingerResult?.lowerBand, pricePosition: bbPos, percentB: bbPB, squeeze: bollingerResult?.squeeze };
  decision.gates.bollinger = { pass: bbPass, value: bbPos, detail: bollingerResult?.ready ? `Upper: $${bollingerResult.upperBand} | Mid: $${bollingerResult.middleBand} | Lower: $${bollingerResult.lowerBand} | %B: ${bbPB}` : 'Not ready' };

  let direction = null;
  if (confluence.bias === 'Bullish') direction = 'BUY';
  else if (confluence.bias === 'Bearish') direction = 'SELL';

  if (!direction) {
    let biasReason = '';
    if (confluence.score > bearThreshold && confluence.score < riskThreshold) {
      biasReason = `Score ${confluence.score} is between thresholds (${bearThreshold}-${riskThreshold})`;
    } else if (confluence.score === riskThreshold || confluence.score === bearThreshold) {
      biasReason = `Score ${confluence.score} is exactly on threshold`;
    } else {
      biasReason = `Score ${confluence.score} with ${confluence.missing?.length || 0} missing components`;
    }
    decision.gates.confluenceBias = { pass: false, value: confluence.bias, detail: biasReason };
    decision.gates.riskEngine = { pass: false, value: '--', detail: 'Skipped (confluence is Neutral)' };
    decision.verdict.rejectionReason = `Confluence bias: ${biasReason}`;
    lastDecision = decision;

    console.log(`  Confluence Score: ${confluence.score}`);
    console.log(`  Bias: ${confluence.bias} (bullish threshold: ${riskThreshold}, bearish threshold: ${bearThreshold})`);
    console.log(`  Confidence: ${confluence.confidence}%`);
    console.log(`  Components: trend=${confluence.components?.trend?.score ?? '--'} structure=${confluence.components?.structure?.score ?? '--'} momentum=${confluence.components?.momentum?.score ?? '--'} rsi=${confluence.components?.rsi?.score ?? '--'} volatility=${confluence.components?.volatility?.score ?? '--'}`);
    console.log(`  Trade Allowed: NO`);
    console.log(`  Execution Triggered: NO`);
    console.log(`  Reason: ${biasReason}`);
    console.log(divider);
    paperTradeEngine.evaluateTrades(price);
    return;
  }

  decision.gates.confluenceBias = { pass: true, value: confluence.bias, detail: `Score ${confluence.score} → ${confluence.bias}` };

  const riskResult = riskEngine.evaluate({
    symbol,
    timeframe: tf,
    entryPrice: price,
    atr: atr || { ready: false, atr: null, atrPercentage: 0 },
    direction,
    trend,
    structure: structureResult,
    confluence,
  });

  decision.risk = riskResult;
  decision.gates.riskEngine = { pass: riskResult.tradeAllowed, value: riskResult.tradeAllowed ? 'ALLOWED' : 'BLOCKED', detail: riskResult.tradeAllowed ? `ATR-based SL/TP | R:R 1:${riskResult.riskReward}` : riskResult.rejectionReason };

  console.log(`  Confluence Score: ${confluence.score}`);
  console.log(`  Bias: ${confluence.bias}`);
  console.log(`  Confidence: ${confluence.confidence}%`);
  console.log(`  Components: trend=${confluence.components?.trend?.score ?? '--'} structure=${confluence.components?.structure?.score ?? '--'} momentum=${confluence.components?.momentum?.score ?? '--'} rsi=${confluence.components?.rsi?.score ?? '--'} volatility=${confluence.components?.volatility?.score ?? '--'}`);
  console.log(`  Signal: ${direction} (price=$${price})`);
  console.log(`  Trade Allowed: ${riskResult.tradeAllowed ? 'YES' : 'NO'}`);

  if (!riskResult.tradeAllowed) {
    decision.verdict.rejectionReason = `Risk Engine: ${riskResult.rejectionReason}`;
    lastDecision = decision;
    console.log(`  Execution Triggered: NO`);
    console.log(`  Reason: Risk Engine — ${riskResult.rejectionReason}`);
    console.log(divider);
    paperTradeEngine.evaluateTrades(price);
    return;
  }

  const now = Date.now();
  if (now - lastSignalTime < SIGNAL_COOLDOWN_MS) {
    const waitSec = Math.ceil((SIGNAL_COOLDOWN_MS - (now - lastSignalTime)) / 1000);
    decision.verdict.rejectionReason = `Cooldown active — ${waitSec}s remaining (min ${SIGNAL_COOLDOWN_MS / 1000}s between trades)`;
    lastDecision = decision;
    console.log(`  Execution Triggered: NO`);
    console.log(`  Reason: Cooldown active — ${waitSec}s remaining (min ${SIGNAL_COOLDOWN_MS / 1000}s between trades)`);
    console.log(divider);
    paperTradeEngine.evaluateTrades(price);
    return;
  }

  const engines = {
    trend,
    structure: structureResult,
    rsi: rsiResult,
    ema: emaResult,
    macd: macdResult,
    atr: atr,
    bollinger: bollingerResult,
    confluence,
    mtf: (() => { try { return mtfEngine.calculate(500); } catch(e) { return null; } })(),
  };

  const trade = paperTradeEngine.signal(engines, price, tf);

  if (trade) {
    lastSignalTime = now;
    decision.verdict.tradeOpened = true;
    decision.verdict.trade = {
      tradeId: trade.tradeId,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      riskReward: trade.riskReward,
      positionSize: trade.positionSize,
      confidence: trade.confidence,
      reason: trade.reason,
    };
    lastDecision = decision;
    console.log(`  Execution Triggered: YES`);
    console.log(`  Trade Opened: YES`);
    console.log(`  Trade ID: ${trade.tradeId}`);
    console.log(`  Direction: ${trade.direction}`);
    console.log(`  Entry: $${trade.entryPrice}`);
    console.log(`  Stop Loss: $${trade.stopLoss}`);
    console.log(`  Take Profit: $${trade.takeProfit}`);
    console.log(`  Risk/Reward: 1:${trade.riskReward}`);
    console.log(`  Confidence: ${trade.confidence}%`);
    console.log(`  Position Size: ${trade.positionSize}`);
    console.log(`  Reason: ${trade.reason}`);
  } else {
    decision.verdict.rejectionReason = 'paperTradeEngine.signal() rejected — internal analysis: direction neutral or confidence < 30%';
    lastDecision = decision;
    console.log(`  Execution Triggered: YES`);
    console.log(`  Trade Opened: NO`);
    console.log(`  Reason: paperTradeEngine.signal() rejected — internal analysis: direction neutral or confidence < 30%`);
  }

  const closed = paperTradeEngine.evaluateTrades(price);
  if (closed.length > 0) {
    for (const t of closed) {
      console.log(`  Trade Closed: ${t.tradeId} | ${t.exitReason} | Entry=$${t.entryPrice} → Exit=$${t.exitPrice} | PnL=$${t.pnl} (${t.pnlPercent}%)`);
    }
  }

  const activeCandle = candleEngine.getActive(tf);
  if (activeCandle) {
    const candleResult = paperTradeEngine.onCandle(activeCandle);
    if (candleResult && candleResult.closed && candleResult.closed.length > 0) {
      for (const t of candleResult.closed) {
        console.log(`  Trade Closed (candle): ${t.tradeId} | ${t.exitReason} | PnL=$${t.pnl} (${t.pnlPercent}%)`);
      }
    }
  }

  const openCount = paperTradeEngine.open().length;
  const closedCount = paperTradeEngine.closed().length;
  console.log(`  Portfolio: ${openCount} open | ${closedCount} closed | Balance: $${paperTradeEngine.getBalance()}`);
  console.log(divider);
}

let fetchInProgress = false;

async function seedHistoricalCandles() {
  const baseUrl = 'https://api.coingecko.com/api/v3';
  const coinId = 'bitcoin';
  const vsCurrency = 'usd';
  let seeded = 0;

  try {
    logger.system('Server', 'Seeding historical candles from CoinGecko...');

    const ohlcRes = await fetch(`${baseUrl}/coins/${coinId}/ohlc?vs_currency=${vsCurrency}&days=30`);
    if (ohlcRes.ok) {
      const ohlcData = await ohlcRes.json();
      for (const [ts, open, high, low, close] of ohlcData) {
        const avgPrice = (open + high + low + close) / 4;
        candleEngine.ingest({
          symbol,
          price: close,
          open: open,
          high: high,
          low: low,
          volume: 0,
          timestamp: new Date(ts).toISOString(),
        });
        seeded++;
      }
      logger.system('Server', `Seeded ${ohlcData.length} OHLC candles (4h, 30-day)`);
    } else {
      logger.warn('Server', `OHLC endpoint returned ${ohlcRes.status}`);
    }

    await new Promise(r => setTimeout(r, 1500));

    const mcRes = await fetch(`${baseUrl}/coins/${coinId}/market_chart?vs_currency=${vsCurrency}&days=2`);
    if (mcRes.ok) {
      const mcData = await mcRes.json();
      const prices = mcData.prices || [];
      const volumes = mcData.total_volumes || [];
      for (let i = 0; i < prices.length; i++) {
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
    logger.warn('Server', `Historical seed failed: ${err.message} — proceeding without history`);
  }
}

async function fetchCycle() {
  if (fetchInProgress) {
    logger.warn('Server', 'Fetch cycle skipped — previous cycle still running');
    return;
  }

  fetchInProgress = true;
  try {
    const snapshot = await apiManager.fetchMarketData();
    history.add(snapshot);
    candleEngine.ingest(snapshot);
    eventBus.emit('market:snapshot', snapshot);
  } catch (err) {
    apiManager.fail();
    const fallback = cache.get();
    if (fallback) {
      const freshFallback = { ...fallback, timestamp: new Date().toISOString() };
      history.add(freshFallback);
      candleEngine.ingest(freshFallback);
      eventBus.emit('market:snapshot', freshFallback);
      logger.warn('Server', 'Using cached data after failure', {
        error: err.message,
      });
    } else {
      logger.error('Server', 'Fetch failed and no cache available', {
        error: err.message,
      });
    }
  } finally {
    fetchInProgress = false;
  }
}

const port = config.get('PORT');
const interval = config.get('REFRESH_INTERVAL');

app.listen(port, async () => {
  logger.system('Server', `Atlas v1.0 running on port ${port}`);
  logger.system('Server', `Config loaded`, {
    refreshInterval: interval,
    maxHistory: config.get('MAX_HISTORY'),
    cacheTTL: config.get('CACHE_TTL'),
    logLevel: config.get('LOG_LEVEL'),
  });

  await seedHistoricalCandles();

  fetchCycle();
  setInterval(fetchCycle, interval);
});
