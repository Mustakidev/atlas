const express = require('express');
const cors = require('cors');
const path = require('path');

const { SingleOperatorSessionStore } = require('./auth/sessionStore');
const { createAuthRouter } = require('./routes/authRoutes');
const { createAuth, createSessionOriginGuard } = require('./middleware/auth');
const { createGlobalLimiter, createExpensiveLimiter, createConditionalExpensive, createLoginLimiter } = require('./middleware/rateLimit');
const { createRouter } = require('./routes/routes');
const { createProductionReplayRouter } = require('./routes/productionReplayRoutes');
const { isLoopbackOrigin } = require('./auth/origin');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-elem 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'none'",
  "connect-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
].join('; ');

const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'bluetooth=()',
  'clipboard-read=()',
  'clipboard-write=()',
  'fullscreen=()',
  'display-capture=()',
  'accelerometer=()',
  'gyroscope=()',
  'magnetometer=()',
].join(', ');

function createSecurityHeaders(config) {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': PERMISSIONS_POLICY,
    });

    const origin = config.get('ATLAS_ORIGIN');
    if (typeof origin === 'string' && origin.startsWith('https://')) {
      try {
        if (!isLoopbackOrigin(origin)) res.set('Strict-Transport-Security', 'max-age=31536000');
      } catch {
        // Invalid configuration is rejected before the real app is created.
      }
    }

    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.set('Cache-Control', 'no-store');
    }

    next();
  };
}

function isMalformedJsonError(error) {
  return error instanceof SyntaxError
    && error.status === 400
    && error.statusCode === 400
    && error.type === 'entity.parse.failed';
}

function createErrorHandler(logger) {
  return function errorHandler(error, req, res, next) {
    const malformedJson = isMalformedJsonError(error);
    const status = malformedJson ? 400 : 500;
    const category = malformedJson ? 'malformed-json' : 'unhandled';

    logger.error('ErrorBoundary', 'Request error', {
      method: req.method,
      path: req.path,
      status,
      category,
    });

    if (res.headersSent) return next(error);

    return res.status(status).json({
      error: malformedJson ? 'Invalid JSON payload' : 'Internal server error',
    });
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function createNotFoundHandler() {
  return function notFoundHandler(req, res) {
    return res.status(404).type('html').send(
      `Cannot ${escapeHtml(req.method)} ${escapeHtml(req.originalUrl)}`,
    );
  };
}

function classifyLifecycleRequest(req) {
  if (req.path === '/healthz') return 'health';
  if (req.path === '/readyz') return 'health';
  if (req.path === '/api/status') return 'status';
  if (req.path === '/api/signal/inspector') return 'inspector';
  if (req.method === 'GET' && !req.path.startsWith('/api')) return 'static';
  return 'unsafe';
}

function shuttingDownResponse(res) {
  return res.status(503).json({ error: 'Server shutting down' });
}

function createApp({ config, logger, routes, getLastDecision, getPipelineHealth, lifecycle, liveRuntime }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createSecurityHeaders(config));
  const sessionStore = new SingleOperatorSessionStore();
  const auth = createAuth(config, logger, { sessionStore });
  const sessionOriginGuard = createSessionOriginGuard(config);
  const globalLimiter = createGlobalLimiter(config, logger);
  const expensiveLimiter = createConditionalExpensive(createExpensiveLimiter(config, logger));
  const loginLimiter = createLoginLimiter(config, logger);
  const authRouter = createAuthRouter({ config, sessionStore, loginLimiter });
  const allowedOrigins = config.get('CORS_ORIGIN').split(',').map(s => s.trim());

  if (lifecycle) {
    app.use((req, res, next) => {
      const admission = lifecycle.trackRequest(req, res, classifyLifecycleRequest(req));
      if (!admission.allowed) {
        admission.release();
        return shuttingDownResponse(res);
      }
      next();
    });
  }

  app.use('/api/auth', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn('CORS', 'Blocked request from unauthorized origin', { origin });
        callback(null, false);
      }
    },
  }));
  app.use(express.json({ limit: config.get('MAX_BODY_SIZE') }));
  app.use(globalLimiter);

  app.get('/healthz', (req, res) => {
    if (lifecycle && lifecycle.getState() !== 'RUNNING') {
      const state = lifecycle.getState();
      return res.status(503).json({
        status: state.toLowerCase(),
        lifecycle: state,
      });
    }
    res.status(200).json({ status: 'ok' });
  });

  app.get('/readyz', (req, res) => {
    const status = liveRuntime?.getStatus?.();
    const lifecycleRunning = lifecycle?.getState?.() === 'RUNNING';
    if (lifecycleRunning && status?.effectiveState === 'READY' && status.durabilityHealthy === true) {
      return res.status(200).json({
        status: 'ok',
        liveState: 'READY',
        durabilityHealthy: true,
      });
    }
    return res.status(503).json({
      status: 'not_ready',
      liveState: status?.effectiveState || 'STARTING',
    });
  });

  // Serve the frontend without interpolating server credentials.
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/index.html'));
  });

  // Static files (CSS, JS, images) — index:false avoids serving index.html for /
  app.use(express.static(path.join(__dirname, '../../frontend'), { index: false }));

  const router = createRouter({
    ...routes,
    getLastDecision,
    getPipelineHealth,
  });
  const canonicalRouter = createProductionReplayRouter({
    application: routes.productionReplayApplication,
    logger,
    lifecycle,
  });
  app.use('/api/auth', authRouter);
  app.use('/api', auth, sessionOriginGuard, expensiveLimiter, canonicalRouter, router);
  app.use(createNotFoundHandler());
  app.use(createErrorHandler(logger));

  return app;
}

module.exports = { createApp, createErrorHandler };
