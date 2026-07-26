const ENGINE_VERSION = '1.0.0';
const MIN_TIMEFRAMES = 3;
const MIN_CONFIDENCE = 30;

const TIMEFRAMES_ORDERED = ['1m', '5m', '15m', '1h'];

class MTFConfirmationEngine {
  constructor({ logger, symbol, config }) {
    this.logger = logger;
    this.config = config;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.symbol = symbol || 'BTCUSDT';
    this._aggressive = false;
  }

  evaluate(params) {
    const start = Date.now();
    const { direction, timeframe, aggressive, timeframes } = params || {};
    // Omitted mode preserves the legacy setter configuration; explicit values
    // apply only to this evaluation and never update that configuration.
    const effectiveAggressive = aggressive === undefined ? this._aggressive : aggressive === true;

    const result = {
      mtfAllowed: false,
      rejectionReason: null,
      symbol: this.symbol,
      timeframe: timeframe || null,
      direction: direction || null,
      timeframes: {},
      alignment: {},
      confidence: 0,
      aggressive: effectiveAggressive,
      blockedBy: [],
      confirmedBy: [],
      alignmentScore: 0,
      missingTimeframes: [],
      timestamp: new Date().toISOString(),
      engineVersion: this.version,
      lastUpdated: null,
      calculationTime: 0,
    };

    if (!direction || !['BUY', 'SELL'].includes(direction)) {
      result.rejectionReason = 'No direction provided';
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return result;
    }

    const frameData = timeframes || {};
    const availableTFs = TIMEFRAMES_ORDERED.filter(tf => frameData[tf] && frameData[tf].confluence);
    result.timeframes = frameData;

    if (availableTFs.length < MIN_TIMEFRAMES) {
      result.rejectionReason = `Insufficient timeframe data: ${availableTFs.length}/${MIN_TIMEFRAMES} minimum`;
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return result;
    }

    // Determine trend per timeframe
    const trends = {};
    for (const tf of TIMEFRAMES_ORDERED) {
      trends[tf] = this._determineTrend(frameData[tf]);
    }
    result.alignment = trends;

    // Compute confidence
    result.confidence = this._computeConfidence(frameData, availableTFs, trends);

    // Evaluate alignment rules
    const verdict = this._evaluateAlignment(direction, trends, effectiveAggressive);
    result.mtfAllowed = verdict.allowed;
    result.rejectionReason = !verdict.allowed ? `MTF Confirmation: blocked by ${verdict.blockedBy.join('; ')}` : null;
    result.blockedBy = verdict.blockedBy;
    result.confirmedBy = verdict.confirmedBy;
    result.alignmentScore = verdict.alignmentScore;

    const allMissing = TIMEFRAMES_ORDERED.filter(tf => !frameData[tf] || !frameData[tf].confluence);
    result.missingTimeframes = allMissing;

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();
    return result;
  }

  _determineTrend(tfData) {
    if (!tfData || !tfData.confluence) return 'Ranging';
    const { bias, score, confidence } = tfData.confluence;
    const volLevel = tfData.volatilityLevel || '';
    if (volLevel.toUpperCase() === 'HIGH') return 'High Volatility';
    if (bias === 'Bullish' && score >= 60) return 'Bullish';
    if (bias === 'Bearish' && score <= 40) return 'Bearish';
    return 'Ranging';
  }

  _computeConfidence(frameData, availableTFs, trends) {
    let totalConf = 0;
    let count = 0;
    for (const tf of availableTFs) {
      const c = frameData[tf].confluence.confidence;
      if (c) { totalConf += c; count++; }
    }
    if (count === 0) return 0;
    const avg = totalConf / count;

    // Penalize disagreements
    const dirs = availableTFs.map(tf => trends[tf]);
    const counts = {};
    let maxCount = 0;
    for (const d of dirs) {
      counts[d] = (counts[d] || 0) + 1;
      if (counts[d] > maxCount) maxCount = counts[d];
    }
    const disagreementPenalty = 1 - (maxCount / dirs.length);

    const raw = avg * (1 - disagreementPenalty * 0.5);
    return Math.round(Math.max(0, Math.min(100, raw)));
  }

  _evaluateAlignment(direction, trends, aggressive) {
    const isBuy = direction === 'BUY';
    const targetDir = isBuy ? 'Bullish' : 'Bearish';
    const oppDir = isBuy ? 'Bearish' : 'Bullish';

    const t1m = trends['1m'] || 'Ranging';
    const t5m = trends['5m'] || 'Ranging';
    const t15m = trends['15m'] || 'Ranging';
    const t1h = trends['1h'] || 'Ranging';

    const confirmedBy = [];
    const blockedBy = [];

    // BUY: 15m bullish AND 1h bullish AND 5m not bearish AND 1m confirms
    // SELL: 15m bearish AND 1h bearish AND 5m not bullish AND 1m confirms
    const check15m = (isBuy && t15m === 'Bullish') || (!isBuy && t15m === 'Bearish');
    const check1h = (isBuy && t1h === 'Bullish') || (!isBuy && t1h === 'Bearish');
    const check5m = (isBuy && t5m !== oppDir) || (!isBuy && t5m !== oppDir);
    const check1m = (isBuy && t1m !== oppDir) || (!isBuy && t1m !== oppDir);

    if (check15m) { confirmedBy.push(`15m=${t15m}`); } else { blockedBy.push(`15m=${t15m}`); }
    if (check1h) { confirmedBy.push(`1h=${t1h}`); } else { blockedBy.push(`1h=${t1h}`); }
    if (check5m) { confirmedBy.push(`5m=${t5m}`); } else { blockedBy.push(`5m=${t5m} (must not be ${oppDir})`); }
    if (check1m) { confirmedBy.push(`1m=${t1m}`); } else { blockedBy.push(`1m=${t1m} (does not confirm)`); }

    // Aggressive mode: allow if only 5m or 1m oppose, but both HTFs agree
    if (aggressive && blockedBy.length > 0) {
      const htfOk = check15m && check1h;
      const onlyLowerBlock = blockedBy.every(b =>
        b.startsWith('1m=') || b.startsWith('5m=')
      );
      if (htfOk && onlyLowerBlock) {
        return {
          allowed: true,
          blockedBy: [],
          confirmedBy,
          alignmentScore: 100,
        };
      }
      // If both 15m and 1h oppose direction, block even in aggressive mode
      if (!check15m && !check1h) {
        return {
          allowed: false,
          blockedBy: [`15m=${t15m}`, `1h=${t1h}`],
          confirmedBy,
          alignmentScore: 0,
        };
      }
    }

    const totalChecks = 4;
    const passedChecks = confirmedBy.length;
    const alignmentScore = Math.round((passedChecks / totalChecks) * 100);
    const allowed = blockedBy.length === 0;

    return { allowed, blockedBy, confirmedBy, alignmentScore };
  }

  getInfo() {
    return {
      name: 'MTFConfirmation',
      description: 'Multi-Timeframe Confirmation Engine — validates trades across 1m/5m/15m/1h',
      version: this.version,
      symbol: this.symbol,
      timeframes: TIMEFRAMES_ORDERED,
      rules: { buy: '15m Bullish AND 1h Bullish AND 5m not Bearish AND 1m confirms', sell: '15m Bearish AND 1h Bearish AND 5m not Bullish AND 1m confirms' },
    };
  }

  setAggressive(val) { this._aggressive = val === true; }
  enableAggressive() { this._aggressive = true; }
  disableAggressive() { this._aggressive = false; }
  isAggressive() { return this._aggressive; }
}

module.exports = { MTFConfirmationEngine, ENGINE_VERSION };
