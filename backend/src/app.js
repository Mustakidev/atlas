const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { createAuth } = require('./middleware/auth');
const { createGlobalLimiter, createExpensiveLimiter, createConditionalExpensive } = require('./middleware/rateLimit');
const { createRouter } = require('./routes/routes');

function createApp({ config, logger, routes, getLastDecision, getPipelineHealth }) {
  const app = express();
  const auth = createAuth(config, logger);
  const globalLimiter = createGlobalLimiter(config, logger);
  const expensiveLimiter = createConditionalExpensive(createExpensiveLimiter(config, logger));
  const allowedOrigins = config.get('CORS_ORIGIN').split(',').map(s => s.trim());

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

  // Serve index.html with injected API key (must be before static middleware)
  app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, '../../frontend/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const apiKey = config.get('API_KEY');
    const injected = html.replace('<head>', '<head>\n  <script>window.__ATLAS_API_KEY="' + apiKey + '";</script>');
    res.type('html').send(injected);
  });

  // Static files (CSS, JS, images) — index:false avoids serving index.html for /
  app.use(express.static(path.join(__dirname, '../../frontend'), { index: false }));

  const router = createRouter({
    ...routes,
    getLastDecision,
    getPipelineHealth,
  });
  app.use('/api', expensiveLimiter, auth, router);

  return app;
}

module.exports = { createApp };
