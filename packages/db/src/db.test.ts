import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  claimJobs,
  completeJob,
  countJobsByStatus,
  createUser,
  createWorkspace,
  enqueueJob,
  failJob,
  findMembership,
  listAudit,
  verifyAuditChain,
  withTransaction,
  writeAudit,
  type Pool,
} from './index.js';
import { normalizeForSearch } from '@alia/core';
import { hasTestDatabase, setupTestDatabase, uniqueEmail } from '../../../test/support/db.js';

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
      await completeJob(pool, job.id, { ok: true });
    });

    it('retries with backoff and finally marks the job dead, never succeeded', async () => {
      const job = await enqueueJob(pool, { workspaceId, type: 'always.fails', maxAttempts: 2 });
      await claimJobs(pool, 'worker-a', 5);
      const afterFirst = await failJob(pool, job.id, 'boom');
      expect(afterFirst.status).toBe('queued');
      expect(afterFirst.run_after.getTime()).toBeGreaterThan(Date.now());

      await pool.query(`UPDATE jobs SET run_after = now(), attempts = max_attempts WHERE id = $1`, [job.id]);
      const afterSecond = await failJob(pool, job.id, 'boom again');
      expect(afterSecond.status).toBe('dead');
      expect(afterSecond.last_error).toContain('boom again');
    });
  });
});
