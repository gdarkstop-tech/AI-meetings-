import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { claimJobs, completeJob, failJob, getPool, type JobRow } from '@alia/db';
import { createLogger } from '@alia/observability';

/**
 * Background worker: drains the database-backed job queue.
 *
 * Phase 1 registers NO job handlers. An unknown job type fails loudly and ends
 * up in `dead` for a human to inspect — it is never reported as succeeded.
 * Handlers arrive with the phases that need them (media normalization and
 * transcription in Phase 3, analysis in Phase 4).
 */
export type JobHandler = (job: JobRow) => Promise<Record<string, unknown>>;

export const handlers: Record<string, JobHandler> = {};

const WORKER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1000);
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 1);

const log = createLogger({
  level: (process.env.LOG_LEVEL as 'info') ?? 'info',
  base: { app: 'worker', workerId: WORKER_ID },
});

let running = true;

export async function runOnce(pool = getPool()): Promise<number> {
  const jobs = await claimJobs(pool, WORKER_ID, BATCH_SIZE);
  for (const job of jobs) {
    const handler = handlers[job.type];
    if (!handler) {
      const message = `No handler registered for job type "${job.type}"`;
      log.error('job_unhandled', { jobId: job.id, type: job.type });
      await failJob(pool, job.id, message);
      continue;
    }
    try {
      const result = await handler(job);
      await completeJob(pool, job.id, result);
      log.info('job_succeeded', { jobId: job.id, type: job.type });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = await failJob(pool, job.id, message);
      log.error('job_failed', { jobId: job.id, type: job.type, status: updated.status });
    }
  }
  return jobs.length;
}

async function loop(): Promise<void> {
  const pool = getPool();
  log.info('worker_started', { pollIntervalMs: POLL_INTERVAL_MS, registeredHandlers: Object.keys(handlers) });
  while (running) {
    try {
      const processed = await runOnce(pool);
      if (processed === 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    } catch (err) {
      log.error('worker_loop_error', { error: err instanceof Error ? err.message : String(err) });
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 5));
    }
  }
}

const stop = (signal: string) => {
  log.info('worker_shutdown', { signal });
  running = false;
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

if (process.env.WORKER_AUTOSTART !== 'false') {
  void loop();
}
