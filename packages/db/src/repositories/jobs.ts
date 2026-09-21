import type { Queryable, Pool } from '../client.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface JobRow {
  id: string;
  workspace_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_by: string | null;
  last_error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export async function enqueueJob(
  db: Queryable,
  input: {
    workspaceId: string | null;
    type: string;
    payload?: Record<string, unknown>;
    runAfter?: Date;
    maxAttempts?: number;
  },
): Promise<JobRow> {
  const { rows } = await db.query<JobRow>(
    `INSERT INTO jobs (workspace_id, type, payload, run_after, max_attempts)
     VALUES ($1,$2,$3, COALESCE($4, now()), COALESCE($5, 3))
     RETURNING *`,
    [
      input.workspaceId,
      input.type,
      input.payload ?? {},
      input.runAfter ?? null,
      input.maxAttempts ?? null,
    ],
  );
  return rows[0];
}

/**
 * Claim queued jobs for one worker. `FOR UPDATE SKIP LOCKED` lets several
 * workers drain the same queue without double-processing.
 */
export async function claimJobs(pool: Pool, workerId: string, limit = 1): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(),
            attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2)
      RETURNING *`,
    [workerId, limit],
  );
  return rows;
}

export async function completeJob(
  db: Queryable,
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `UPDATE jobs SET status='succeeded', result=$2, finished_at=now(), updated_at=now(), locked_by=NULL
      WHERE id=$1`,
    [jobId, result],
  );
}

/**
 * Record a failure. Retries with exponential backoff until `max_attempts`,
 * then the job becomes `dead` for a human to inspect — never silently dropped.
 */
export async function failJob(db: Queryable, jobId: string, error: string): Promise<JobRow> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            last_error = $2,
            run_after = now() + make_interval(secs => least(300, power(2, attempts)::int * 5)),
            locked_by = NULL,
            updated_at = now(),
            finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
      WHERE id = $1
      RETURNING *`,
    [jobId, error.slice(0, 2000)],
  );
  return rows[0];
}

/** Job counts for one workspace. Scope is mandatory: there is no global read. */
export async function countJobsByStatus(
  db: Queryable,
  workspaceId: string,
): Promise<Record<string, number>> {
  const { rows } = await db.query<{ status: JobStatus; count: string }>(
    'SELECT status, count(*)::text AS count FROM jobs WHERE workspace_id = $1 GROUP BY status',
    [workspaceId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}
