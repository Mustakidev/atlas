const express = require('express');
const cors = require('cors');
const path = require('path');

const { SingleOperatorSessionStore } = require('./auth/sessionStore');
const { createAuthRouter } = require('./routes/authRoutes');
const { createAuth, createSessionOriginGuard } = require('./middleware/auth');
const { createGlobalLimiter, createExpensiveLimiter, createConditionalExpensive, createLoginLimiter } = require('./middleware/rateLimit');
const { createRouter } = require('./routes/routes');
const { createProductionReplayRouter } = require('./routes/productionReplayRoutes');

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

function createApp({ config, logger, routes, getLastDecision, getPipelineHealth }) {
  const app = express();
  const sessionStore = new SingleOperatorSessionStore();
  const auth = createAuth(config, logger, { sessionStore });
  const sessionOriginGuard = createSessionOriginGuard(config);
  const globalLimiter = createGlobalLimiter(config, logger);
  const expensiveLimiter = createConditionalExpensive(createExpensiveLimiter(config, logger));
  const loginLimiter = createLoginLimiter(config, logger);
  const authRouter = createAuthRouter({ config, sessionStore, loginLimiter });
  const allowedOrigins = config.get('CORS_ORIGIN').split(',').map(s => s.trim());

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
    res.status(200).json({ status: 'ok' });
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
  });
  app.use('/api/auth', authRouter);
  app.use('/api', auth, sessionOriginGuard, expensiveLimiter, canonicalRouter, router);
  app.use(createErrorHandler(logger));

  return app;
}

module.exports = { createApp, createErrorHandler };
