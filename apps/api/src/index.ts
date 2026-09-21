import { parseSecretKey } from '@alia/core';
import { getPool } from '@alia/db';
import { createLogger } from '@alia/observability';
import { createProviderRegistry } from '@alia/providers';
import type { PipelineContext } from '@alia/pipeline';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const log = createLogger({ level: config.LOG_LEVEL, base: { app: 'api', env: config.NODE_ENV } });
const pool = getPool(config.DATABASE_URL);
const registry = createProviderRegistry(process.env);

const pipeline: PipelineContext = {
  pool,
  registry,
  log,
  secretsKey: parseSecretKey(config.SECRETS_KEY),
  publicBaseUrl: config.PUBLIC_BASE_URL ?? null,
};

const app = buildServer({ config, pipeline, logger: log });

const server = app.listen(config.PORT, () => {
  log.info('api_listening', {
    port: config.PORT,
    providers: registry.statuses().filter((s) => s.configured).map((s) => `${s.kind}:${s.providerId}`),
    unconfigured: registry.statuses().filter((s) => !s.configured).map((s) => s.kind),
  });
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
