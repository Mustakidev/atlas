/**
 * Market Structure Engine
 *
 * Detects swing points (HH/HL/LH/LL), classifies market structure
 * (Bullish/Bearish/Ranging), and detects Break of Structure (BOS) events.
 *
 * Version: 1.0.0
 * Data Source: OHLCV candle data (finalized candles only)
 */
const ENGINE_VERSION = '1.0.0';
const DEFAULT_LOOKBACK = 5;
const MIN_CANDLES = 15;

class StructureEngine {
  constructor(logger, symbol) {
    this.logger = logger;
    this.symbol = symbol || 'BTCUSDT';
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'CandleEngine (finalized OHLCV candles)';
  }

  calculate(candles) {
    const start = Date.now();

    if (!candles || candles.length < MIN_CANDLES) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._notReady(candles ? candles.length : 0);
    }

    const swings = this._findSwingPoints(candles);
    if (swings.length < 2) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._buildResult('Ranging', 50, 'neutral', swings, null, candles, 20);
    }

    const classified = this._classifySwings(swings);
    const structure = this._determineStructure(classified);
    const bos = this._detectBOS(candles, classified);
    const score = this._scoreStructure(structure, classified, bos);
    const direction = structure === 'Bullish' ? 'bullish' : structure === 'Bearish' ? 'bearish' : 'neutral';
    const confidence = this._confidence(classified);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return this._buildResult(structure, score, direction, classified, bos, candles, confidence);
  }

  _findSwingPoints(candles) {
    const swings = [];
    const lookback = DEFAULT_LOOKBACK;

    for (let i = lookback; i < candles.length - lookback; i++) {
      const high = candles[i].high;
      const low = candles[i].low;

      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high >= high || candles[i + j].high >= high) {
          isSwingHigh = false;
        }
        if (candles[i - j].low <= low || candles[i + j].low <= low) {
          isSwingLow = false;
        }
      }

      if (isSwingHigh) {
        swings.push({ type: 'High', price: high, index: i, timestamp: candles[i].timestamp });
      }
      if (isSwingLow) {
        swings.push({ type: 'Low', price: low, index: i, timestamp: candles[i].timestamp });
      }
    }

    swings.sort((a, b) => a.index - b.index);
    return swings;
  }

  _classifySwings(swings) {
    if (swings.length < 2) return swings;

    const classified = [{ ...swings[0], label: swings[0].type === 'High' ? 'H' : 'L' }];

    for (let i = 1; i < swings.length; i++) {
      const curr = swings[i];
      const prev = classified[classified.length - 1];

      let label;
      if (curr.type === 'High') {
        label = curr.price > prev.price ? 'HH' : curr.price < prev.price ? 'LH' : 'EH';
      } else {
        label = curr.price > prev.price ? 'HL' : curr.price < prev.price ? 'LL' : 'EL';
      }

      classified.push({ ...curr, label });
    }

    return classified;
  }

  _determineStructure(classified) {
    const recent = classified.slice(-4);
    if (recent.length < 2) return 'Ranging';

    const labels = recent.map(s => s.label);
    const bullishLabels = ['HH', 'HL'];
    const bearishLabels = ['LH', 'LL'];

    const bullishCount = labels.filter(l => bullishLabels.includes(l)).length;
    const bearishCount = labels.filter(l => bearishLabels.includes(l)).length;

    if (bullishCount >= 2 && bullishCount > bearishCount) return 'Bullish';
    if (bearishCount >= 2 && bearishCount > bullishCount) return 'Bearish';
    return 'Ranging';
  }

  _detectBOS(candles, classified) {
    if (classified.length < 2 || !candles || candles.length === 0) return null;

    const lastCandle = candles[candles.length - 1];
    const close = lastCandle.close;

    let lastSwingHigh = null;
    let lastSwingLow = null;

    for (let i = classified.length - 1; i >= 0; i--) {
      if (classified[i].type === 'High' && !lastSwingHigh) {
        lastSwingHigh = classified[i];
      }
      if (classified[i].type === 'Low' && !lastSwingLow) {
        lastSwingLow = classified[i];
      }
      if (lastSwingHigh && lastSwingLow) break;
    }

    if (lastSwingHigh && close > lastSwingHigh.price) {
      return { type: 'Bullish', price: lastSwingHigh.price, index: lastSwingHigh.index };
    }
    if (lastSwingLow && close < lastSwingLow.price) {
      return { type: 'Bearish', price: lastSwingLow.price, index: lastSwingLow.index };
    }

    return null;
  }

  _scoreStructure(_structure, classified, bos) {
    let baseScore = 50;

    if (_structure === 'Bullish') {
      const hhCount = classified.filter(s => s.label === 'HH').length;
      const hlCount = classified.filter(s => s.label === 'HL').length;
      const strength = Math.min(hhCount + hlCount, 5);
      baseScore = 65 + strength * 4;
    } else if (_structure === 'Bearish') {
      const lhCount = classified.filter(s => s.label === 'LH').length;
      const llCount = classified.filter(s => s.label === 'LL').length;
      const strength = Math.min(lhCount + llCount, 5);
      baseScore = 35 - strength * 4;
    }

    if (bos) {
      baseScore += bos.type === 'Bullish' ? 10 : -10;
    }

    return Math.max(0, Math.min(100, baseScore));
  }

  _confidence(classified) {
    const swingCount = classified.length;
    if (swingCount < 3) return 20;
    return Math.min(100, swingCount * 15);
  }

  _buildResult(structure, score, direction, swingPoints, bos, candles, confidence) {
    return {
      implemented: true,
      ready: true,
      structure,
      score,
      direction,
      swingPoints: swingPoints.map(sp => ({
        type: sp.label,
        price: sp.price,
        index: sp.index,
        timestamp: sp.timestamp || null,
      })),
      lastBOS: bos,
      confidence,
      timestamp: candles[candles.length - 1].timestamp,
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }

  _notReady(candleCount) {
    return {
      implemented: true,
      ready: false,
      reason: `Insufficient candle data (${candleCount}/${MIN_CANDLES})`,
      structure: null,
      score: null,
      direction: null,
      swingPoints: [],
      lastBOS: null,
      confidence: null,
      timestamp: null,
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }

  getInfo() {
    return {
      name: 'Structure',
      description: 'Market structure detection — swing points, HH/HL/LH/LL classification, BOS events',
      implemented: true,
      version: this.version,
      minCandles: MIN_CANDLES,
      lookback: DEFAULT_LOOKBACK,
    };
  }
}

module.exports = { StructureEngine, ENGINE_VERSION, MIN_CANDLES, DEFAULT_LOOKBACK };
