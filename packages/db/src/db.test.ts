import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  claimJobs,
  completeJob,
  createPool,
  countJobsByStatus,
  createUser,
  createWorkspace,
  enqueueFollowUpJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  findMembership,
  listAudit,
  recoverStaleJobs,
  releaseJob,
  verifyAuditChain,
  withExclusiveLock,
  withTransaction,
  writeAudit,
  type JobRow,
  type Pool,
} from './index.js';
import { normalizeForSearch } from '@alia/core';
import { hasTestDatabase, setupTestDatabase, TEST_DATABASE_URL, uniqueEmail } from '../../../test/support/db.js';

const d = hasTestDatabase ? describe : describe.skip;
if (!hasTestDatabase) {
  console.warn('[db.test] SKIPPED: TEST_DATABASE_URL is not set. Integration tests need a real PostgreSQL.');
}

d('database layer (real PostgreSQL)', () => {
  let pool: Pool;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
    const created = await withTransaction(pool, async (client) => {
      const user = await createUser(client, {
        email: uniqueEmail('audit'),
        name: 'Audit Tester',
        passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      });
      const ws = await createWorkspace(client, { name: 'Audit workspace' });
      await addMember(client, { workspaceId: ws.id, userId: user.id, role: 'owner' });
      return { user, ws };
    });
    workspaceId = created.ws.id;
    userId = created.user.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('required extensions', () => {
    it('has pg_trgm, unaccent and vector installed', async () => {
      const { rows } = await pool.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = ANY($1)`,
        [['pg_trgm', 'unaccent', 'vector']],
      );
      expect(rows.map((r) => r.extname).sort()).toEqual(['pg_trgm', 'unaccent', 'vector']);
    });
  });

  describe('Arabic normalization against the real database', () => {
    it('turns the Phase 0 mismatch into an exact match', async () => {
      const raw = await pool.query<{ similarity: number }>(
        `SELECT similarity($1, $2) AS similarity`,
        ['الموقع', 'الموقـع'],
      );
      // Phase 0 measured 0.5 for the same word spelled with a tatweel.
      expect(Number(raw.rows[0].similarity)).toBeLessThan(1);

      const normalized = await pool.query<{ similarity: number }>(
        `SELECT similarity($1, $2) AS similarity`,
        [normalizeForSearch('الموقع'), normalizeForSearch('الموقـع')],
      );
      expect(Number(normalized.rows[0].similarity)).toBe(1);
    });

    it('matches vocalized and unvocalized spellings after normalization', async () => {
      const { rows } = await pool.query<{ same: boolean }>(`SELECT ($1 = $2) AS same`, [
        normalizeForSearch('مُحَمَّد'),
        normalizeForSearch('محمد'),
      ]);
      expect(rows[0].same).toBe(true);
    });
  });

  describe('audit log', () => {
    it('chains hashes and verifies', async () => {
      for (const action of ['test.one', 'test.two', 'test.three']) {
        await withTransaction(pool, (client) =>
          writeAudit(client, {
            workspaceId,
            actorType: 'user',
            actorId: userId,
            action,
            result: 'success',
            payload: { action },
          }),
        );
      }
      const entries = await listAudit(pool, workspaceId, 10);
      expect(entries.length).toBeGreaterThanOrEqual(3);
      const verification = await verifyAuditChain(pool, workspaceId);
      expect(verification.ok).toBe(true);
      expect(verification.rowsChecked).toBeGreaterThanOrEqual(3);
    });

    it('stores only a digest of the payload, never the payload itself', async () => {
      await withTransaction(pool, (client) =>
        writeAudit(client, {
          workspaceId,
          actorType: 'user',
          actorId: userId,
          action: 'test.payload',
          result: 'success',
          payload: { secretish: 'do-not-store-me-raw' },
        }),
      );
      const { rows } = await pool.query<{ payload_digest: string }>(
        `SELECT payload_digest FROM audit_log WHERE workspace_id = $1 AND action = 'test.payload'`,
        [workspaceId],
      );
      expect(rows[0].payload_digest).toMatch(/^[0-9a-f]{64}$/);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain('do-not-store-me-raw');
    });

    it('is append-only: UPDATE and DELETE are rejected by the database', async () => {
      await expect(
        pool.query(`UPDATE audit_log SET action = 'tampered' WHERE workspace_id = $1`, [workspaceId]),
      ).rejects.toThrow(/append-only/i);

      await expect(
        pool.query(`DELETE FROM audit_log WHERE workspace_id = $1`, [workspaceId]),
      ).rejects.toThrow(/append-only/i);
    });
  });

  describe('tenancy', () => {
    it('findMembership returns null for a workspace the user does not belong to', async () => {
      const other = await withTransaction(pool, (client) =>
        createWorkspace(client, { name: 'Someone else workspace' }),
      );
      expect(await findMembership(pool, other.id, userId)).toBeNull();
      expect(await findMembership(pool, workspaceId, userId)).not.toBeNull();
    });

    it('job counts are scoped to one workspace', async () => {
      const otherWs = await withTransaction(pool, (client) =>
        createWorkspace(client, { name: 'Other jobs workspace' }),
      );
      await enqueueJob(pool, { workspaceId: otherWs.id, type: 'noop' });
      const counts = await countJobsByStatus(pool, workspaceId);
      const otherCounts = await countJobsByStatus(pool, otherWs.id);
      expect(otherCounts.queued).toBe(1);
      expect(counts.queued ?? 0).toBe(0);
    });
  });

  describe('job queue', () => {
    it('claims a queued job exactly once', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'demo.job', payload: { n: 1 } });
      // Claim generously: other tests share this database and may have queued
      // work ahead of ours. What matters is that exactly one worker gets it.
      const first = await claimJobs(pool, 'worker-a', 500);
      const second = await claimJobs(pool, 'worker-b', 500);
      expect(first.map((j) => j.id)).toContain(job.id);
      expect(second.map((j) => j.id)).not.toContain(job.id);
      expect(await completeJob(pool, job.id, 'worker-a', { ok: true })).toBe(true);
    });

    it('retries with backoff and finally marks the job dead, never succeeded', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'always.fails', maxAttempts: 2 });
      await runAs(job.id, 'worker-a', { attempts: 1 });
      const afterFirst = await failJob(pool, job.id, 'worker-a', 'boom');
      expect(afterFirst?.status).toBe('queued');
      expect(afterFirst!.run_after.getTime()).toBeGreaterThan(Date.now());

      await runAs(job.id, 'worker-a', { attempts: 2 });
      const afterSecond = await failJob(pool, job.id, 'worker-a', 'boom again');
      expect(afterSecond?.status).toBe('dead');
      expect(afterSecond?.last_error).toContain('boom again');
    });

    it('fails a permanent error at once instead of retrying it', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'permanent.fail', maxAttempts: 3 });
      await runAs(job.id, 'worker-a', { attempts: 1 });
      const failed = await failJob(pool, job.id, 'worker-a', 'provider not configured', { permanent: true });
      expect(failed?.status).toBe('dead');
      expect(failed?.attempts).toBe(1);
      expect(failed?.finished_at).not.toBeNull();
    });
  });

  /**
   * Put one job into the state a worker holding it would leave it in, without
   * going through claimJobs — other tests share this database and may have
   * queued work that a real claim would pick up first.
   */
  const runAs = async (
    jobId: string,
    workerId: string,
    opts: { attempts?: number; lockedSecondsAgo?: number } = {},
  ): Promise<void> => {
    await pool.query(
      `UPDATE jobs SET status = 'running', locked_by = $2, attempts = $3,
              locked_at = now() - make_interval(secs => $4::int), run_after = now()
        WHERE id = $1`,
      [jobId, workerId, opts.attempts ?? 1, opts.lockedSecondsAgo ?? 0],
    );
  };
  const jobById = async (jobId: string): Promise<JobRow> =>
    (await pool.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId])).rows[0];
  const HOUR = 3600;
  const LEASE_MS = 10 * 60_000;

  describe('job leases (worker crash and restart)', () => {
    it('lets only the owning worker renew its lease', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'lease.renew' });
      await runAs(job.id, 'worker-a', { lockedSecondsAgo: 120 });
      const before = (await jobById(job.id)).locked_at!;
      expect(await heartbeatJob(pool, job.id, 'worker-b')).toBe(false);
      expect((await jobById(job.id)).locked_at!.getTime()).toBe(before.getTime());
      expect(await heartbeatJob(pool, job.id, 'worker-a')).toBe(true);
      expect((await jobById(job.id)).locked_at!.getTime()).toBeGreaterThan(before.getTime());
    });

    it('recovers a job whose worker stopped, and leaves a healthy one alone', async () => {
      const abandoned = await enqueueJob(pool, { workspaceId, type: 'lease.abandoned', maxAttempts: 3 });
      const healthy = await enqueueJob(pool, { workspaceId, type: 'lease.healthy', maxAttempts: 3 });
      await runAs(abandoned.id, 'crashed-worker', { attempts: 1, lockedSecondsAgo: HOUR });
      await runAs(healthy.id, 'live-worker', { attempts: 1, lockedSecondsAgo: 5 });

      const recovered = await recoverStaleJobs(pool, LEASE_MS);
      const ids = recovered.map((j) => j.id);
      expect(ids).toContain(abandoned.id);
      expect(ids).not.toContain(healthy.id);

      const after = await jobById(abandoned.id);
      expect(after.status).toBe('queued');
      expect(after.locked_by).toBeNull();
      expect(after.attempts).toBe(1); // the crashed attempt counts
      expect((await jobById(healthy.id)).status).toBe('running');
    });

    it('recovers each abandoned job exactly once when workers recover concurrently', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'lease.concurrent-recovery', maxAttempts: 3 });
      await runAs(job.id, 'crashed-worker', { lockedSecondsAgo: HOUR });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => recoverStaleJobs(pool, LEASE_MS)),
      );
      const hits = results.flat().filter((j) => j.id === job.id);
      expect(hits).toHaveLength(1);
    });

    it('lets exactly one worker claim a recovered job', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'lease.reclaim', maxAttempts: 3 });
      await runAs(job.id, 'crashed-worker', { lockedSecondsAgo: HOUR });
      await recoverStaleJobs(pool, LEASE_MS);
      const [a, b] = await Promise.all([claimJobs(pool, 'worker-a', 500), claimJobs(pool, 'worker-b', 500)]);
      const claimers = [a, b].filter((batch) => batch.some((j) => j.id === job.id));
      expect(claimers).toHaveLength(1);
    });

    it('discards the outcome of a worker that lost its lease', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'lease.zombie', maxAttempts: 3 });
      // worker-a stalls past its lease; the job is recovered and worker-b runs it.
      await runAs(job.id, 'worker-a', { attempts: 1, lockedSecondsAgo: HOUR });
      await recoverStaleJobs(pool, LEASE_MS);
      await runAs(job.id, 'worker-b', { attempts: 2 });

      // worker-a wakes up: it can neither complete nor fail the job any more.
      expect(await completeJob(pool, job.id, 'worker-a', { stale: true })).toBe(false);
      expect(await failJob(pool, job.id, 'worker-a', 'stale failure')).toBeNull();
      expect(await heartbeatJob(pool, job.id, 'worker-a')).toBe(false);
      const during = await jobById(job.id);
      expect(during.status).toBe('running');
      expect(during.locked_by).toBe('worker-b');

      expect(await completeJob(pool, job.id, 'worker-b', { ok: true })).toBe(true);
      const after = await jobById(job.id);
      expect(after.status).toBe('succeeded');
      expect(after.last_error).not.toBe('stale failure');
    });

    it('marks a job dead instead of recovering it forever when it used its last attempt', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'lease.exhausted', maxAttempts: 2 });
      await runAs(job.id, 'crashed-worker', { attempts: 2, lockedSecondsAgo: HOUR });
      const recovered = await recoverStaleJobs(pool, LEASE_MS);
      const row = recovered.find((j) => j.id === job.id);
      expect(row?.status).toBe('dead');
      expect(row?.finished_at).not.toBeNull();
    });
  });

  describe('handing jobs back on shutdown', () => {
    it('releases only for the lease holder, keeping or refunding the attempt as asked', async () => {
      const interrupted = await enqueueJob(pool, { workspaceId, type: 'release.interrupted' });
      const unstarted = await enqueueJob(pool, { workspaceId, type: 'release.unstarted' });
      await runAs(interrupted.id, 'worker-a', { attempts: 2 });
      await runAs(unstarted.id, 'worker-a', { attempts: 2 });

      expect(await releaseJob(pool, interrupted.id, 'worker-b', { countAttempt: true })).toBe(false);
      expect((await jobById(interrupted.id)).status).toBe('running');

      expect(await releaseJob(pool, interrupted.id, 'worker-a', { countAttempt: true })).toBe(true);
      expect(await releaseJob(pool, unstarted.id, 'worker-a', { countAttempt: false })).toBe(true);
      const a = await jobById(interrupted.id);
      const b = await jobById(unstarted.id);
      expect([a.status, a.locked_by, a.attempts]).toEqual(['queued', null, 2]);
      expect([b.status, b.locked_by, b.attempts]).toEqual(['queued', null, 1]);
      // Once released, the old holder can do nothing more with it.
      expect(await completeJob(pool, interrupted.id, 'worker-a', { late: true })).toBe(false);
    });
  });

  describe('exclusive locks', () => {
    /**
     * Advisory locks are re-entrant within one connection, so "can it be taken
     * again?" must be asked from a connection that cannot be the one the helper
     * used — a fresh pool of one, outside the shared pool.
     */
    const isFree = async (key: string): Promise<boolean> => {
      const probe = createPool({ connectionString: TEST_DATABASE_URL!, max: 1 });
      try {
        const { rows } = await probe.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [key]);
        if (rows[0].ok) await probe.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        return rows[0].ok;
      } finally {
        await probe.end();
      }
    };

    it('refuses a second holder at once instead of waiting, and frees the lock afterwards', async () => {
      const key = `test-lock:${Date.now()}`;
      let release: () => void = () => {};
      const holding = withExclusiveLock(pool, key, () => new Promise<string>((resolve) => (release = () => resolve('first'))));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const started = Date.now();
      expect(await withExclusiveLock(pool, key, async () => 'second')).toEqual({ acquired: false });
      expect(Date.now() - started).toBeLessThan(1_000);

      expect(await isFree(key)).toBe(false);
      release();
      expect(await holding).toEqual({ acquired: true, value: 'first' });
      expect(await isFree(key)).toBe(true);
    });

    it('frees the lock even when the work throws', async () => {
      const key = `test-lock-throw:${Date.now()}`;
      await expect(
        withExclusiveLock(pool, key, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await isFree(key)).toBe(true);
    });
  });

  describe('pipeline follow-up jobs', () => {
    it('enqueues the next step once per parent, however often the parent runs', async () => {
      const parent = await enqueueJob(pool, { workspaceId, type: 'media.normalize', payload: { meetingId: 'x' } });
      const first = await enqueueFollowUpJob(pool, parent.id, { workspaceId, type: 'asr.transcribe', payload: { meetingId: 'x' } });
      const again = await enqueueFollowUpJob(pool, parent.id, { workspaceId, type: 'asr.transcribe', payload: { meetingId: 'x' } });
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.job.id).toBe(first.job.id);
      expect(first.job.payload.parentJobId).toBe(parent.id);
    });

    it('enqueues a single child even when two runs of the same parent overlap', async () => {
      const parent = await enqueueJob(pool, { workspaceId, type: 'media.normalize', payload: { meetingId: 'y' } });
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          enqueueFollowUpJob(pool, parent.id, { workspaceId, type: 'asr.transcribe', payload: { meetingId: 'y' } }),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const { rows } = await pool.query(`SELECT id FROM jobs WHERE payload->>'parentJobId' = $1`, [parent.id]);
      expect(rows).toHaveLength(1);
    });
  });
});
