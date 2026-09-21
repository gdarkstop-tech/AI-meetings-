import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseSecretKey } from '@alia/core';
import { claimJobs, completeJob, enqueueJob, failJob, getPool, type JobRow, type Pool } from '@alia/db';
import { createLogger } from '@alia/observability';
import { createProviderRegistry } from '@alia/providers';
import { HANDLERS, type PipelineContext } from '@alia/pipeline';

/**
 * Background worker.
 *
 * Long work (transcoding, transcription, analysis, erasure, external actions)
 * happens here, never inside an HTTP request. Unknown job types fail loudly and
 * land in `dead` for a human — they are never reported as succeeded.
 */
const WORKER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1000);
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 1);
const SWEEP_INTERVAL_MS = Number(process.env.WORKER_SWEEP_INTERVAL_MS ?? 60 * 60_000);

const log = createLogger({
  level: (process.env.LOG_LEVEL as 'info') ?? 'info',
  base: { app: 'worker', workerId: WORKER_ID },
});

export function buildContext(pool: Pool): PipelineContext {
  return {
    pool,
    registry: createProviderRegistry(process.env),
    log,
    secretsKey: parseSecretKey(process.env.SECRETS_KEY),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? null,
  };
}

export async function runOnce(ctx: PipelineContext): Promise<number> {
  const jobs: JobRow[] = await claimJobs(ctx.pool, WORKER_ID, BATCH_SIZE);
  for (const job of jobs) {
    const handler = HANDLERS[job.type];
    if (!handler) {
      log.error('job_unhandled', { jobId: job.id, type: job.type });
      await failJob(ctx.pool, job.id, `No handler registered for job type "${job.type}"`);
      continue;
    }
    const started = Date.now();
    try {
      const result = await handler(ctx, job);
      await completeJob(ctx.pool, job.id, result);
      log.info('job_succeeded', { jobId: job.id, type: job.type, ms: Date.now() - started });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await failJob(ctx.pool, job.id, message);
      log.error('job_failed', {
        jobId: job.id,
        type: job.type,
        status: updated?.status,
        attempts: updated?.attempts,
        reason: message.slice(0, 300),
      });
    }
  }
  return jobs.length;
}

/** Retention runs on a real schedule, not "whenever someone opens the app". */
async function scheduleSweeps(ctx: PipelineContext): Promise<void> {
  const sweep = async () => {
    try {
      await enqueueJob(ctx.pool, { workspaceId: null, type: 'retention.sweep', payload: {} });
      log.info('retention_sweep_enqueued', {});
    } catch (error) {
      log.error('retention_sweep_failed', { error: String(error) });
    }
  };
  await sweep();
  setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref();
}

let running = true;

async function loop(): Promise<void> {
  const ctx = buildContext(getPool());
  log.info('worker_started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    handlers: Object.keys(HANDLERS),
    providers: ctx.registry.statuses().filter((s) => s.configured).map((s) => `${s.kind}:${s.providerId}`),
  });
  await scheduleSweeps(ctx);
  while (running) {
    try {
      const processed = await runOnce(ctx);
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      log.error('worker_loop_error', { error: error instanceof Error ? error.message : String(error) });
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 5));
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
