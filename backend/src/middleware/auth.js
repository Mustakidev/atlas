const crypto = require('crypto');

function createAuth(config, logger) {
  const apiKey = config.get('API_KEY');

  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.trim().length === 0) {
    throw new TypeError('API_KEY must be configured before authentication middleware creation');
  }

  const keyBuffer = Buffer.from(apiKey, 'utf8');

  return (req, res, next) => {
    const provided = req.headers['x-api-key'];
    if (!provided) {
      logger.warn('Auth', 'Rejected request — missing API key', { path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Authentication required', message: 'Missing X-API-Key header' });
    }

    const providedBuffer = Buffer.from(provided, 'utf8');

    if (providedBuffer.length !== keyBuffer.length) {
      logger.warn('Auth', 'Rejected request — invalid API key', { path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Authentication required', message: 'Invalid API key' });
    }

    if (!crypto.timingSafeEqual(providedBuffer, keyBuffer)) {
      logger.warn('Auth', 'Rejected request — invalid API key', { path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Authentication required', message: 'Invalid API key' });
    }

    next();
  };
}

module.exports = { createAuth };
