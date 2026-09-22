import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { PipelineContext } from '@alia/pipeline';
import type { Config } from './config.js';
import { createLogger, type Logger } from '@alia/observability';
import { contextMiddleware } from './middleware/context.js';
import { csrfProtection, loadSession } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { systemRoutes } from './routes/system.js';
import { metricsRoutes } from './routes/metrics.js';
import { meetingRoutes } from './routes/meetings.js';
import { insightRoutes } from './routes/insights.js';
import { taskRoutes } from './routes/tasks.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { actionRoutes } from './routes/actions.js';
import { adminRoutes } from './routes/admin.js';

export interface BuildServerOptions {
  config: Config;
  pipeline: PipelineContext;
  logger?: Logger;
}

export function buildServer({ config, pipeline, logger }: BuildServerOptions): Express {
  const log = logger ?? createLogger({ level: config.LOG_LEVEL, base: { app: 'api' } });
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Security headers. A full CSP arrives with the production host decision.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Same-origin by default; the dev web origin is allowed explicitly with credentials.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === config.WEB_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,x-csrf-token,x-request-id');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  // Chunk uploads carry raw bytes and parse their own body; everything else is JSON.
  app.use((req, res, next) => {
    if (req.method === 'PUT' && /\/uploads\/[^/]+\/chunks\//.test(req.path)) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });
  app.use(contextMiddleware(pipeline, log));
  app.use(loadSession());
  app.use(csrfProtection);

  app.use(systemRoutes());
  app.use(metricsRoutes(config.METRICS_TOKEN));
  app.use('/api/v1/auth', authRoutes(config));
  app.use('/api/v1/workspaces', workspaceRoutes());
  app.use('/api/v1/meetings', meetingRoutes(config));
  app.use('/api/v1', insightRoutes());
  app.use('/api/v1/tasks', taskRoutes());
  app.use('/api/v1', intelligenceRoutes(config));
  app.use('/api/v1', actionRoutes());
  app.use('/api/v1/workspace', adminRoutes());

  // In production the API also serves the built client, so a deployment is one
  // process plus the worker. In development Vite serves the client instead.
  if (config.isProduction) {
    const clientDir = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    if (existsSync(clientDir)) {
      app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
      app.get(/^\/(?!api|health|ready|metrics).*/, (_req, res) => {
        res.sendFile(join(clientDir, 'index.html'));
      });
      log.info('serving_client', { clientDir });
    } else {
      log.warn('client_bundle_missing', { clientDir });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler(config.isProduction));

  return app;
}
