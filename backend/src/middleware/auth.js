const crypto = require('crypto');
const { clearSessionCookie, parseSessionCookie } = require('../auth/cookie');

function unauthorized(res, body) {
  res.set('Cache-Control', 'no-store');
  return res.status(401).json(body);
}

function createApiKeyResolver(config, logger) {
  const apiKey = config.get('API_KEY');

  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.trim().length === 0) {
    throw new TypeError('API_KEY must be configured before authentication middleware creation');
  }

  const keyBuffer = Buffer.from(apiKey, 'utf8');
  return req => {
    if (!Object.hasOwn(req.headers, 'x-api-key')) return null;
    const provided = req.headers['x-api-key'];
    const providedBuffer = typeof provided === 'string' ? Buffer.from(provided, 'utf8') : null;

    if (!providedBuffer || providedBuffer.length !== keyBuffer.length
      || !crypto.timingSafeEqual(providedBuffer, keyBuffer)) {
      logger.warn('Auth', 'Rejected request — invalid API key', { path: req.path, ip: req.ip });
      return false;
    }

    return { type: 'apiKey', principal: 'server' };
  };
}

function createAuth(config, logger, { sessionStore } = {}) {
  const resolveApiKey = createApiKeyResolver(config, logger);
  const secure = config.get('ATLAS_COOKIE_SECURE');

  return (req, res, next) => {
    const apiKeyResult = resolveApiKey(req);
    if (apiKeyResult === false) {
      return unauthorized(res, { error: 'Authentication required', message: 'Invalid API key' });
    }

    if (apiKeyResult) {
      req.auth = apiKeyResult;
      return next();
    }

    const session = sessionStore && sessionStore.lookup(parseSessionCookie(req.headers.cookie));
    if (!session) {
      res.set('Set-Cookie', clearSessionCookie({ secure }));
      logger.warn('Auth', 'Rejected request — authentication required', { path: req.path, ip: req.ip });
      return unauthorized(res, { error: 'Authentication required', message: 'Authentication required' });
    }

    req.auth = session;
    next();
  };
}

function createSessionOriginGuard(config) {
  const origin = config.get('ATLAS_ORIGIN');
  const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  return (req, res, next) => {
    if (req.auth?.type !== 'session' || !unsafeMethods.has(req.method)) return next();
    if (req.headers.origin !== origin) {
      return res.status(403).json({ error: 'Forbidden', message: 'Origin not allowed' });
    }
    next();
  };
}

module.exports = { createApiKeyResolver, createAuth, createSessionOriginGuard };
