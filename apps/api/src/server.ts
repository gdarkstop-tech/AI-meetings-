import express, { type Express } from 'express';
import type { Pool } from '@alia/db';
import type { Config } from './config.js';
import { createLogger, type Logger } from '@alia/observability';
import { contextMiddleware } from './middleware/context.js';
import { csrfProtection, loadSession } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { systemRoutes } from './routes/system.js';

export interface BuildServerOptions {
  config: Config;
  pool: Pool;
  logger?: Logger;
}

export function buildServer({ config, pool, logger }: BuildServerOptions): Express {
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

  app.use(express.json({ limit: '100kb' }));
  app.use(contextMiddleware(pool, log));
  app.use(loadSession());
  app.use(csrfProtection);

  app.use(systemRoutes());
  app.use('/api/v1/auth', authRoutes(config));
  app.use('/api/v1/workspaces', workspaceRoutes());

  app.use(notFoundHandler);
  app.use(errorHandler(config.isProduction));

  return app;
}
