const { REGIME_THRESHOLDS } = require('./RegimeTypes');

const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';

class RangeDetector {
  constructor({ atrEngine, indicatorRegistry, candleEngine, logger, symbol }) {
    this.atrEngine = atrEngine;
    this.indicatorRegistry = indicatorRegistry;
    this.candleEngine = candleEngine;
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'ATREngine + EMAIndicator + CandleEngine (consumed only)';
  }

  evaluate(candles, tf, analysis) {
    const start = Date.now();

    if (!candles || candles.length < 30) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return { confidence: null, reason: 'Insufficient candles', components: {} };
    }

    const components = {};

    components.atrCompression = this._scoreAtrCompression(candles, tf);
    components.candleBodies = this._scoreCandleBodies(candles);
    components.emaCrosses = this._scoreEmaCrosses(candles, tf);
    components.directionalMovement = this._scoreDirectionalMovement(candles, analysis);

    let totalWeight = 0;
    let weightedSum = 0;
    const weights = { atrCompression: 0.30, candleBodies: 0.20, emaCrosses: 0.20, directionalMovement: 0.30 };

    for (const [key, comp] of Object.entries(components)) {
      if (comp.score !== null) {
        weightedSum += comp.score * weights[key];
        totalWeight += weights[key];
      }
    }

    const confidence = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return { confidence, components };
  }

  _scoreAtrCompression(candles, tf) {
    if (!this.atrEngine) return { score: null, reason: 'ATR engine not available' };

    const atrResult = this.atrEngine.calculate(tf, 200);
    if (!atrResult || !atrResult.ready) return { score: null, reason: 'ATR not ready' };

    const currentAtr = atrResult.atrPercentage;
    const lookback = Math.min(50, candles.length - 15);

    const atrValues = [];
    for (let i = candles.length - lookback; i < candles.length; i++) {
      const idx = i;
      if (idx > 0) {
        const highLow = candles[idx].high - candles[idx].low;
        const highPc = Math.abs(candles[idx].high - candles[idx - 1].close);
        const lowPc = Math.abs(candles[idx].low - candles[idx - 1].close);
        const tr = Math.max(highLow, highPc, lowPc);
        const atrPct = candles[idx].close > 0 ? (tr / candles[idx].close) * 100 : 0;
        atrValues.push(atrPct);
      }
    }

    if (atrValues.length < 10) return { score: null, reason: 'Insufficient ATR history' };

    const avgAtr = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
    const compressionRatio = avgAtr > 0 ? currentAtr / avgAtr : 1;

    let score = 50;
    if (compressionRatio < 0.7) score = 80;
    else if (compressionRatio < 0.85) score = 65;
    else if (compressionRatio < 0.95) score = 50;
    else if (compressionRatio < 1.1) score = 35;
    else score = 20;

    return { score, reason: `ATR compression ratio: ${compressionRatio.toFixed(2)}`, compressionRatio, currentAtr, avgAtr };
  }

  _scoreCandleBodies(candles) {
    const lookback = Math.min(30, candles.length - 1);
    const recent = candles.slice(-lookback);

    let totalRange = 0;
    let totalBody = 0;
    let smallBodyCount = 0;

    for (const c of recent) {
      const range = c.high - c.low;
      const body = Math.abs(c.close - c.open);
      totalRange += range;
      totalBody += body;
      if (range > 0 && body / range < 0.3) smallBodyCount++;
    }

    const avgBodyRatio = totalRange > 0 ? totalBody / totalRange : 1;
    const smallBodyPct = (smallBodyCount / recent.length) * 100;

    let score = 50;
    if (avgBodyRatio < 0.35 && smallBodyPct > 60) score = 80;
    else if (avgBodyRatio < 0.45 && smallBodyPct > 40) score = 65;
    else if (avgBodyRatio > 0.65 && smallBodyPct < 20) score = 20;
    else if (avgBodyRatio > 0.55 && smallBodyPct < 30) score = 35;

    return { score, reason: `Avg body/range: ${avgBodyRatio.toFixed(2)}, small candles: ${smallBodyPct.toFixed(0)}%`, avgBodyRatio, smallBodyPct };
  }

  _scoreEmaCrosses(candles, tf) {
    const ema = this.indicatorRegistry.get('EMA');
    if (!ema) return { score: null, reason: 'EMA indicator not registered' };

    const r = ema.calculate(candles, tf, 20);
    if (!r.ready || !r.value) return { score: null, reason: 'EMA-20 not ready' };

    const closes = candles.map(c => c.close);
    const lookback = Math.min(30, closes.length - 1);
    let crossCount = 0;
    let aboveCount = 0;
    let belowCount = 0;

    const emaValues = [];
    for (let i = 0; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const er = ema.calculate(window, tf, 20);
      emaValues.push(er.ready ? er.value : null);
    }

    for (let i = Math.max(1, candles.length - lookback); i < candles.length; i++) {
      const prevClose = closes[i - 1];
      const curClose = closes[i];
      const prevEma = emaValues[i - 1];
      const curEma = emaValues[i];
      if (prevEma === null || curEma === null) continue;

      if ((prevClose <= prevEma && curClose > curEma) || (prevClose >= prevEma && curClose < curEma)) {
        crossCount++;
      }
      if (curClose > curEma) aboveCount++;
      else belowCount++;
    }

    const crossRate = lookback > 0 ? crossCount / lookback : 0;

    let score = 50;
    if (crossRate > 0.25) score = 80;
    else if (crossRate > 0.15) score = 65;
    else if (crossRate > 0.10) score = 50;
    else if (crossRate > 0.05) score = 35;
    else score = 20;

    return { score, reason: `${crossCount} crosses in ${lookback} candles (rate: ${crossRate.toFixed(2)})`, crossCount, crossRate };
  }

  _scoreDirectionalMovement(candles, analysis) {
    const closes = candles.map(c => c.close);
    const lookback = Math.min(30, closes.length - 1);
    const recent = closes.slice(-lookback);

    let upDays = 0;
    let downDays = 0;
    let netMovement = 0;
    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i] - recent[i - 1];
      netMovement += diff;
      if (diff > 0) upDays++;
      else if (diff < 0) downDays++;
    }

    const directionality = Math.abs(upDays - downDays) / Math.max(upDays + downDays, 1);
    const netPctChange = recent[0] > 0 ? (netMovement / recent[0]) * 100 : 0;

    let score = 50;
    if (directionality < 0.2 && Math.abs(netPctChange) < 1) score = 80;
    else if (directionality < 0.3 && Math.abs(netPctChange) < 2) score = 65;
    else if (directionality > 0.6 || Math.abs(netPctChange) > 5) score = 15;
    else if (directionality > 0.4 || Math.abs(netPctChange) > 3) score = 30;

    return {
      score,
      reason: `Directionality: ${(directionality * 100).toFixed(0)}%, net: ${netPctChange.toFixed(2)}%`,
      directionality,
      netPctChange,
      upDays,
      downDays,
    };
  }

  getInfo() {
    return {
      name: 'RangeDetector',
      description: 'Detects ranging/sideways markets using ATR compression, candle bodies, EMA crosses, and directional movement',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
    };
  }
}

module.exports = { RangeDetector, ENGINE_VERSION };
