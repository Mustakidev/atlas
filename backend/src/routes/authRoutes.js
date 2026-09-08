const express = require('express');

const { clearSessionCookie, parseSessionCookie, serializeSessionCookie } = require('../auth/cookie');
const { isSameOriginRequest } = require('../auth/origin');
const { verifyPassword } = require('../auth/password');
const { SESSION_TTL_MS } = require('../auth/sessionStore');

function invalidOrigin(res) {
  return res.status(403).json({ error: 'Forbidden', message: 'Origin not allowed' });
}

function createAuthRouter({ config, sessionStore, loginLimiter, logger = null }) {
  const origin = config.get('ATLAS_ORIGIN');
  const secure = config.get('ATLAS_COOKIE_SECURE');
  const passwordHash = config.get('ATLAS_OPERATOR_PASSWORD_HASH');
  if (typeof origin !== 'string' || typeof secure !== 'boolean' || typeof passwordHash !== 'string') {
    throw new TypeError('Authentication configuration is invalid');
  }

  const router = express.Router();

  const sourceIp = req => typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : 'unknown';
  const recordAsyncAudit = input => {
    if (!logger?.record) return;
    void Promise.resolve().then(() => logger.record(input)).catch(() => {});
  };
  const certifyCriticalAudit = async input => {
    if (!logger?.record) return true;
    try {
      const result = await logger.record(input);
      return result?.status === 'DURABLE_CRITICAL_CERTIFIED';
    } catch {
      return false;
    }
  };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', (req, res, next) => {
    if (!isSameOriginRequest(req, origin)) return invalidOrigin(res);
    return loginLimiter(req, res, async () => {
      const password = req.body && req.body.password;
      if (typeof password !== 'string'
        || password.trim().length === 0
        || Buffer.byteLength(password, 'utf8') > 1024) {
        recordAsyncAudit({
          event: 'AUTH_LOGIN_FAILED',
          source: 'AuthRoutes',
          category: 'security',
          durability: 'DURABLE_ASYNC',
          level: 'WARNING',
          message: 'Operator login rejected',
          context: { reason: 'INVALID_REQUEST', sourceIp: sourceIp(req), outcome: 'REJECTED' },
        });
        return res.status(400).json({ error: 'Invalid login request', message: 'Invalid password' });
      }

      try {
        const valid = await verifyPassword(password, passwordHash);
        if (!valid) {
          recordAsyncAudit({
            event: 'AUTH_LOGIN_FAILED',
            source: 'AuthRoutes',
            category: 'security',
            durability: 'DURABLE_ASYNC',
            level: 'WARNING',
            message: 'Operator login rejected',
            context: { reason: 'INVALID_CREDENTIALS', sourceIp: sourceIp(req), outcome: 'REJECTED' },
          });
          return res.status(401).json({ error: 'Authentication failed', message: 'Invalid credentials' });
        }

        const auditCertified = await certifyCriticalAudit({
          event: 'AUTH_LOGIN_SUCCEEDED',
          source: 'AuthRoutes',
          category: 'security',
          durability: 'DURABLE_CRITICAL',
          level: 'INFO',
          message: 'Operator login certified',
          context: { principal: 'operator', sourceIp: sourceIp(req), outcome: 'SUCCESS' },
        });
        if (!auditCertified) {
          return res.status(503).json({ error: 'Audit durability unavailable', code: 'AUDIT_UNSAFE' });
        }

        const issued = sessionStore.issue();
        res.set('Set-Cookie', serializeSessionCookie(issued.token, {
          maxAge: Math.floor(SESSION_TTL_MS / 1000),
          secure,
        }));
        return res.status(204).end();
      } catch {
        return next(new Error('Password verification failed'));
      }
    });
  });

  router.post('/logout', (req, res) => {
    if (!isSameOriginRequest(req, origin)) return invalidOrigin(res);
    const token = parseSessionCookie(req.headers.cookie);
    const session = sessionStore.lookup(token);
    sessionStore.invalidate(token);
    res.set('Set-Cookie', clearSessionCookie({ secure }));
    recordAsyncAudit({
      event: 'AUTH_LOGOUT',
      source: 'AuthRoutes',
      category: 'security',
      durability: 'DURABLE_ASYNC',
      level: 'INFO',
      message: 'Operator logout completed',
      context: {
        principal: session?.principal || 'unknown',
        sourceIp: sourceIp(req),
        outcome: 'INVALIDATED',
      },
    });
    return res.status(204).end();
  });

  router.get('/session', (req, res) => {
    const authenticated = Boolean(sessionStore.lookup(parseSessionCookie(req.headers.cookie)));
    if (!authenticated) res.set('Set-Cookie', clearSessionCookie({ secure }));
    return res.json({ authenticated });
  });

  return router;
}

module.exports = { createAuthRouter };
