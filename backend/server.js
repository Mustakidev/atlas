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
const { RegimeEngine } = require('./src/market-regime/RegimeEngine');
const { RegimeDecisionEngine } = require('./src/market-regime/RegimeDecisionEngine');
const { AdvanceRiskEngine } = require('./src/engine/advanceRisk');
const { MTFConfirmationEngine } = require('./src/engine/mtfConfirmation');
const { createRouter } = require('./src/routes/routes');

const fetch = require('node-fetch');
const fs = require('fs');
const { createAuth } = require('./src/middleware/auth');
const { createGlobalLimiter, createExpensiveLimiter, createConditionalExpensive } = require('./src/middleware/rateLimit');

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

const auth = createAuth(config, logger);
const globalLimiter = createGlobalLimiter(config, logger);
const expensiveLimiter = createConditionalExpensive(createExpensiveLimiter(config, logger));
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
const mtfEngine = new MTFEngine({ confluenceEngine, structureEngine, indicatorRegistry, candleEngine, analyzer, logger, config, symbol });
const macdEngine = new MACDEngine({ candleEngine, logger, symbol });
const atrEngine = new ATREngine({ candleEngine, logger, symbol });
const bollingerEngine = new BollingerEngine({ candleEngine, logger, symbol });
const signalHistoryEngine = new SignalHistoryEngine({ config, logger, symbol, history, analyzer, structureEngine, candleEngine, indicatorRegistry, confluenceEngine, mtfEngine, macdEngine });
const backtestEngine = new BacktestEngine({ structureEngine, indicatorRegistry, logger, symbol });
const analyticsEngine = new AnalyticsEngine({ logger, symbol });
const paperTradeEngine = new PaperTradingEngine({ logger, symbol });
const riskEngine = new RiskEngine({ logger, symbol });
const regimeEngine = new RegimeEngine({ indicatorRegistry, atrEngine, candleEngine, analyzer, logger, config, symbol });
const regimeDecisionEngine = new RegimeDecisionEngine({ logger, symbol });
const advanceRiskEngine = new AdvanceRiskEngine({ logger, symbol, paperTradeEngine, config });
const mtfConfirmationEngine = new MTFConfirmationEngine({ logger, symbol, config });
const strategyReplayEngine = new StrategyReplayEngine({ logger, symbol, config, advanceRiskEngine, mtfConfirmationEngine });
strategyReplayEngine.setRegimeEngine(regimeEngine);
const validationEngine = new ValidationEngine({ analyzer, indicatorRegistry, structureEngine, candleEngine, regimeEngine, regimeDecisionEngine, advanceRiskEngine, mtfConfirmationEngine, logger, symbol });

const app = express();
const allowedOrigins = config.get('CORS_ORIGIN').split(',').map(s => s.trim());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS', 'Blocked request from unauthorized origin', { origin });
      callback(null, false);
    }
  },
}));
app.use(express.json({ limit: config.get('MAX_BODY_SIZE') }));
app.use(globalLimiter);

// Serve index.html with injected API key (must be before static middleware)
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, '../frontend/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const apiKey = config.get('API_KEY');
  const injected = html.replace('<head>', '<head>\n  <script>window.__ATLAS_API_KEY="' + apiKey + '";</script>');
  res.type('html').send(injected);
});

// Static files (CSS, JS, images) — index:false avoids serving index.html for /
app.use(express.static(path.join(__dirname, '../frontend'), { index: false }));

const router = createRouter({ apiManager, history, analyzer, candleEngine, logger, config, eventBus, cache, indicatorRegistry, structureEngine, confluenceEngine, validationEngine, mtfEngine, macdEngine, atrEngine, bollingerEngine, signalHistoryEngine, backtestEngine, analyticsEngine, paperTradeEngine, riskEngine, strategyReplayEngine, regimeEngine, regimeDecisionEngine, advanceRiskEngine, mtfConfirmationEngine, symbol, getLastDecision: () => lastDecision, getPipelineHealth });
app.use('/api', expensiveLimiter, auth, router);

let lastSignalTime = 0;
const SIGNAL_COOLDOWN_MS = 60000;
let pipelineCycleCount = 0;
let lastDecision = null;
let pipelineErrors = 0;
let lastPipelineError = null;
let lastSuccessfulCycle = null;

function safeExecute(engineName, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    pipelineErrors++;
    lastPipelineError = { engine: engineName, timestamp: new Date().toISOString(), error: err.message };
    logger.error('Pipeline', `Engine failure: ${engineName}`, { error: err.message });
    return fallback;
  }
}

function getPipelineHealth() {
  return {
    pipelineCycleCount,
    pipelineErrors,
    lastPipelineError,
    lastSuccessfulCycle,
  };
}

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
    marketRegime: null,
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

  lastSuccessfulCycle = new Date().toISOString();

  const marketRegime = safeExecute('RegimeEngine', () => regimeEngine.calculate(finalized, tf), {
    regime: 'UNKNOWN', confidence: 0, trendScore: 50, rangeScore: 50,
    volatility: 'UNKNOWN', decisionReason: 'Regime engine failed',
  });
  decision.marketRegime = {
    regime: marketRegime.regime,
    confidence: marketRegime.confidence,
    trendScore: marketRegime.trendScore,
    rangeScore: marketRegime.rangeScore,
    volatility: marketRegime.volatility,
    decisionReason: marketRegime.decisionReason,
  };

  const confluence = safeExecute('ConfluenceEngine', () => confluenceEngine.calculate(finalized, tf), {
    score: 50, bias: 'Neutral', confidence: 0, components: {},
  });
  decision.confluence = { score: confluence.score, bias: confluence.bias, confidence: confluence.confidence, components: confluence.components };

  const atr = safeExecute('ATREngine', () => atrEngine.calculate(tf), null);
  const trend = safeExecute('MarketAnalyzer', () => analyzer.getAnalysis(), null);
  const structureResult = safeExecute('StructureEngine', () => structureEngine.calculate(finalized), null);
  const rsiResult = safeExecute('RSI', () => indicatorRegistry.get('RSI')?.calculate(finalized, tf), null);
  const emaResult = safeExecute('EMA', () => indicatorRegistry.get('EMA')?.calculate(finalized, tf, 20), null);
  const macdResult = safeExecute('MACDEngine', () => macdEngine.calculate(tf), null);
  const bollingerResult = safeExecute('BollingerEngine', () => bollingerEngine.calculate(tf), null);

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
    decision.gates.mtfConfirmation = { pass: false, value: '--', detail: 'Skipped (no direction)' };
    decision.gates.advanceRisk = { pass: false, value: '--', detail: 'Skipped (confluence is Neutral)' };
    decision.verdict.rejectionReason = `Confluence bias: ${biasReason}`;
    lastDecision = decision;

    const neutralRegimeDecision = safeExecute('RegimeDecisionEngine', () => regimeDecisionEngine.evaluate({
      regime: marketRegime.regime,
      confidence: marketRegime.confidence,
      direction: null,
      confluenceScore: confluence.score,
    }), { allowTrade: false, penalty: 0, preferredDirection: null, reason: 'Regime decision engine failed' });
    decision.regimeDecision = neutralRegimeDecision;
    decision.gates.regimeDecision = {
      pass: true,
      value: 'NEUTRAL',
      detail: `[${marketRegime.regime}] ${neutralRegimeDecision.reason}`,
    };

    console.log(`  Market Regime: ${marketRegime.regime} (conf: ${marketRegime.confidence}) | TrendScore: ${marketRegime.trendScore} | RangeScore: ${marketRegime.rangeScore} | Vol: ${marketRegime.volatility}`);
    console.log(`  Confluence Score: ${confluence.score}`);
    console.log(`  Bias: ${confluence.bias} (bullish threshold: ${riskThreshold}, bearish threshold: ${bearThreshold})`);
    console.log(`  Confidence: ${confluence.confidence}%`);
    console.log(`  Components: trend=${confluence.components?.trend?.score ?? '--'} structure=${confluence.components?.structure?.score ?? '--'} momentum=${confluence.components?.momentum?.score ?? '--'} rsi=${confluence.components?.rsi?.score ?? '--'} volatility=${confluence.components?.volatility?.score ?? '--'}`);
    console.log(`  Regime Decision: SKIP (no direction) | ${neutralRegimeDecision.reason}`);
    console.log(`  Trade Allowed: NO`);
    console.log(`  Execution Triggered: NO`);
    console.log(`  Reason: ${biasReason}`);
    console.log(divider);
    safeExecute('PaperTrading', () => paperTradeEngine.evaluateTrades(price), []);
    return;
  }

  decision.gates.confluenceBias = { pass: true, value: confluence.bias, detail: `Score ${confluence.score} → ${confluence.bias}` };

  const regimeDecision = safeExecute('RegimeDecisionEngine', () => regimeDecisionEngine.evaluate({
    regime: marketRegime.regime,
    confidence: marketRegime.confidence,
    direction,
    confluenceScore: confluence.score,
  }), { allowTrade: false, penalty: 0, preferredDirection: direction, reason: 'Regime decision engine failed' });
  decision.regimeDecision = regimeDecision;
  decision.gates.regimeDecision = {
    pass: regimeDecision.allowTrade,
    value: regimeDecision.allowTrade ? 'ALLOWED' : 'BLOCKED',
    detail: `[${marketRegime.regime}] ${regimeDecision.reason}`,
  };

  if (!regimeDecision.allowTrade) {
    decision.verdict.rejectionReason = `Regime Decision: ${regimeDecision.reason}`;
    lastDecision = decision;
    console.log(`  Market Regime: ${marketRegime.regime} (conf: ${marketRegime.confidence}) | TrendScore: ${marketRegime.trendScore} | RangeScore: ${marketRegime.rangeScore} | Vol: ${marketRegime.volatility}`);
    console.log(`  Confluence Score: ${confluence.score}`);
    console.log(`  Bias: ${confluence.bias}`);
    console.log(`  Confidence: ${confluence.confidence}%`);
    console.log(`  Components: trend=${confluence.components?.trend?.score ?? '--'} structure=${confluence.components?.structure?.score ?? '--'} momentum=${confluence.components?.momentum?.score ?? '--'} rsi=${confluence.components?.rsi?.score ?? '--'} volatility=${confluence.components?.volatility?.score ?? '--'}`);
    console.log(`  Regime Decision: BLOCKED — ${regimeDecision.reason}`);
    console.log(`  Trade Allowed: NO`);
    console.log(`  Execution Triggered: NO`);
    console.log(divider);
    safeExecute('PaperTrading', () => paperTradeEngine.evaluateTrades(price), []);
    return;
  }

  // Collect multi-timeframe confluence data for MTF confirmation
  const mtfTimeframes = {};
  const mtfTFs = ['1m', '5m', '15m', '1h'];
  for (const mtfTF of mtfTFs) {
    const mtfCandles = candleEngine.getCandles(mtfTF, 100);
    const mtfActive = candleEngine.getActive(mtfTF);
    let mtfFinalized = mtfCandles;
    if (mtfActive && mtfCandles.length > 0 &&
        mtfCandles[mtfCandles.length - 1].openTime === mtfActive.openTime) {
      mtfFinalized = mtfCandles.slice(0, -1);
    }
    if (mtfFinalized.length >= 15) {
      const mtfConfluence = safeExecute('MTF-Confluence', () => confluenceEngine.calculate(mtfFinalized, mtfTF), { score: 50, bias: 'Neutral', confidence: 0 });
      const mtfAtr = safeExecute('MTF-ATR', () => atrEngine.calculate(mtfTF), null);
      mtfTimeframes[mtfTF] = {
        confluence: {
          score: mtfConfluence.score,
          bias: mtfConfluence.bias,
          confidence: mtfConfluence.confidence,
        },
        volatilityLevel: mtfAtr?.volatilityLevel || null,
      };
    }
  }

  const mtfResult = safeExecute('MTFConfirmation', () => mtfConfirmationEngine.evaluate({
    direction,
    timeframe: tf,
    timeframes: mtfTimeframes,
  }), { mtfAllowed: false, rejectionReason: 'MTF confirmation engine failed', confidence: 0, alignmentScore: 0 });

  decision.mtfConfirmation = mtfResult;
  decision.gates.mtfConfirmation = {
    pass: mtfResult.mtfAllowed,
    value: mtfResult.mtfAllowed ? 'ALLOWED' : 'BLOCKED',
    detail: mtfResult.mtfAllowed
      ? `MTF confirmed | confidence=${mtfResult.confidence}% | alignment=${mtfResult.alignmentScore}%`
      : mtfResult.rejectionReason,
  };

  if (!mtfResult.mtfAllowed) {
    decision.verdict.rejectionReason = mtfResult.rejectionReason;
    lastDecision = decision;
    console.log(`  MTF Confirmation: BLOCKED — ${mtfResult.rejectionReason}`);
    console.log(`  Trade Allowed: NO`);
    console.log(`  Execution Triggered: NO`);
    console.log(divider);
    safeExecute('PaperTrading', () => paperTradeEngine.evaluateTrades(price), []);
    return;
  }

  const riskResult = safeExecute('AdvanceRisk', () => advanceRiskEngine.evaluate({
    symbol,
    timeframe: tf,
    entryPrice: price,
    atr: atr || { ready: false, atr: null, atrPercentage: 0 },
    direction,
    trend,
    structure: structureResult,
    confluence,
    regime: marketRegime.regime,
  }), { tradeAllowed: false, rejectionReason: 'Advance risk engine failed', positionSize: 0, stopLoss: 0, takeProfit: 0, riskReward: 0, session: null });

  decision.risk = riskResult;
  decision.gates.advanceRisk = { pass: riskResult.tradeAllowed, value: riskResult.tradeAllowed ? 'ALLOWED' : 'BLOCKED', detail: riskResult.tradeAllowed
    ? `AdvanceRisk | pos=${riskResult.positionSize} | SL=$${riskResult.stopLoss} | TP=$${riskResult.takeProfit} | R:R 1:${riskResult.riskReward}`
    : riskResult.rejectionReason };

  console.log(`  Market Regime: ${marketRegime.regime} (conf: ${marketRegime.confidence}) | TrendScore: ${marketRegime.trendScore} | RangeScore: ${marketRegime.rangeScore} | Vol: ${marketRegime.volatility}`);
  console.log(`  Confluence Score: ${confluence.score}`);
  console.log(`  Bias: ${confluence.bias}`);
  console.log(`  Confidence: ${confluence.confidence}%`);
  console.log(`  Components: trend=${confluence.components?.trend?.score ?? '--'} structure=${confluence.components?.structure?.score ?? '--'} momentum=${confluence.components?.momentum?.score ?? '--'} rsi=${confluence.components?.rsi?.score ?? '--'} volatility=${confluence.components?.volatility?.score ?? '--'}`);
  console.log(`  Regime Decision: ${regimeDecision.allowTrade ? 'ALLOWED' : 'BLOCKED'} | Preferred: ${regimeDecision.preferredDirection} | Penalty: ${regimeDecision.penalty}`);
  console.log(`  Signal: ${direction} (price=$${price})`);
  console.log(`  MTF Confirmation: ${mtfResult.mtfAllowed ? 'ALLOWED' : 'BLOCKED'} | conf=${mtfResult.confidence}% | alignment=${mtfResult.alignmentScore}%`);
  console.log(`  AdvanceRisk: Session=${riskResult.session || '--'} | PosSize=${riskResult.positionSize || '--'} | SL=$${riskResult.stopLoss || '--'} | TP=$${riskResult.takeProfit || '--'} | R:R=${riskResult.riskReward || '--'}`);
  console.log(`  Trade Allowed: ${riskResult.tradeAllowed ? 'YES' : 'NO'}`);

  if (!riskResult.tradeAllowed) {
    decision.verdict.rejectionReason = `AdvanceRisk: ${riskResult.rejectionReason}`;
    lastDecision = decision;
    console.log(`  Execution Triggered: NO`);
    console.log(`  Reason: ${riskResult.rejectionReason}`);
    console.log(divider);
    safeExecute('PaperTrading', () => paperTradeEngine.evaluateTrades(price), []);
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
    safeExecute('PaperTrading', () => paperTradeEngine.evaluateTrades(price), []);
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

  const trade = safeExecute('PaperTrading', () => paperTradeEngine.signal(engines, price, tf, direction), null);

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

  const closed = safeExecute('PaperTrading', () => paperTradeEngine.evaluateTrades(price), []);
  if (closed.length > 0) {
    for (const t of closed) {
      safeExecute('AdvanceRisk', () => advanceRiskEngine.onTradeClosed(t.pnl), undefined);
      console.log(`  Trade Closed: ${t.tradeId} | ${t.exitReason} | Entry=$${t.entryPrice} → Exit=$${t.exitPrice} | PnL=$${t.pnl} (${t.pnlPercent}%)`);
    }
  }

  const activeCandle = candleEngine.getActive(tf);
  if (activeCandle) {
    const candleResult = safeExecute('PaperTrading', () => paperTradeEngine.onCandle(activeCandle), null);
    if (candleResult && candleResult.closed && candleResult.closed.length > 0) {
      for (const t of candleResult.closed) {
        safeExecute('AdvanceRisk', () => advanceRiskEngine.onTradeClosed(t.pnl), undefined);
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
