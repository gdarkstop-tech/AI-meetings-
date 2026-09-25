import { withTransaction, type Queryable, type Pool } from '../client.js';

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
  locked_at: Date | null;
  last_error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

/**
 * How long a running job may go without renewing its lease before it is
 * presumed abandoned — its worker crashed, was killed mid-job, or lost the
 * database — and handed back to the queue by `recoverStaleJobs`.
 *
 * A healthy worker renews the lease every third of this period for as long as
 * the job runs, so a slow job (a long transcription) never loses its lease; only
 * a worker that has actually stopped does. The worker reads WORKER_JOB_LEASE_MS
 * to override it.
 */
export const DEFAULT_JOB_LEASE_MS = 10 * 60_000;

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

/**
 * Extend a worker's lease on a job it is running. Returns false when the worker
 * no longer owns the job — its lease expired and the job was recovered, and it
 * may already be running elsewhere. The worker must then stop and must not
 * record any outcome for it.
 */
export async function heartbeatJob(db: Queryable, jobId: string, workerId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE jobs SET locked_at = now(), updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, workerId],
  );
  return (res.rowCount ?? 0) === 1;
}

/**
 * Mark a job succeeded — only if `workerId` still holds its lease. Returns false
 * when it does not: the job was recovered after the lease expired, so this
 * worker's result is stale and is discarded rather than overwriting the state
 * of whichever run now owns the job.
 */
export async function completeJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE jobs SET status = 'succeeded', result = $3, finished_at = now(), updated_at = now(),
                     locked_by = NULL, locked_at = NULL
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, workerId, result],
  );
  return (res.rowCount ?? 0) === 1;
}

/**
 * Record a failure, only if `workerId` still holds the job's lease (null
 * otherwise, for the same reason as `completeJob`).
 *
 * Retries with exponential backoff until `max_attempts`, then the job becomes
 * `dead` for a human to inspect — never silently dropped. A `permanent` failure
 * (one retrying cannot fix, such as an unconfigured provider or an unsupported
 * language) goes to `dead` at once instead of being retried: retrying it would
 * only repeat work, and for a paid provider, repeat cost.
 */
export async function failJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  error: string,
  options: { permanent?: boolean } = {},
): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = CASE WHEN $4::boolean OR attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            last_error = $3,
            run_after = now() + make_interval(secs => least(300, power(2, attempts)::int * 5)),
            locked_by = NULL,
            locked_at = NULL,
            updated_at = now(),
            finished_at = CASE WHEN $4::boolean OR attempts >= max_attempts THEN now() ELSE NULL END
      WHERE id = $1 AND locked_by = $2 AND status = 'running'
      RETURNING *`,
    [jobId, workerId, error.slice(0, 2000), options.permanent ?? false],
  );
  return rows[0] ?? null;
}

/**
 * Give a job this worker holds back to the queue, for a worker that is shutting
 * down. Fenced like `completeJob`: false if the lease is no longer this
 * worker's.
 *
 * Only call it once nothing is executing the job — a job claimed but never
 * started, or one whose handler has already returned — or two runs could
 * overlap. `countAttempt: false` is for a job that never started; an
 * interrupted run keeps its attempt, so a job that can never finish within a
 * shutdown grace period still runs out of attempts instead of being paid for on
 * every restart.
 */
export async function releaseJob(
  db: Queryable,
  jobId: string,
  workerId: string,
  options: { countAttempt: boolean },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE jobs
        SET status = 'queued',
            locked_by = NULL,
            locked_at = NULL,
            run_after = now(),
            attempts = CASE WHEN $3::boolean THEN attempts ELSE greatest(attempts - 1, 0) END,
            updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, workerId, options.countAttempt],
  );
  return (res.rowCount ?? 0) === 1;
}

/**
 * Hand abandoned jobs back to the queue: jobs still `running` whose lease has
 * not been renewed for `leaseMs`. The attempt the job was on counts, so a job
 * that keeps killing its worker ends up `dead` rather than looping forever.
 *
 * Safe to run from several workers at once. Rows are taken with
 * `FOR UPDATE SKIP LOCKED`, so each abandoned job is recovered by exactly one
 * caller, and a row whose owner is renewing its lease at that instant is
 * skipped rather than stolen. A recovered job is then claimed through the
 * normal `claimJobs` path, so only one worker can run it.
 */
export async function recoverStaleJobs(db: Queryable, leaseMs: number): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            last_error = 'Worker stopped before finishing this job; its lease expired.',
            locked_by = NULL,
            locked_at = NULL,
            run_after = now(),
            updated_at = now(),
            finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'running'
           AND locked_at < now() - make_interval(secs => $1::double precision / 1000)
         ORDER BY id
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [leaseMs],
  );
  return rows;
}

/**
 * Enqueue the next pipeline step on behalf of `parentJobId`, at most once.
 *
 * A parent job can run more than once: after a crash its lease expires and it
 * is recovered and run again. Without this, every re-run would enqueue another
 * copy of the next step — for transcription, another paid provider call. The
 * parent's row is locked while we look, so even two overlapping runs of the
 * same parent produce a single child.
 */
export async function enqueueFollowUpJob(
  pool: Pool,
  parentJobId: string,
  input: {
    workspaceId: string | null;
    type: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
  },
): Promise<{ job: JobRow; created: boolean }> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [parentJobId]);
    const existing = await client.query<JobRow>(
      `SELECT * FROM jobs WHERE type = $1 AND payload->>'parentJobId' = $2 LIMIT 1`,
      [input.type, parentJobId],
    );
    if (existing.rows[0]) return { job: existing.rows[0], created: false };
    const job = await enqueueJob(client, {
      workspaceId: input.workspaceId,
      type: input.type,
      payload: { ...(input.payload ?? {}), parentJobId },
      maxAttempts: input.maxAttempts,
    });
    return { job, created: true };
  });
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
