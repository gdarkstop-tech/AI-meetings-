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
