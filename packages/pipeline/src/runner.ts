import {
  claimJobs,
  completeJob,
  failJob,
  failMeetingPipeline,
  heartbeatJob,
  isMeetingPipelineJob,
  recoverStaleJobs,
  releaseJob,
  withTransaction,
  type JobRow,
} from '@alia/db';
import type { PipelineContext } from './context.js';
import { describePipelineFailure, isPermanentFailure } from './failures.js';
import { HANDLERS, type JobHandler } from './jobs.js';

export interface RunnerOptions {
  workerId: string;
  batchSize: number;
  /** Lease length; see DEFAULT_JOB_LEASE_MS in @alia/db. */
  leaseMs: number;
  /** How often a running job renews its lease. Defaults to a third of the lease. */
  heartbeatMs?: number;
}

/**
 * How long a worker that has been asked to stop lets its current job keep
 * running before interrupting it. Long enough for a typical transcription to
 * finish rather than be paid for twice; the worker's container stop timeout
 * must be longer than this (docker-compose.yml `stop_grace_period`). Override
 * with WORKER_SHUTDOWN_GRACE_MS.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 120_000;

/**
 * After the grace period the job is interrupted; this is how long its handler
 * then gets to return. If it does, the job goes straight back to the queue. If
 * it does not, the job is left alone — still leased to this worker, so no other
 * worker can start it — and is recovered once the lease expires.
 */
export const SHUTDOWN_INTERRUPT_WAIT_MS = 5_000;

/** What became of one claimed job. */
export type JobOutcome = 'succeeded' | 'failed' | 'released' | 'discarded';

/**
 * Claim and run up to `batchSize` queued jobs. Returns how many were claimed.
 *
 * While a job runs its lease is renewed on a timer. If a renewal finds the job
 * no longer ours — the lease expired and it was recovered — the handler's
 * signal is aborted and whatever this run produces is discarded: completion and
 * failure are both fenced on still holding the lease, so a stale run can never
 * overwrite the outcome of the run that now owns the job.
 */
export async function runOnce(
  ctx: PipelineContext,
  options: RunnerOptions,
  handlers: Record<string, JobHandler> = HANDLERS,
): Promise<number> {
  const jobs = await claimJobs(ctx.pool, options.workerId, options.batchSize);
  for (const job of jobs) await runClaimedJob(ctx, options, job, handlers);
  return jobs.length;
}

/**
 * Run one job this worker has already claimed (see `runOnce`).
 *
 * `shutdownSignal` interrupts the job because the worker is stopping, not
 * because the job did anything wrong: once its handler has returned, the job
 * is released back to the queue instead of being recorded as a failure.
 */
export async function runClaimedJob(
  ctx: PipelineContext,
  options: RunnerOptions,
  job: JobRow,
  handlers: Record<string, JobHandler> = HANDLERS,
  shutdownSignal?: AbortSignal,
): Promise<JobOutcome> {
  const handler = handlers[job.type];
  if (!handler) {
    ctx.log.error('job_unhandled', { jobId: job.id, type: job.type });
    return recordFailure(ctx, options, job, new Error(`No handler registered for job type "${job.type}"`), true);
  }

  const controller = new AbortController();
  const onShutdown = () => controller.abort(new Error('The worker is shutting down.'));
  if (shutdownSignal?.aborted) onShutdown();
  else shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

  let leaseLost = false;
  // Set before this run records its outcome, so a renewal still in flight then
  // (which finds the job no longer running) is not mistaken for a lost lease.
  let finished = false;
  // The lease is renewed for as long as the handler runs — including while the
  // worker is draining for shutdown — so no other worker can take the job over.
  const heartbeat = setInterval(
    () => {
      heartbeatJob(ctx.pool, job.id, options.workerId)
        .then((owned) => {
          if (owned || leaseLost || finished) return;
          leaseLost = true;
          ctx.log.warn('job_lease_lost', { jobId: job.id, type: job.type });
          controller.abort(new Error('The job lease was lost; another run owns this job now.'));
        })
        .catch((error: unknown) => {
          // A failed renewal is not a lost lease; the next tick tries again.
          ctx.log.warn('job_heartbeat_failed', {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    options.heartbeatMs ?? Math.floor(options.leaseMs / 3),
  );
  heartbeat.unref();

  const started = Date.now();
  try {
    const result = await handler(ctx, job, { signal: controller.signal });
    finished = true;
    clearInterval(heartbeat);
    if (!(await completeJob(ctx.pool, job.id, options.workerId, result))) {
      ctx.log.warn('job_result_discarded', { jobId: job.id, type: job.type, reason: 'lease_lost' });
      return 'discarded';
    }
    ctx.log.info('job_succeeded', { jobId: job.id, type: job.type, ms: Date.now() - started });
    return 'succeeded';
  } catch (error) {
    finished = true;
    clearInterval(heartbeat);
    if (shutdownSignal?.aborted && !leaseLost) {
      // Interrupted for shutdown. The handler has returned, so nothing is
      // executing this job any more and it can go straight back to the queue.
      const released = await releaseJob(ctx.pool, job.id, options.workerId, { countAttempt: true });
      ctx.log.warn(released ? 'job_released_for_shutdown' : 'job_result_discarded', {
        jobId: job.id,
        type: job.type,
        ...(released ? {} : { reason: 'lease_lost' }),
      });
      return released ? 'released' : 'discarded';
    }
    return recordFailure(ctx, options, job, error, isPermanentFailure(error));
  } finally {
    shutdownSignal?.removeEventListener('abort', onShutdown);
  }
}

/**
 * Record a failed attempt and, when that was the job's last chance, mark its
 * meeting failed — in one transaction, so a job is never dead while its meeting
 * still claims to be processing.
 */
async function recordFailure(
  ctx: PipelineContext,
  options: RunnerOptions,
  job: JobRow,
  error: unknown,
  permanent: boolean,
): Promise<JobOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  const outcome = await withTransaction(ctx.pool, async (client) => {
    const updated = await failJob(client, job.id, options.workerId, message, { permanent });
    if (!updated) return null;
    let meetingFailed = false;
    if (updated.status === 'dead' && isMeetingPipelineJob(updated)) {
      const failure = describePipelineFailure(updated.type, error);
      meetingFailed = await failMeetingPipeline(client, {
        meetingId: String(updated.payload.meetingId),
        failureCode: failure.code,
        failureReason: failure.reason,
      });
    }
    return { updated, meetingFailed };
  });

  if (!outcome) {
    ctx.log.warn('job_result_discarded', { jobId: job.id, type: job.type, reason: 'lease_lost' });
    return 'discarded';
  }
  ctx.log.error('job_failed', {
    jobId: job.id,
    type: job.type,
    status: outcome.updated.status,
    attempts: outcome.updated.attempts,
    permanent,
    meetingFailed: outcome.meetingFailed,
    reason: message.slice(0, 300),
  });
  return 'failed';
}

/**
 * Return abandoned jobs (lease expired) to the queue. A recovered job that has
 * used its last attempt is dead instead, and its meeting is marked failed in the
 * same transaction. Safe to run concurrently from every worker.
 */
export async function recoverAbandonedJobs(ctx: PipelineContext, leaseMs: number): Promise<JobRow[]> {
  const recovered = await withTransaction(ctx.pool, async (client) => {
    const rows = await recoverStaleJobs(client, leaseMs);
    for (const job of rows) {
      if (job.status !== 'dead' || !isMeetingPipelineJob(job)) continue;
      const failure = describePipelineFailure(job.type, undefined, { interrupted: true });
      await failMeetingPipeline(client, {
        meetingId: String(job.payload.meetingId),
        failureCode: failure.code,
        failureReason: failure.reason,
      });
    }
    return rows;
  });
  for (const job of recovered) {
    ctx.log.warn('job_recovered', { jobId: job.id, type: job.type, status: job.status, attempts: job.attempts });
  }
  return recovered;
}

export interface WorkerLoopOptions extends RunnerOptions {
  pollIntervalMs: number;
  /** How often abandoned jobs are recovered while running. */
  recoveryIntervalMs: number;
  /** See DEFAULT_SHUTDOWN_GRACE_MS. */
  shutdownGraceMs: number;
  /** See SHUTDOWN_INTERRUPT_WAIT_MS. */
  interruptWaitMs?: number;
  handlers?: Record<string, JobHandler>;
  /** Seams for tests; default to the real queue. */
  claim?: (limit: number) => Promise<JobRow[]>;
  recover?: () => Promise<unknown>;
}

export interface ShutdownOutcome {
  /** True when nothing was left running: the worker can exit cleanly. */
  drained: boolean;
  /** The job that was still running when the grace period ran out, if any. */
  interruptedJobId: string | null;
  /** What became of that job, when its handler returned in time. */
  interruptedOutcome: JobOutcome | null;
}

/**
 * The worker's main loop: recover abandoned jobs, claim, run, repeat — and stop
 * cleanly.
 *
 * `shutdown()` stops claiming and recovering at once, then lets the job that is
 * running finish, for up to the grace period, with its lease still renewed. If
 * the grace period runs out the job is interrupted, and released back to the
 * queue only once its handler has actually returned; a handler that does not
 * return keeps its lease, so no other worker can start the same job while it
 * might still be running. Nothing waits without a bound.
 */
export class WorkerLoop {
  private stopping = false;
  private active: { job: JobRow; settled: Promise<JobOutcome>; interrupt: AbortController } | null = null;
  private wake: (() => void) | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped: Promise<ShutdownOutcome> | null = null;

  constructor(
    private readonly ctx: PipelineContext,
    private readonly options: WorkerLoopOptions,
  ) {}

  get isStopping(): boolean {
    return this.stopping;
  }

  get activeJobId(): string | null {
    return this.active?.job.id ?? null;
  }

  /** Start the loop. Resolves when the loop has exited after `shutdown()`. */
  start(): Promise<void> {
    this.running ??= this.loop();
    return this.running;
  }

  /** Stop the worker; see the class comment. Safe to call more than once. */
  shutdown(): Promise<ShutdownOutcome> {
    this.stopped ??= this.drain();
    return this.stopped;
  }

  private async loop(): Promise<void> {
    await this.recoverOnce();
    if (!this.stopping) {
      this.recoveryTimer = setInterval(() => void this.recoverOnce(), this.options.recoveryIntervalMs);
      this.recoveryTimer.unref();
    }
    while (!this.stopping) {
      try {
        const claimed = await this.iterate();
        if (claimed === 0) await this.sleep(this.options.pollIntervalMs);
      } catch (error) {
        this.ctx.log.error('worker_loop_error', { error: error instanceof Error ? error.message : String(error) });
        await this.sleep(this.options.pollIntervalMs * 5);
      }
    }
  }

  private async iterate(): Promise<number> {
    const claim =
      this.options.claim ?? ((limit: number) => claimJobs(this.ctx.pool, this.options.workerId, limit));
    const jobs = await claim(this.options.batchSize);
    for (const job of jobs) {
      if (this.stopping) {
        // Claimed but never started: hand it back without spending an attempt.
        await releaseJob(this.ctx.pool, job.id, this.options.workerId, { countAttempt: false });
        this.ctx.log.info('job_released_unstarted', { jobId: job.id, type: job.type });
        continue;
      }
      const interrupt = new AbortController();
      const settled = runClaimedJob(this.ctx, this.options, job, this.options.handlers, interrupt.signal);
      this.active = { job, settled, interrupt };
      try {
        await settled;
      } finally {
        this.active = null;
      }
    }
    return jobs.length;
  }

  private async recoverOnce(): Promise<void> {
    // A draining worker must not take on other workers' abandoned jobs.
    if (this.stopping) return;
    try {
      const recover = this.options.recover ?? (() => recoverAbandonedJobs(this.ctx, this.options.leaseMs));
      await recover();
    } catch (error) {
      this.ctx.log.error('job_recovery_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private async drain(): Promise<ShutdownOutcome> {
    this.stopping = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    this.wake?.();

    const active = this.active;
    this.ctx.log.info('worker_draining', { activeJobId: active?.job.id ?? null, graceMs: this.options.shutdownGraceMs });
    const waitMs = this.options.interruptWaitMs ?? SHUTDOWN_INTERRUPT_WAIT_MS;
    if (!active) {
      // Between jobs, or claiming: the loop exits at its next check. Bounded, in
      // case a database call it is waiting on never returns.
      const exited = !this.running || (await settlesWithin(this.running, this.options.shutdownGraceMs));
      return { drained: exited, interruptedJobId: null, interruptedOutcome: null };
    }

    if (await settlesWithin(active.settled, this.options.shutdownGraceMs)) {
      // Let the loop hand back any jobs of the batch it had not started.
      if (this.running) await settlesWithin(this.running, waitMs);
      return { drained: true, interruptedJobId: null, interruptedOutcome: null };
    }

    this.ctx.log.warn('worker_interrupting_job', { jobId: active.job.id, type: active.job.type });
    active.interrupt.abort();
    const returned = await settlesWithin(active.settled, waitMs);
    if (!returned) {
      // Still running: it keeps its lease until this process exits, and is
      // recovered once the lease expires. Releasing it now could let a second
      // worker start it while this one is still executing it.
      this.ctx.log.warn('worker_left_job_to_lease_recovery', { jobId: active.job.id, type: active.job.type });
      return { drained: false, interruptedJobId: active.job.id, interruptedOutcome: null };
    }
    if (this.running) await settlesWithin(this.running, waitMs);
    return { drained: false, interruptedJobId: active.job.id, interruptedOutcome: await active.settled };
  }
}

/** Whether `promise` settles within `ms`. Never rejects. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
