import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseSecretKey } from '@alia/core';
import { closePool, DEFAULT_JOB_LEASE_MS, enqueueJob, getPool, type Pool } from '@alia/db';
import { createLogger } from '@alia/observability';
import { createProviderRegistry } from '@alia/providers';
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  HANDLERS,
  SHUTDOWN_INTERRUPT_WAIT_MS,
  WorkerLoop,
  type PipelineContext,
} from '@alia/pipeline';

/**
 * Background worker.
 *
 * Long work (transcoding, transcription, analysis, erasure, external actions)
 * happens here, never inside an HTTP request. Unknown job types fail loudly and
 * land in `dead` for a human — they are never reported as succeeded.
 *
 * It must receive SIGTERM itself to shut down gracefully, so it is started
 * directly (docker-compose.yml: `node --import tsx ...` under tini), not through
 * `npm run`: npm runs scripts via `sh -c`, which does not pass signals on.
 */
const WORKER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1000);
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 1);
const SWEEP_INTERVAL_MS = Number(process.env.WORKER_SWEEP_INTERVAL_MS ?? 60 * 60_000);

const log = createLogger({
  level: (process.env.LOG_LEVEL as 'info') ?? 'info',
  base: { app: 'worker', workerId: WORKER_ID },
});

/** A duration from the environment, or the default when unset or out of range. */
function msFromEnv(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min) return value;
  log.warn('worker_setting_invalid', { name, value: raw, usingMs: fallback });
  return fallback;
}

/**
 * Lease for running jobs (see DEFAULT_JOB_LEASE_MS). Anything shorter than 30
 * seconds is refused: a lease that short would let a healthy job be recovered
 * and run twice.
 */
const LEASE_MS = msFromEnv('WORKER_JOB_LEASE_MS', process.env.WORKER_JOB_LEASE_MS, DEFAULT_JOB_LEASE_MS, 30_000);
/** See DEFAULT_SHUTDOWN_GRACE_MS. Must stay below the container stop timeout. */
const SHUTDOWN_GRACE_MS = msFromEnv(
  'WORKER_SHUTDOWN_GRACE_MS',
  process.env.WORKER_SHUTDOWN_GRACE_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  0,
);
const RECOVERY_INTERVAL_MS = Math.min(60_000, Math.floor(LEASE_MS / 2));

export function buildContext(pool: Pool): PipelineContext {
  return {
    pool,
    registry: createProviderRegistry(process.env),
    log,
    secretsKey: parseSecretKey(process.env.SECRETS_KEY),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? null,
  };
}

/** Retention runs on a real schedule, not "whenever someone opens the app". */
async function scheduleSweeps(ctx: PipelineContext): Promise<NodeJS.Timeout> {
  const sweep = async () => {
    try {
      await enqueueJob(ctx.pool, { workspaceId: null, type: 'retention.sweep', payload: {} });
      log.info('retention_sweep_enqueued', {});
    } catch (error) {
      log.error('retention_sweep_failed', { error: String(error) });
    }
  };
  await sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

async function main(): Promise<void> {
  const ctx = buildContext(getPool());
  const worker = new WorkerLoop(ctx, {
    workerId: WORKER_ID,
    batchSize: BATCH_SIZE,
    leaseMs: LEASE_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    recoveryIntervalMs: RECOVERY_INTERVAL_MS,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
  });

  let stopping = false;
  let sweepTimer: NodeJS.Timeout | null = null;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('worker_shutdown', { signal, graceMs: SHUTDOWN_GRACE_MS });
    if (sweepTimer) clearInterval(sweepTimer);
    // A last-resort bound in case anything below hangs; the drain itself is
    // already bounded by the grace period.
    setTimeout(() => {
      log.error('worker_shutdown_timeout', {});
      process.exit(1);
    }, SHUTDOWN_GRACE_MS + SHUTDOWN_INTERRUPT_WAIT_MS + 10_000).unref();

    const outcome = await worker.shutdown();
    log.info('worker_stopped', { ...outcome });
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  log.info('worker_started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    leaseMs: LEASE_MS,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    handlers: Object.keys(HANDLERS),
    providers: ctx.registry.statuses().filter((s) => s.configured).map((s) => `${s.kind}:${s.providerId}`),
  });
  const running = worker.start();
  sweepTimer = await scheduleSweeps(ctx);
  // A shutdown that began while the first sweep was being queued must not
  // leave its timer behind.
  if (stopping) clearInterval(sweepTimer);
  await running;
}

if (process.env.WORKER_AUTOSTART !== 'false') {
  void main();
}
