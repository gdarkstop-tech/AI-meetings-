import { randomUUID } from 'node:crypto';
import { createPool, migrate, type Pool } from '@alia/db';

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
