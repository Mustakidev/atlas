const { REGIME_THRESHOLDS } = require('./RegimeTypes');

const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';

class TrendStrength {
  constructor({ indicatorRegistry, logger, symbol }) {
    this.indicatorRegistry = indicatorRegistry;
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'EMAIndicator + MarketAnalyzer (consumed only)';
  }

  evaluate(candles, tf, analysis) {
    const start = Date.now();

    if (!candles || candles.length < 30) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return { score: null, reason: 'Insufficient candles', components: {} };
    }

    const components = {};

    components.emaAlignment = this._scoreEmaAlignment(candles, tf);
    components.emaSlope = this._scoreEmaSlope(candles, tf);
    components.pricePosition = this._scorePricePosition(candles, tf);
    components.htfBias = this._scoreHtfBias(analysis);

    let totalWeight = 0;
    let weightedSum = 0;
    const weights = { emaAlignment: 0.35, emaSlope: 0.25, pricePosition: 0.25, htfBias: 0.15 };

    for (const [key, comp] of Object.entries(components)) {
      if (comp.score !== null) {
        weightedSum += comp.score * weights[key];
        totalWeight += weights[key];
      }
    }

    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
    const reason = this._inferDirection(score, components);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return { score, reason, components };
  }

  _scoreEmaAlignment(candles, tf) {
    const ema = this.indicatorRegistry.get('EMA');
    if (!ema) return { score: null, reason: 'EMA indicator not registered' };

    const periods = [9, 20, 50, 100];
    const results = {};
    for (const p of periods) {
      const r = ema.calculate(candles, tf, p);
      if (r.ready) results[p] = r.value;
    }

    const keys = Object.keys(results);
    if (keys.length < 2) return { score: null, reason: 'Insufficient EMA periods ready' };

    const values = keys.map(k => results[k]);
    let alignmentScore = 50;
    let ascending = true;
    let descending = true;
    for (let i = 1; i < values.length; i++) {
      if (values[i] <= values[i - 1]) ascending = false;
      if (values[i] >= values[i - 1]) descending = false;
    }

    if (ascending) alignmentScore = 90;
    else if (descending) alignmentScore = 10;
    else alignmentScore = 50;

    if (keys.includes('9') && keys.includes('50')) {
      const short = results['9'];
      const long = results['50'];
      if (short > long) alignmentScore = Math.min(100, alignmentScore + 10);
      else if (short < long) alignmentScore = Math.max(0, alignmentScore - 10);
    }

    return {
      score: alignmentScore,
      reason: ascending ? 'Bullish alignment' : descending ? 'Bearish alignment' : 'Mixed alignment',
      periods: results,
    };
  }

  _scoreEmaSlope(candles, tf) {
    const ema = this.indicatorRegistry.get('EMA');
    if (!ema) return { score: null, reason: 'EMA indicator not registered' };

    const r = ema.calculate(candles, tf, 20);
    if (!r.ready || !r.value) return { score: null, reason: 'EMA-20 not ready' };

    const closes = candles.map(c => c.close);
    const lookback = Math.min(20, closes.length - 1);
    const currentClose = closes[closes.length - 1];
    const pastClose = closes[closes.length - 1 - lookback];
    const pctChange = pastClose > 0 ? ((currentClose - pastClose) / pastClose) * 100 : 0;

    const emaValue = r.value;
    const emaRatio = currentClose > 0 ? emaValue / currentClose : 1;

    let score = 50;
    if (pctChange > 0.5) score = 75 + Math.min(25, Math.round(pctChange * 5));
    else if (pctChange > 0.15) score = 60;
    else if (pctChange < -0.5) score = 25 - Math.min(25, Math.round(Math.abs(pctChange) * 5));
    else if (pctChange < -0.15) score = 40;
    else score = 50;

    if (emaRatio < 0.98) score = Math.max(0, score - 10);
    else if (emaRatio > 1.02) score = Math.min(100, score + 10);

    return { score: Math.max(0, Math.min(100, score)), reason: `20-period slope: ${pctChange.toFixed(2)}%`, pctChange, emaRatio };
  }

  _scorePricePosition(candles, tf) {
    const ema = this.indicatorRegistry.get('EMA');
    if (!ema) return { score: null, reason: 'EMA indicator not registered' };

    const r = ema.calculate(candles, tf, 50);
    if (!r.ready || !r.value) return { score: null, reason: 'EMA-50 not ready' };

    const lastClose = candles[candles.length - 1].close;
    const distancePct = r.value > 0 ? ((lastClose - r.value) / r.value) * 100 : 0;

    let score = 50;
    if (distancePct > 2) score = 80 + Math.min(20, Math.round(distancePct * 3));
    else if (distancePct > 0.5) score = 65;
    else if (distancePct < -2) score = 20 - Math.min(20, Math.round(Math.abs(distancePct) * 3));
    else if (distancePct < -0.5) score = 35;
    else score = 50;

    return { score: Math.max(0, Math.min(100, score)), reason: `Price ${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}% from EMA-50`, distancePct };
  }

  _scoreHtfBias(analysis) {
    if (!analysis || !analysis.trend) return { score: null, reason: 'No analysis data' };

    const htfKey = '4H';
    const htfTrend = analysis.trend[htfKey];

    if (!htfTrend) return { score: null, reason: `No ${htfKey} trend data` };

    const htfConfidence = analysis.confidence ? analysis.confidence[htfKey] || 50 : 50;

    let score = 50;
    if (htfTrend === 'Bullish') score = 60 + Math.min(40, Math.round(htfConfidence * 0.4));
    else if (htfTrend === 'Bearish') score = 40 - Math.min(40, Math.round(htfConfidence * 0.4));
    else score = 50;

    return { score: Math.max(0, Math.min(100, score)), reason: `${htfKey} trend: ${htfTrend} (conf: ${htfConfidence})` };
  }

  _inferDirection(score) {
    if (score === null) return 'Insufficient data';
    if (score >= REGIME_THRESHOLDS.TREND_BULL_MIN_SCORE) return 'Bullish trend';
    if (score <= REGIME_THRESHOLDS.TREND_BEAR_MAX_SCORE) return 'Bearish trend';
    return 'No clear trend direction';
  }

  getInfo() {
    return {
      name: 'TrendStrength',
      description: 'Evaluates trend strength using EMA alignment, slope, price position, and HTF bias',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
    };
  }
}

module.exports = { TrendStrength, ENGINE_VERSION };
