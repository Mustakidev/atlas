const express = require('express');

const { clearSessionCookie, parseSessionCookie, serializeSessionCookie } = require('../auth/cookie');
const { isSameOriginRequest } = require('../auth/origin');
const { verifyPassword } = require('../auth/password');
const { SESSION_TTL_MS } = require('../auth/sessionStore');

function invalidOrigin(res) {
  return res.status(403).json({ error: 'Forbidden', message: 'Origin not allowed' });
}

function createAuthRouter({ config, sessionStore, loginLimiter }) {
  const origin = config.get('ATLAS_ORIGIN');
  const secure = config.get('ATLAS_COOKIE_SECURE');
  const passwordHash = config.get('ATLAS_OPERATOR_PASSWORD_HASH');
  if (typeof origin !== 'string' || typeof secure !== 'boolean' || typeof passwordHash !== 'string') {
    throw new TypeError('Authentication configuration is invalid');
  }

  const router = express.Router();
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
        return res.status(400).json({ error: 'Invalid login request', message: 'Invalid password' });
      }

      try {
        const valid = await verifyPassword(password, passwordHash);
        if (!valid) return res.status(401).json({ error: 'Authentication failed', message: 'Invalid credentials' });

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
    sessionStore.invalidate(parseSessionCookie(req.headers.cookie));
    res.set('Set-Cookie', clearSessionCookie({ secure }));
    return res.status(204).end();
  });

  router.get('/session', (req, res) => {
    const authenticated = Boolean(sessionStore.lookup(parseSessionCookie(req.headers.cookie)));
    return res.json({ authenticated });
  });

  return router;
}

module.exports = { createAuthRouter };
