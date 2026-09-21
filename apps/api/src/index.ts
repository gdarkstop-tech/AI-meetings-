import { getPool } from '@alia/db';
import { loadConfig } from './config.js';
import { createLogger } from '@alia/observability';
import { buildServer } from './server.js';

const config = loadConfig();
const log = createLogger({ level: config.LOG_LEVEL, base: { app: 'api', env: config.NODE_ENV } });
const pool = getPool(config.DATABASE_URL);
const app = buildServer({ config, pool, logger: log });

const server = app.listen(config.PORT, () => {
  log.info('api_listening', { port: config.PORT });
});

const shutdown = (signal: string) => {
  log.info('api_shutdown', { signal });
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
