const TIMEFRAMES = [
  { id: '24H', label: '24H', seconds: 86400 },
  { id: '12H', label: '12H', seconds: 43200 },
  { id: '4H', label: '4H', seconds: 14400 },
  { id: '1H', label: '1H', seconds: 3600 },
  { id: '30M', label: '30M', seconds: 1800 },
  { id: '15M', label: '15M', seconds: 900 },
  { id: '5M', label: '5M', seconds: 300 },
];

function mean(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    sum += d * d;
  }
  return Math.sqrt(sum / (arr.length - 1));
}

function linearSlope(prices) {
  const n = prices.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += prices[i];
    sumXY += i * prices[i];
    sumXX += i * i;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function computeReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  return returns;
}

function filterByWindow(snapshots, now, windowSeconds) {
  const cutoff = now - windowSeconds * 1000;
  return snapshots.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
}

class MarketAnalyzer {
  constructor(logger, symbol) {
    this.logger = logger;
    this.symbol = symbol || 'BTCUSDT';
    this.analysis = null;
  }

  analyze(history) {
    const snapshots = history.all();
    if (snapshots.length < 2) return this.analysis;

    const latest = snapshots[snapshots.length - 1];
    const now = new Date(latest.timestamp).getTime();

    const trend = {};
    const volatility = {};
    const momentum = {};
    const confidence = {};
    const dataPoints = {};

    for (const tf of TIMEFRAMES) {
      const window = filterByWindow(snapshots, now, tf.seconds);
      const prices = window.map((s) => s.price);
      dataPoints[tf.id] = prices.length;

      if (prices.length < 2) {
        trend[tf.id] = 'Sideways';
        volatility[tf.id] = 'Low';
        momentum[tf.id] = 50;
        confidence[tf.id] = 0;
        continue;
      }

      const returns = computeReturns(prices);
      const avgPrice = mean(prices);

      const slope = linearSlope(prices);
      const slopePct = avgPrice !== 0 ? (slope / avgPrice) * 100 : 0;
      const annualizer = Math.sqrt((86400 * 365) / Math.max(tf.seconds / prices.length, 1));
      const normalizedSlope = slopePct * annualizer * 0.01;

      trend[tf.id] = this._classifyTrend(normalizedSlope);

      const std = stdDev(returns);
      const annualizedVol = std * Math.sqrt((86400 * 365) / Math.max(tf.seconds / prices.length, 1));
      volatility[tf.id] = this._classifyVolatility(annualizedVol);

      momentum[tf.id] = this._computeMomentum(returns);

      confidence[tf.id] = this._computeConfidence(
        prices.length,
        tf.seconds,
        returns,
        trend[tf.id]
      );
    }

    this.analysis = {
      price: latest.price,
      volume24h: latest.volume,
      change24h: parseFloat(latest.change24h?.toFixed(2)) || 0,
      trend,
      volatility,
      momentum,
      confidence,
      dataPoints,
      timeframes: TIMEFRAMES.map((tf) => ({ id: tf.id, label: tf.label })),
      timestamp: latest.timestamp,
      analyzedAt: new Date().toISOString(),
    };

    this.logger.info('MarketAnalyzer', 'Analysis complete', {
      price: latest.price,
      trend24H: trend['24H'],
      vol24H: volatility['24H'],
      mom24H: momentum['24H'],
      conf24H: confidence['24H'],
      snapshotsUsed: snapshots.length,
    });

    return this.analysis;
  }

  _classifyTrend(normalizedSlope) {
    if (normalizedSlope > 0.15) return 'Bullish';
    if (normalizedSlope < -0.15) return 'Bearish';
    return 'Sideways';
  }

  _classifyVolatility(annualizedVol) {
    if (annualizedVol > 1.5) return 'High';
    if (annualizedVol > 0.5) return 'Medium';
    return 'Low';
  }

  _computeMomentum(returns) {
    if (returns.length === 0) return 50;

    let upSum = 0;
    let downSum = 0;
    for (let i = 0; i < returns.length; i++) {
      const abs = Math.abs(returns[i]);
      if (returns[i] > 0) upSum += abs;
      else downSum += abs;
    }

    const total = upSum + downSum;
    if (total === 0) return 50;
    return Math.round((upSum / total) * 100);
  }

  _computeConfidence(snapshotCount, windowSeconds, returns, trendDir) {
    const expectedInterval = 2;
    const expectedSnapshots = windowSeconds / expectedInterval;
    const density = Math.min(snapshotCount / Math.max(expectedSnapshots, 1), 1);

    const sampleScore = Math.min(snapshotCount / 50, 1) * 100;

    let consistencyScore = 0;
    if (returns.length >= 4) {
      const chunkSize = Math.floor(returns.length / 4);
      const dirs = [];
      for (let c = 0; c < 4; c++) {
        const start = c * chunkSize;
        const end = c === 3 ? returns.length : start + chunkSize;
        const chunk = returns.slice(start, end);
        const chunkMean = mean(chunk);
        dirs.push(chunkMean > 0 ? 1 : chunkMean < 0 ? -1 : 0);
      }

      const trendDirNum = trendDir === 'Bullish' ? 1 : trendDir === 'Bearish' ? -1 : 0;
      let agreement = 0;
      for (let i = 0; i < dirs.length; i++) {
        if (dirs[i] === trendDirNum) agreement++;
        else if (dirs[i] === 0 && trendDirNum === 0) agreement++;
      }
      consistencyScore = (agreement / dirs.length) * 100;
    }

    const raw = sampleScore * 0.4 + consistencyScore * 0.5 + density * 10 * 0.1;
    return Math.round(Math.min(Math.max(raw, 0), 100));
  }

  getAnalysis() {
    return this.analysis;
  }
}

module.exports = { MarketAnalyzer, TIMEFRAMES };
