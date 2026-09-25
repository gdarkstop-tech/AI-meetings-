import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeForSearch, parseSecretKey, ProviderNotConfiguredError, type Scope } from '@alia/core';
import {
  addMeetingMedia,
  addMember,
  createMeeting,
  createUser,
  createWorkspace,
  enqueueJob,
  findMeetingUnscoped,
  withTransaction,
  type JobRow,
  type Pool,
} from '@alia/db';
import { createLogger } from '@alia/observability';
import {
  createProviderRegistry,
  type ProviderKind,
  type ProviderRegistry,
  type TranscriptionProvider,
  type TranscriptionResult,
} from '@alia/providers';
import { hasTestDatabase, setupTestDatabase, TEST_SECRETS_KEY, uniqueEmail } from '../../../test/support/db.js';
import type { PipelineContext } from './context.js';
import { PipelineStepError } from './failures.js';
import { HANDLERS, type JobHandler } from './jobs.js';
import { recoverAbandonedJobs, runClaimedJob, WorkerLoop, type RunnerOptions, type WorkerLoopOptions } from './runner.js';

const d = hasTestDatabase ? describe : describe.skip;

/**
 * Counts calls and returns fixed segments. It exists only in this test, to
 * prove the pipeline does not call a paid provider twice for one job; no
 * application code path can reach it, and it is not evidence that any real
 * provider transcribes anything.
 */
class CountingAsr implements TranscriptionProvider {
  readonly id = 'counting-test-asr';
  readonly modelVersion = 'test';
  calls = 0;
  async transcribe(): Promise<TranscriptionResult> {
    this.calls += 1;
    return {
      segments: [
        { startMs: 0, endMs: 1200, speaker: 'Speaker 1', text: 'نبدأ الاجتماع الآن' },
        { startMs: 1300, endMs: 2500, speaker: 'Speaker 2', text: 'Let us review the budget' },
      ],
      providerId: this.id,
      modelVersion: this.modelVersion,
      usage: { audioSeconds: 3 },
    };
  }
}

d('job runner: leases, recovery and meeting failure (real PostgreSQL)', () => {
  let pool: Pool;
  let scope: Scope;
  let storageDir: string;
  const LEASE_MS = 10 * 60_000;
  const HOUR = 3600;

  beforeAll(async () => {
    pool = await setupTestDatabase();
    storageDir = await mkdtemp(path.join(os.tmpdir(), 'alia-runner-'));
    scope = await withTransaction(pool, async (client) => {
      const user = await createUser(client, {
        email: uniqueEmail('runner'),
        name: 'Runner Tester',
        passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      });
      const ws = await createWorkspace(client, { name: 'Runner workspace' });
      await addMember(client, { workspaceId: ws.id, userId: user.id, role: 'owner' });
      return { workspaceId: ws.id, userId: user.id, role: 'owner' as const };
    });
  });

  afterAll(async () => {
    await pool?.end();
    await rm(storageDir, { recursive: true, force: true });
  });

  const baseRegistry = () => createProviderRegistry({ STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: storageDir });

  const contextWith = (registry: ProviderRegistry): PipelineContext => ({
    pool,
    registry,
    log: createLogger({ level: 'error', write: () => {} }),
    secretsKey: parseSecretKey(TEST_SECRETS_KEY),
    publicBaseUrl: null,
  });

  /** A registry whose ASR is the counting double and whose LLM reports configured (never called). */
  const registryWithAsr = (asr: TranscriptionProvider, llmConfigured = false): ProviderRegistry => {
    const base = baseRegistry();
    return {
      ...base,
      asr: () => asr,
      isConfigured: (kind: ProviderKind) =>
        kind === 'asr' ? true : kind === 'llm' ? llmConfigured : base.isConfigured(kind),
    };
  };

  const newMeeting = async (status: 'processing' | 'uploaded' | 'ready' = 'processing', language: 'ar' | 'en' | 'mixed' = 'mixed') => {
    const meeting = await createMeeting(pool, scope, {
      title: 'Runner meeting',
      titleNormalized: normalizeForSearch('Runner meeting'),
      language,
      source: 'upload',
      consent: { obtained: true, method: 'verbal' },
      retentionExpiresAt: null,
    });
    await pool.query('UPDATE meetings SET status = $2 WHERE id = $1', [meeting.id, status]);
    return meeting.id;
  };

  /** Put a job into the state a worker that claimed it would leave it in. */
  const claimAs = async (jobId: string, workerId: string, opts: { attempts?: number; lockedSecondsAgo?: number } = {}) => {
    const { rows } = await pool.query<JobRow>(
      `UPDATE jobs SET status = 'running', locked_by = $2, attempts = $3,
              locked_at = now() - make_interval(secs => $4::int)
        WHERE id = $1 RETURNING *`,
      [jobId, workerId, opts.attempts ?? 1, opts.lockedSecondsAgo ?? 0],
    );
    return rows[0];
  };

  const job = async (jobId: string) =>
    (await pool.query<JobRow & { result: Record<string, unknown> | null }>('SELECT * FROM jobs WHERE id = $1', [jobId]))
      .rows[0];
  const meetingRow = async (meetingId: string) => (await findMeetingUnscoped(pool, meetingId))!;
  const options = (workerId: string, extra: Partial<RunnerOptions> = {}): RunnerOptions => ({
    workerId,
    batchSize: 1,
    leaseMs: LEASE_MS,
    ...extra,
  });

  describe('worker crash and restart', () => {
    it('re-runs a job abandoned by a crashed worker, exactly once, on another worker', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'test.crash', payload: { meetingId } });
      await claimAs(queued.id, 'crashed-worker', { lockedSecondsAgo: HOUR });

      let runs = 0;
      const handlers: Record<string, JobHandler> = { 'test.crash': async () => ({ run: ++runs }) };
      const ctx = contextWith(baseRegistry());

      const recovered = await recoverAbandonedJobs(ctx, LEASE_MS);
      expect(recovered.map((j) => j.id)).toContain(queued.id);
      const reclaimed = await claimAs(queued.id, 'worker-b', { attempts: 2 });
      await runClaimedJob(ctx, options('worker-b'), reclaimed, handlers);

      expect(runs).toBe(1);
      const after = await job(queued.id);
      expect(after.status).toBe('succeeded');
      expect(after.result).toEqual({ run: 1 });
    });

    it('stops a run that lost its lease and discards what it produced', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'test.stall', payload: { meetingId } });
      const claimed = await claimAs(queued.id, 'worker-a');

      let aborted = false;
      const handlers: Record<string, JobHandler> = {
        'test.stall': async (_ctx, _job, run) => {
          await new Promise<void>((resolve) => run?.signal?.addEventListener('abort', () => resolve()));
          aborted = run?.signal?.aborted ?? false;
          return { late: true };
        },
      };
      const running = runClaimedJob(contextWith(baseRegistry()), options('worker-a', { heartbeatMs: 20 }), claimed, handlers);

      // Meanwhile the job is recovered and taken over by worker-b.
      await pool.query(`UPDATE jobs SET locked_by = 'worker-b', locked_at = now(), attempts = 2 WHERE id = $1`, [queued.id]);
      await running;

      expect(aborted).toBe(true);
      const after = await job(queued.id);
      expect(after.status).toBe('running');
      expect(after.locked_by).toBe('worker-b');
      expect(after.result).toBeNull();
    });
  });

  describe('meeting state when its pipeline cannot go on', () => {
    it('marks the meeting failed at once, with a safe reason, when no ASR provider is configured', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, {
        workspaceId: scope.workspaceId,
        type: 'asr.transcribe',
        payload: { meetingId },
        maxAttempts: 3,
      });
      const claimed = await claimAs(queued.id, 'worker-a');
      await runClaimedJob(contextWith(baseRegistry()), options('worker-a'), claimed);

      const after = await job(queued.id);
      expect(after.status).toBe('dead');
      expect(after.attempts).toBe(1); // not retried: configuration will not change by itself
      const meeting = await meetingRow(meetingId);
      expect(meeting.status).toBe('failed');
      expect(meeting.failure_code).toBe('TRANSCRIPTION_NOT_CONFIGURED');
      expect(meeting.failure_reason).toBe('Speech-to-text is not configured. Configure a provider, then use Re-transcribe.');
    });

    it('never copies raw error text into the meeting, even when it contains a credential', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId }, maxAttempts: 2 });
      const claimed = await claimAs(queued.id, 'worker-a', { attempts: 2 });
      const leak = 'Provider failed (500): {"error":"upstream"} key=sk-live-0123456789abcdef at /app/node_modules/x.js:1:1';
      const handlers: Record<string, JobHandler> = {
        'asr.transcribe': async () => {
          throw new Error(leak);
        },
      };
      await runClaimedJob(contextWith(baseRegistry()), options('worker-a'), claimed, handlers);

      const meeting = await meetingRow(meetingId);
      expect(meeting.status).toBe('failed');
      expect(meeting.failure_code).toBe('TRANSCRIPTION_FAILED');
      for (const fragment of ['sk-live', 'node_modules', 'upstream', '500']) {
        expect(meeting.failure_reason).not.toContain(fragment);
      }
      // The raw error is kept for operators, in the job row that no API returns.
      expect((await job(queued.id)).last_error).toBe(leak);
    });

    it('keeps the meeting processing while retries remain', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId }, maxAttempts: 3 });
      const claimed = await claimAs(queued.id, 'worker-a', { attempts: 1 });
      const handlers: Record<string, JobHandler> = {
        'asr.transcribe': async () => {
          throw new Error('socket hang up');
        },
      };
      await runClaimedJob(contextWith(baseRegistry()), options('worker-a'), claimed, handlers);

      expect((await job(queued.id)).status).toBe('queued');
      const meeting = await meetingRow(meetingId);
      expect(meeting.status).toBe('processing');
      expect(meeting.failure_reason).toBeNull();
    });

    it('does not mark the meeting failed while newer work for it is queued', async () => {
      const meetingId = await newMeeting();
      const dying = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId } });
      // A reprocess was queued for the same meeting before this attempt died.
      await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'media.normalize', payload: { meetingId } });
      const claimed = await claimAs(dying.id, 'worker-a');
      const handlers: Record<string, JobHandler> = {
        'asr.transcribe': async () => {
          throw new ProviderNotConfiguredError('asr');
        },
      };
      await runClaimedJob(contextWith(baseRegistry()), options('worker-a'), claimed, handlers);

      expect((await job(dying.id)).status).toBe('dead');
      expect((await meetingRow(meetingId)).status).toBe('processing');
    });

    it('does not fail the meeting when only search enrichment dies', async () => {
      const meetingId = await newMeeting('ready');
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'transcript.embed', payload: { meetingId } });
      const claimed = await claimAs(queued.id, 'worker-a');
      const handlers: Record<string, JobHandler> = {
        'transcript.embed': async () => {
          throw new ProviderNotConfiguredError('embeddings');
        },
      };
      await runClaimedJob(contextWith(baseRegistry()), options('worker-a'), claimed, handlers);
      expect((await meetingRow(meetingId)).status).toBe('ready');
    });

    it('marks the meeting failed when a crashed job has used its last attempt', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId }, maxAttempts: 2 });
      await claimAs(queued.id, 'crashed-worker', { attempts: 2, lockedSecondsAgo: HOUR });
      await recoverAbandonedJobs(contextWith(baseRegistry()), LEASE_MS);

      expect((await job(queued.id)).status).toBe('dead');
      const meeting = await meetingRow(meetingId);
      expect(meeting.status).toBe('failed');
      expect(meeting.failure_code).toBe('PROCESSING_INTERRUPTED');
    });

    it('leaves the meeting processing when a crashed job still has attempts left', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId }, maxAttempts: 3 });
      await claimAs(queued.id, 'crashed-worker', { attempts: 1, lockedSecondsAgo: HOUR });
      await recoverAbandonedJobs(contextWith(baseRegistry()), LEASE_MS);

      expect((await job(queued.id)).status).toBe('queued');
      expect((await meetingRow(meetingId)).status).toBe('processing');
    });
  });

  describe('no second paid call for the same job', () => {
    const withAudio = async (meetingId: string) => {
      const storage = baseRegistry().storage();
      const key = `${scope.workspaceId}/meetings/${meetingId}/normalized.ogg`;
      await storage.put({ key, body: Buffer.alloc(128, 3), contentType: 'audio/ogg' });
      await addMeetingMedia(pool, {
        workspaceId: scope.workspaceId,
        meetingId,
        kind: 'normalized',
        storageKey: key,
        mimeType: 'audio/ogg',
        bytes: 128,
      });
    };

    it('does not call the ASR provider again when a finished transcription is re-run after a crash', async () => {
      const meetingId = await newMeeting('processing', 'ar');
      await withAudio(meetingId);
      const asr = new CountingAsr();
      const ctx = contextWith(registryWithAsr(asr, true));
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId } });

      // First run stores the transcript, then the worker dies before recording success.
      const first = await claimAs(queued.id, 'worker-a');
      await HANDLERS['asr.transcribe'](ctx, first);
      expect(asr.calls).toBe(1);
      await pool.query('UPDATE jobs SET locked_at = now() - interval \'1 hour\' WHERE id = $1', [queued.id]);

      // Recovery hands it to worker-b, which must reuse the stored transcript.
      await recoverAbandonedJobs(ctx, LEASE_MS);
      const again = await claimAs(queued.id, 'worker-b', { attempts: 2 });
      await runClaimedJob(ctx, options('worker-b'), again);

      expect(asr.calls).toBe(1);
      expect((await job(queued.id)).status).toBe('succeeded');
      const versions = await pool.query('SELECT id FROM transcript_versions WHERE meeting_id = $1', [meetingId]);
      expect(versions.rows).toHaveLength(1);
      const calls = await pool.query(
        `SELECT id FROM provider_calls WHERE job_id = $1 AND provider_kind = 'asr' AND outcome = 'success'`,
        [queued.id],
      );
      expect(calls.rows).toHaveLength(1);
      // The step after transcription was queued once, not once per run.
      const analyses = await pool.query(`SELECT id FROM jobs WHERE type = 'analysis.run' AND payload->>'parentJobId' = $1`, [queued.id]);
      expect(analyses.rows).toHaveLength(1);
    });

    it('does not pay for analysis again when its results are already stored', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'analysis.run', payload: { meetingId } });
      const claimed = await claimAs(queued.id, 'worker-a');
      await pool.query(
        `INSERT INTO provider_calls (workspace_id, job_id, meeting_id, provider_kind, provider_id, operation, outcome)
         VALUES ($1, $2, $3, 'llm', 'anthropic', 'analysis', 'success')`,
        [scope.workspaceId, queued.id, meetingId],
      );
      // No LLM is configured: reaching the provider would throw NOT_CONFIGURED.
      const result = await HANDLERS['analysis.run'](contextWith(baseRegistry()), claimed);
      expect(result).toEqual({ reused: true });
      expect((await meetingRow(meetingId)).status).toBe('ready');
    });

    it('fails a transcription that found no speech once, instead of paying for it three times', async () => {
      const meetingId = await newMeeting('processing', 'en');
      await withAudio(meetingId);
      const silent = new CountingAsr();
      silent.transcribe = async () => {
        silent.calls += 1;
        return { segments: [], providerId: silent.id, modelVersion: 'test', usage: { audioSeconds: 3 } };
      };
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId }, maxAttempts: 3 });
      const claimed = await claimAs(queued.id, 'worker-a');
      await runClaimedJob(contextWith(registryWithAsr(silent)), options('worker-a'), claimed);

      expect(silent.calls).toBe(1);
      expect((await job(queued.id)).status).toBe('dead');
      const meeting = await meetingRow(meetingId);
      expect(meeting.failure_code).toBe('NO_SPEECH_DETECTED');
      expect(meeting.failure_reason).toBe('No speech was detected in the recording.');
    });

    it('treats a typed pipeline error as permanent', async () => {
      expect(new PipelineStepError('X', 'y').permanent).toBe(true);
    });
  });

  describe('graceful shutdown', () => {
    const WORKER = 'draining-worker';
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const loopOptions = (extra: Partial<WorkerLoopOptions>): WorkerLoopOptions => ({
      workerId: WORKER,
      batchSize: 1,
      leaseMs: LEASE_MS,
      heartbeatMs: 20,
      pollIntervalMs: 25,
      recoveryIntervalMs: 20,
      shutdownGraceMs: 5_000,
      interruptWaitMs: 1_000,
      recover: async () => undefined,
      ...extra,
    });
    /** Hands the loop each prepared job once, then nothing; counts every call. */
    const claimSeam = (batches: JobRow[][]) => {
      const seam = { calls: 0, claim: async () => (seam.calls++, batches.shift() ?? []) };
      return seam;
    };
    const until = async (condition: () => boolean, ms = 3_000) => {
      const deadline = Date.now() + ms;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await sleep(5);
      }
    };

    it('stops at once when idle, and neither claims nor recovers afterwards', async () => {
      const seam = claimSeam([]);
      let recoveries = 0;
      const loop = new WorkerLoop(
        contextWith(baseRegistry()),
        loopOptions({ claim: seam.claim, recover: async () => void recoveries++ }),
      );
      const running = loop.start();
      await sleep(120);

      const started = Date.now();
      const outcome = await loop.shutdown();
      expect(Date.now() - started).toBeLessThan(500);
      expect(outcome).toEqual({ drained: true, interruptedJobId: null, interruptedOutcome: null });
      await running;

      const claims = seam.calls;
      const recovered = recoveries;
      await sleep(150);
      expect(seam.calls).toBe(claims);
      expect(recoveries).toBe(recovered);
    });

    it('lets the running job finish, keeps renewing its lease meanwhile, and takes no new job', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'test.slow', payload: { meetingId } });
      const claimed = await claimAs(queued.id, WORKER);
      const seam = claimSeam([[claimed]]);
      let leaseRenewedDuringShutdown = false;
      let loop: WorkerLoop | undefined;
      const handlers: Record<string, JobHandler> = {
        'test.slow': async () => {
          await until(() => loop?.isStopping === true);
          const before = (await job(queued.id)).locked_at!.getTime();
          await sleep(150);
          leaseRenewedDuringShutdown = (await job(queued.id)).locked_at!.getTime() > before;
          return { finished: true };
        },
      };
      loop = new WorkerLoop(contextWith(baseRegistry()), loopOptions({ claim: seam.claim, handlers }));
      const running = loop.start();
      await until(() => loop!.activeJobId === queued.id);

      const outcome = await loop.shutdown();
      await running;
      expect(outcome.drained).toBe(true);
      expect(leaseRenewedDuringShutdown).toBe(true);
      const after = await job(queued.id);
      expect(after.status).toBe('succeeded');
      expect(after.result).toEqual({ finished: true });
      expect(seam.calls).toBe(1);
    });

    it('releases a job interrupted at the end of the grace period, without marking it or its meeting failed', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'asr.transcribe', payload: { meetingId } });
      const claimed = await claimAs(queued.id, WORKER, { attempts: 1 });
      const handlers: Record<string, JobHandler> = {
        'asr.transcribe': async (_ctx, _job, run) => {
          await new Promise<void>((resolve) => run?.signal?.addEventListener('abort', () => resolve()));
          throw new Error('aborted by the worker');
        },
      };
      const loop = new WorkerLoop(
        contextWith(baseRegistry()),
        loopOptions({ claim: claimSeam([[claimed]]).claim, handlers, shutdownGraceMs: 60 }),
      );
      void loop.start();
      await until(() => loop.activeJobId === queued.id);

      const outcome = await loop.shutdown();
      expect(outcome).toEqual({ drained: false, interruptedJobId: queued.id, interruptedOutcome: 'released' });
      const after = await job(queued.id);
      expect(after.status).toBe('queued');
      expect(after.locked_by).toBeNull();
      expect(after.attempts).toBe(1); // the interrupted run counts
      expect(after.last_error).toBeNull();
      expect((await meetingRow(meetingId)).status).toBe('processing');
    });

    it('keeps a job that will not stop leased to itself, so no other worker can start it', async () => {
      const meetingId = await newMeeting();
      const queued = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'test.stubborn', payload: { meetingId } });
      const claimed = await claimAs(queued.id, WORKER);
      let finish: () => void = () => {};
      const handlers: Record<string, JobHandler> = {
        'test.stubborn': () => new Promise((resolve) => (finish = () => resolve({ late: true }))),
      };
      const loop = new WorkerLoop(
        contextWith(baseRegistry()),
        loopOptions({ claim: claimSeam([[claimed]]).claim, handlers, shutdownGraceMs: 40, interruptWaitMs: 60 }),
      );
      void loop.start();
      await until(() => loop.activeJobId === queued.id);

      const started = Date.now();
      const outcome = await loop.shutdown();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(outcome).toEqual({ drained: false, interruptedJobId: queued.id, interruptedOutcome: null });
      const after = await job(queued.id);
      expect(after.status).toBe('running');
      expect(after.locked_by).toBe(WORKER);
      finish(); // in production the process exits here; let the test's handler end
      await sleep(50);
    });

    it('hands back jobs it had claimed but not started, without spending their attempt', async () => {
      const meetingId = await newMeeting();
      const first = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'test.first', payload: { meetingId } });
      const second = await enqueueJob(pool, { workspaceId: scope.workspaceId, type: 'test.second', payload: { meetingId } });
      const batch = [await claimAs(first.id, WORKER, { attempts: 1 }), await claimAs(second.id, WORKER, { attempts: 1 })];
      let secondRan = false;
      let loop: WorkerLoop | undefined;
      const handlers: Record<string, JobHandler> = {
        'test.first': async () => {
          void loop!.shutdown(); // SIGTERM arrives while the first job runs
          return { ok: true };
        },
        'test.second': async () => {
          secondRan = true;
          return { ok: true };
        },
      };
      loop = new WorkerLoop(contextWith(baseRegistry()), loopOptions({ claim: claimSeam([batch]).claim, handlers, batchSize: 2 }));
      await loop.start();

      expect(secondRan).toBe(false);
      expect((await job(first.id)).status).toBe('succeeded');
      const released = await job(second.id);
      expect(released.status).toBe('queued');
      expect(released.attempts).toBe(0);
      expect(released.locked_by).toBeNull();
    });
  });
});
