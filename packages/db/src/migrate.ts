import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export interface AppliedMigration {
  version: string;
  checksum: string;
  appliedAt: Date;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function listMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Apply pending migrations in order, each in its own transaction.
 * A migration whose checksum changed after being applied is a hard error:
 * silent schema drift is not allowed.
 */
export async function migrate(pool: Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  await ensureMigrationsTable(pool);
  const applied = new Map<string, string>();
  const { rows } = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  for (const row of rows) applied.set(row.version, row.checksum);

  const files = await listMigrationFiles();
  const newlyApplied: string[] = [];

  for (const file of files) {
    const version = path.basename(file, '.sql');
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(version);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${version} changed after it was applied (checksum mismatch). ` +
            'Create a new migration instead of editing an applied one.',
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        version,
        checksum,
      ]);
      await client.query('COMMIT');
      log(`applied ${version}`);
      newlyApplied.push(version);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${version} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

export const REQUIRED_EXTENSIONS = ['pg_trgm', 'unaccent', 'vector'] as const;

export interface ExtensionStatus {
  name: string;
  installed: boolean;
  version: string | null;
  available: boolean;
}

/** Honest report of extension state; never assumes, always queries. */
export async function checkExtensions(pool: Pool): Promise<ExtensionStatus[]> {
  const { rows } = await pool.query<{ name: string; installed_version: string | null; default_version: string }>(
    `SELECT name, installed_version, default_version FROM pg_available_extensions WHERE name = ANY($1)`,
    [REQUIRED_EXTENSIONS as unknown as string[]],
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  return REQUIRED_EXTENSIONS.map((name) => {
    const row = byName.get(name);
    return {
      name,
      available: Boolean(row),
      installed: Boolean(row?.installed_version),
      version: row?.installed_version ?? null,
    };
  });
}
