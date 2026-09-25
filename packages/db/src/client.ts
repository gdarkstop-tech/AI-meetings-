import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString: string;
  max?: number;
}

export function createPool(config: DbConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    application_name: 'alia-meetings',
  });
}

/** Process-wide pool for the API and worker. Tests create their own. */
export function getPool(connectionString?: string): pg.Pool {
  if (pool) return pool;
  const cs = connectionString ?? process.env.DATABASE_URL;
  if (!cs) {
    throw new Error('DATABASE_URL is not set. Copy .env.example and configure it.');
  }
  pool = createPool({ connectionString: cs });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  p: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Liveness probe for readiness checks. Keeps SQL inside the db package. */
export async function pingDatabase(p: pg.Pool): Promise<boolean> {
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export type ExclusiveOutcome<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Run `fn` while holding an exclusive lock named `key`, or return
 * `{ acquired: false }` at once if another holder has it — never waits.
 *
 * The lock is a PostgreSQL session-level advisory lock on a connection kept for
 * the duration, so it works across API instances and is released even if the
 * process dies (the connection closes). If the explicit unlock fails, the
 * connection is destroyed rather than returned to the pool still holding it.
 */
export async function withExclusiveLock<T>(
  p: pg.Pool,
  key: string,
  fn: () => Promise<T>,
): Promise<ExclusiveOutcome<T>> {
  const client = await p.connect();
  let acquired = false;
  let destroy = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [key],
    );
    acquired = rows[0]?.ok === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await fn() };
  } finally {
    if (acquired) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {
        destroy = true;
      });
    }
    client.release(destroy);
  }
}
