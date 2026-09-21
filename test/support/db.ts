import { randomUUID } from 'node:crypto';
import { parseSecretKey } from '@alia/core';
import { createPool, migrate, type Pool } from '@alia/db';
import { createLogger } from '@alia/observability';
import { createProviderRegistry, type Env } from '@alia/providers';
import type { PipelineContext } from '@alia/pipeline';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** Integration tests require a real PostgreSQL. They never fall back to a fake. */
export const hasTestDatabase = Boolean(TEST_DATABASE_URL);

export async function setupTestDatabase(): Promise<Pool> {
  if (!TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 5 });
  await migrate(pool);
  return pool;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

export const TEST_PASSWORD = 'phase-one-password-2026';

/** 32 zero-free bytes, base64: test-only encryption key, never a production value. */
export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * Build a pipeline context for tests. Providers are configured only when the
 * test passes env for them; otherwise every provider genuinely reports
 * NOT_CONFIGURED, exactly as in production with no keys.
 */
export function buildTestPipeline(pool: Pool, env: Env = {}): PipelineContext {
  return {
    pool,
    registry: createProviderRegistry(env),
    log: createLogger({ level: 'error', write: () => {} }),
    secretsKey: parseSecretKey(TEST_SECRETS_KEY),
    publicBaseUrl: 'https://test.local',
  };
}
