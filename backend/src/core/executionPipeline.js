const { getFinalizedCandles } = require('../engine/candleUtils');
const { captureCycleTime, resolveClock } = require('./clock');

function isValidCandle(candle) {
  return Boolean(candle)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && candle.high >= candle.low
    && candle.close >= candle.low
    && candle.close <= candle.high;
}

function createExecutionPipeline({
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
}) {
  const time = resolveClock(clock);
  let lastSignalTime = 0;
  let pipelineCycleCount = 0;
  let lastDecision = null;
  let pipelineErrors = 0;
  let lastPipelineError = null;
  let lastSuccessfulCycle = null;

  function safeExecute(engineName, fn, fallback, cycle) {
    try {
      return fn();
    } catch (err) {
      pipelineErrors++;
      lastPipelineError = { engine: engineName, timestamp: cycle.isoNow, error: err.message };
      logger.error('Pipeline', `Engine failure: ${engineName}`, { error: err.message });
      return fallback;
    }
  }

  function processTradeLifecycle(price, activeCandle, cycle) {
    const context = Object.freeze({ nowMs: cycle.nowMs });
    const closed = safeExecute('PaperTrading', () => paperTradeEngine.evaluateTrades(price, context), [], cycle);
    if (closed.length > 0) {
      for (const t of closed) {
        safeExecute('AdvanceRisk', () => advanceRiskEngine.onTradeClosed(t.pnl, context), undefined, cycle);
        console.log(`  Trade Closed: ${t.tradeId} | ${t.exitReason} | Entry=$${t.entryPrice} → Exit=$${t.exitPrice} | PnL=$${t.pnl} (${t.pnlPercent}%)`);
      }
    }

    if (!isValidCandle(activeCandle)) return;

    const candleResult = safeExecute('PaperTrading', () => paperTradeEngine.onCandle(activeCandle, context), null, cycle);
    if (candleResult && candleResult.closed && candleResult.closed.length > 0) {
      for (const t of candleResult.closed) {
        safeExecute('AdvanceRisk', () => advanceRiskEngine.onTradeClosed(t.pnl, context), undefined, cycle);
        console.log(`  Trade Closed (candle): ${t.tradeId} | ${t.exitReason} | PnL=$${t.pnl} (${t.pnlPercent}%)`);
      }
    }
  }

  function run(snapshot) {
    pipelineCycleCount++;
    const cycle = captureCycleTime(time);
    const tf = '1h';
    const price = snapshot?.price;

    const divider = '─'.repeat(50);
    console.log(`\n${divider}`);
    console.log(`[Pipeline] Cycle #${pipelineCycleCount} | ${cycle.localeTime} | Price: $${price || 'N/A'}`);

    const riskThreshold = config.get('CONFLUENCE_BULLISH_THRESHOLD') || 65;
    const bearThreshold = config.get('CONFLUENCE_BEARISH_THRESHOLD') || 35;

    const decision = {
      timestamp: cycle.isoNow,
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

    if (!Number.isFinite(price) || price <= 0) {
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

    const activeCandle = candleEngine.getActive(tf);
    processTradeLifecycle(price, activeCandle, cycle);

    const finalized = getFinalizedCandles(candleEngine, tf, 500);

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

    lastSuccessfulCycle = cycle.isoNow;

    const marketRegime = safeExecute('RegimeEngine', () => regimeEngine.calculate(finalized, tf), {
      regime: 'UNKNOWN', confidence: 0, trendScore: 50, rangeScore: 50,
      volatility: 'UNKNOWN', decisionReason: 'Regime engine failed',
    }, cycle);
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
    }, cycle);
    decision.confluence = { score: confluence.score, bias: confluence.bias, confidence: confluence.confidence, components: confluence.components };

    const atr = safeExecute('ATREngine', () => atrEngine.calculate(tf), null, cycle);
    const trend = safeExecute('MarketAnalyzer', () => analyzer.getAnalysis(), null, cycle);
    const structureResult = safeExecute('StructureEngine', () => structureEngine.calculate(finalized), null, cycle);
    const rsiResult = safeExecute('RSI', () => indicatorRegistry.get('RSI')?.calculate(finalized, tf), null, cycle);
    const emaResult = safeExecute('EMA', () => indicatorRegistry.get('EMA')?.calculate(finalized, tf, 20), null, cycle);
    const macdResult = safeExecute('MACDEngine', () => macdEngine.calculate(tf), null, cycle);
    const bollingerResult = safeExecute('BollingerEngine', () => bollingerEngine.calculate(tf), null, cycle);

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
      }), { allowTrade: false, penalty: 0, preferredDirection: null, reason: 'Regime decision engine failed' }, cycle);
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
      return;
    }

    decision.gates.confluenceBias = { pass: true, value: confluence.bias, detail: `Score ${confluence.score} → ${confluence.bias}` };
    const regimeDecision = safeExecute('RegimeDecisionEngine', () => regimeDecisionEngine.evaluate({
      regime: marketRegime.regime,
      confidence: marketRegime.confidence,
      direction,
      confluenceScore: confluence.score,
    }), { allowTrade: false, penalty: 0, preferredDirection: direction, reason: 'Regime decision engine failed' }, cycle);
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
      return;
    }

    const mtfTimeframes = {};
    const mtfTFs = ['1m', '5m', '15m', '1h'];
    for (const mtfTF of mtfTFs) {
      const mtfFinalized = getFinalizedCandles(candleEngine, mtfTF, 100);
      if (mtfFinalized.length >= 15) {
        const mtfConfluence = safeExecute('MTF-Confluence', () => confluenceEngine.calculate(mtfFinalized, mtfTF), { score: 50, bias: 'Neutral', confidence: 0 }, cycle);
        const mtfAtr = safeExecute('MTF-ATR', () => atrEngine.calculate(mtfTF), null, cycle);
        mtfTimeframes[mtfTF] = {
          confluence: { score: mtfConfluence.score, bias: mtfConfluence.bias, confidence: mtfConfluence.confidence },
          volatilityLevel: mtfAtr?.volatilityLevel || null,
        };
      }
    }

    const mtfResult = safeExecute('MTFConfirmation', () => mtfConfirmationEngine.evaluate({ direction, timeframe: tf, timeframes: mtfTimeframes }), { mtfAllowed: false, rejectionReason: 'MTF confirmation engine failed', confidence: 0, alignmentScore: 0 }, cycle);
    decision.mtfConfirmation = mtfResult;
    decision.gates.mtfConfirmation = {
      pass: mtfResult.mtfAllowed,
      value: mtfResult.mtfAllowed ? 'ALLOWED' : 'BLOCKED',
      detail: mtfResult.mtfAllowed ? `MTF confirmed | confidence=${mtfResult.confidence}% | alignment=${mtfResult.alignmentScore}%` : mtfResult.rejectionReason,
    };

    if (!mtfResult.mtfAllowed) {
      decision.verdict.rejectionReason = mtfResult.rejectionReason;
      lastDecision = decision;
      console.log(`  MTF Confirmation: BLOCKED — ${mtfResult.rejectionReason}`);
      console.log(`  Trade Allowed: NO`);
      console.log(`  Execution Triggered: NO`);
      console.log(divider);
      return;
    }

    const riskResult = safeExecute('AdvanceRisk', () => advanceRiskEngine.evaluate({
      symbol, timeframe: tf, entryPrice: price, atr: atr || { ready: false, atr: null, atrPercentage: 0 }, direction, trend, structure: structureResult, confluence, regime: marketRegime.regime,
      nowMs: cycle.nowMs,
    }), { tradeAllowed: false, rejectionReason: 'Advance risk engine failed', positionSize: 0, stopLoss: 0, takeProfit: 0, riskReward: 0, session: null }, cycle);
    decision.risk = riskResult;
    decision.gates.advanceRisk = { pass: riskResult.tradeAllowed, value: riskResult.tradeAllowed ? 'ALLOWED' : 'BLOCKED', detail: riskResult.tradeAllowed ? `AdvanceRisk | pos=${riskResult.positionSize} | SL=$${riskResult.stopLoss} | TP=$${riskResult.takeProfit} | R:R 1:${riskResult.riskReward}` : riskResult.rejectionReason };

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
      return;
    }

    const now = cycle.nowMs;
    if (now - lastSignalTime < 60000) {
      const waitSec = Math.ceil((60000 - (now - lastSignalTime)) / 1000);
      decision.verdict.rejectionReason = `Cooldown active — ${waitSec}s remaining (min 60s between trades)`;
      lastDecision = decision;
      console.log(`  Execution Triggered: NO`);
      console.log(`  Reason: Cooldown active — ${waitSec}s remaining (min 60s between trades)`);
      console.log(divider);
      return;
    }

    const engines = { trend, structure: structureResult, rsi: rsiResult, ema: emaResult, macd: macdResult, atr, bollinger: bollingerResult, confluence, mtf: (() => { try { return mtfEngine.calculate(500); } catch (e) { return null; } })() };
    const trade = safeExecute('PaperTrading', () => paperTradeEngine.signal(engines, price, tf, direction, riskResult, { nowMs: cycle.nowMs }), null, cycle);
    if (trade) {
      lastSignalTime = now;
      decision.verdict.tradeOpened = true;
      decision.verdict.trade = { tradeId: trade.tradeId, direction: trade.direction, entryPrice: trade.entryPrice, stopLoss: trade.stopLoss, takeProfit: trade.takeProfit, riskReward: trade.riskReward, positionSize: trade.positionSize, confidence: trade.confidence, reason: trade.reason };
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

    const openCount = paperTradeEngine.open().length;
    const closedCount = paperTradeEngine.closed().length;
    console.log(`  Portfolio: ${openCount} open | ${closedCount} closed | Balance: $${paperTradeEngine.getBalance()}`);
    console.log(divider);
  }

  return {
    run,
    getLastDecision: () => lastDecision,
    getPipelineHealth: () => ({ pipelineCycleCount, pipelineErrors, lastPipelineError, lastSuccessfulCycle }),
  };
}

module.exports = { createExecutionPipeline };
