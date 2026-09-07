const VALID_DIRECTIONS = ['BUY', 'SELL'];
const VALID_LOG_LEVELS = ['SYSTEM', 'ERROR', 'WARNING', 'SUCCESS', 'INFO'];

function clampInt(val, min, max, fallback) {
  const n = parseInt(val);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeQuery(req, res, next) {
  const q = req.query;

  if (q.timeframe) {
    q.timeframe = String(q.timeframe).toLowerCase();
  }

  if (q.limit !== undefined) {
    q.limit = String(clampInt(q.limit, 1, 5000, 100));
  }

  const intParams = ['predictionCandles', 'warmupCandles', 'minSignalConfidence', 'period'];
  for (const key of intParams) {
    if (q[key] !== undefined) {
      q[key] = String(clampInt(q[key], 0, 10000, 0));
    }
  }

  if (q.direction !== undefined) {
    const d = String(q.direction).toUpperCase();
    if (!VALID_DIRECTIONS.includes(d)) {
      return res.status(400).json({ error: 'direction must be BUY or SELL' });
    }
    q.direction = d;
  }

  if (q.entryPrice !== undefined) {
    const v = parseFloat(q.entryPrice);
    if (isNaN(v) || v <= 0) {
      return res.status(400).json({ error: 'entryPrice must be a positive number' });
    }
    q.entryPrice = String(v);
  }

  if (q.level !== undefined) {
    const l = String(q.level).toUpperCase();
    if (!VALID_LOG_LEVELS.includes(l)) {
      return res.status(400).json({ error: `Invalid log level. Valid: ${VALID_LOG_LEVELS.join(', ')}` });
    }
    q.level = l;
  }

  if (q.regime !== undefined) {
    q.regime = String(q.regime).toUpperCase();
  }

  next();
}

module.exports = { sanitizeQuery };
