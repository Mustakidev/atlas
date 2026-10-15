const rateLimit = require('express-rate-limit');

const EXPENSIVE_PATHS = [
  '/api/validation',
  '/api/backtest',
  '/api/analytics',
  '/api/strategy/replay',
];

function createGlobalLimiter(config, logger) {
  const windowMs = config.get('RATE_LIMIT_WINDOW_MS');
  const max = config.get('RATE_LIMIT_MAX_REQUESTS');

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
      logger.warn('RateLimit', 'Global rate limit exceeded', {
        path: req.originalUrl,
        ip: req.ip,
        limit: max,
        windowSec: Math.ceil(windowMs / 1000),
      });
      res.status(options.statusCode).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
  });
}

function createExpensiveLimiter(config, logger) {
  const windowMs = config.get('RATE_LIMIT_WINDOW_MS');
  const max = config.get('RATE_LIMIT_EXPENSIVE_MAX');

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
      logger.warn('RateLimit', 'Expensive endpoint rate limit exceeded', {
        path: req.originalUrl,
        ip: req.ip,
        limit: max,
        windowSec: Math.ceil(windowMs / 1000),
      });
      res.status(options.statusCode).json({
        error: 'Rate limit exceeded for expensive endpoint',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
  });
}

function createLoginLimiter(config, logger) {
  const windowMs = config.get('RATE_LIMIT_LOGIN_WINDOW_MS');
  const max = config.get('RATE_LIMIT_LOGIN_MAX_REQUESTS');

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
      logger.warn('RateLimit', 'Login rate limit exceeded', {
        path: req.originalUrl,
        ip: req.ip,
        limit: max,
        windowSec: Math.ceil(windowMs / 1000),
      });
      res.status(options.statusCode).json({
        error: 'Too many login attempts',
        message: 'Try again later',
      });
    },
  });
}

// Express routes are case-insensitive and ignore a trailing slash, so limits must
// match the same normalized form or /api/BACKTEST/ would bypass them.
function normalizeRequestPath(url) {
  const path = String(url || '').split('?')[0].toLowerCase().replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

function createConditionalExpensive(expensiveLimiter) {
  return (req, res, next) => {
    const path = normalizeRequestPath(req.originalUrl);
    if (EXPENSIVE_PATHS.some(p => path === p || path.startsWith(`${p}/`))) {
      return expensiveLimiter(req, res, next);
    }
    next();
  };
}

module.exports = {
  createGlobalLimiter,
  createExpensiveLimiter,
  createConditionalExpensive,
  createLoginLimiter,
  normalizeRequestPath,
};
