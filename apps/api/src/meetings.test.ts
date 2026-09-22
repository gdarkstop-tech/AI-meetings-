import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { ProviderNotConfiguredError } from '@alia/core';
import { countJobsByStatus, type Pool } from '@alia/db';
import { createLogger } from '@alia/observability';
import { HANDLERS, type PipelineContext } from '@alia/pipeline';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import {
  TEST_DATABASE_URL,
  TEST_PASSWORD,
  TEST_SECRETS_KEY,
  buildTestPipeline,
  hasTestDatabase,
  setupTestDatabase,
  uniqueEmail,
} from '../../../test/support/db.js';

const d = hasTestDatabase ? describe : describe.skip;

d('meetings lifecycle (real database, real storage, real jobs)', () => {
  let pool: Pool;
  let app: Express;
  let appNoStorage: Express;
  let pipeline: PipelineContext;
  let storageDir: string;

  const register = async (prefix: string) => {
    const agent = request.agent(app);
    const email = uniqueEmail(prefix);
    const res = await agent
      .post('/api/v1/auth/register')
      .send({ email, name: `${prefix} user`, password: TEST_PASSWORD, locale: 'en' });
    expect(res.status).toBe(201);
    return { agent, email, workspaceId: res.body.workspace.id as string, csrf: res.body.csrfToken as string };
  };

  const createMeeting = async (user: Awaited<ReturnType<typeof register>>, consent = false) => {
    const res = await user.agent
      .post('/api/v1/meetings')
      .set('x-csrf-token', user.csrf)
      .send({
        title: 'اجتماع الموقع الأسبوعي',
        language: 'mixed',
        consent: consent ? { obtained: true, method: 'verbal', note: 'announced at start' } : { obtained: false },
      });
    expect(res.status).toBe(201);
    return res.body.meeting as { id: string; status: string; consent_obtained: boolean };
  };

  beforeAll(async () => {
    pool = await setupTestDatabase();
    storageDir = await mkdtemp(path.join(os.tmpdir(), 'alia-storage-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'error',
      RATE_LIMIT_REGISTER_MAX: '500',
      SECRETS_KEY: TEST_SECRETS_KEY,
      UPLOAD_CHUNK_SIZE: '1024',
    } as NodeJS.ProcessEnv);
    pipeline = buildTestPipeline(pool, { STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: storageDir });
    app = buildServer({ config, pipeline, logger: createLogger({ level: 'error', write: () => {} }) });
    appNoStorage = buildServer({
      config,
      pipeline: buildTestPipeline(pool, {}),
      logger: createLogger({ level: 'error', write: () => {} }),
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('consent gate', () => {
    it('refuses to accept a single byte before consent is recorded', async () => {
      const user = await register('consent');
      const meeting = await createMeeting(user, false);
      const res = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads`)
        .set('x-csrf-token', user.csrf)
        .send({ filename: 'meeting.m4a', mimeType: 'audio/mp4', totalBytes: 2048 });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/consent/i);
    });

    it('allows upload once consent is recorded, and records who recorded it', async () => {
      const user = await register('consent2');
      const meeting = await createMeeting(user, false);
      const consent = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/consent`)
        .set('x-csrf-token', user.csrf)
        .send({ method: 'verbal', note: 'All participants agreed on the call' });
      expect(consent.status).toBe(200);
      expect(consent.body.meeting.consent_obtained).toBe(true);
      expect(consent.body.meeting.consent_recorded_at).toBeTruthy();

      const upload = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads`)
        .set('x-csrf-token', user.csrf)
        .send({ filename: 'meeting.m4a', mimeType: 'audio/mp4', totalBytes: 2048 });
      expect(upload.status).toBe(201);
      expect(upload.body.chunkSize).toBe(1024);
      expect(upload.body.chunkCount).toBe(2);
    });

    it('rejects non-media uploads', async () => {
      const user = await register('mime');
      const meeting = await createMeeting(user, true);
      const res = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads`)
        .set('x-csrf-token', user.csrf)
        .send({ filename: 'payload.exe', mimeType: 'application/x-msdownload', totalBytes: 100 });
      expect(res.status).toBe(400);
    });
  });

  describe('resumable upload', () => {
    it('stores real bytes, survives a duplicate chunk, and returns a real checksum', async () => {
      const user = await register('upload');
      const meeting = await createMeeting(user, true);
      const payload = Buffer.concat([Buffer.alloc(1024, 1), Buffer.alloc(600, 2)]);
      const expectedChecksum = createHash('sha256').update(payload).digest('hex');

      const init = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads`)
        .set('x-csrf-token', user.csrf)
        .send({ filename: 'meeting.ogg', mimeType: 'audio/ogg', totalBytes: payload.length });
      const uploadId = init.body.uploadId as string;

      const putChunk = (index: number, body: Buffer) =>
        user.agent
          .put(`/api/v1/meetings/${meeting.id}/uploads/${uploadId}/chunks/${index}`)
          .set('x-csrf-token', user.csrf)
          .set('content-type', 'application/octet-stream')
          .send(body);

      await putChunk(0, payload.subarray(0, 1024));
      // Completing now must fail: a partial upload is never treated as done.
      const early = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads/${uploadId}/complete`)
        .set('x-csrf-token', user.csrf)
        .send({});
      expect(early.status).toBe(400);
      expect(early.body.error.details.missing).toEqual([1]);

      // Resume: re-send chunk 0 (idempotent) then the missing chunk.
      const duplicate = await putChunk(0, payload.subarray(0, 1024));
      expect(duplicate.body.receivedBytes).toBe(1024);
      await putChunk(1, payload.subarray(1024));

      const completed = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads/${uploadId}/complete`)
        .set('x-csrf-token', user.csrf)
        .send({});
      expect(completed.status).toBe(201);
      expect(completed.body.media.bytes).toBe(payload.length);
      expect(completed.body.media.checksum).toBe(expectedChecksum);

      // The stored object streams back byte-identical.
      const download = await user.agent.get(`/api/v1/meetings/${meeting.id}/media?kind=original`).buffer(true);
      expect(download.status).toBe(200);
      expect(createHash('sha256').update(download.body).digest('hex')).toBe(expectedChecksum);

      // Range requests work, so the player can seek to a transcript timestamp.
      const ranged = await user.agent
        .get(`/api/v1/meetings/${meeting.id}/media?kind=original`)
        .set('Range', 'bytes=0-99')
        .buffer(true);
      expect(ranged.status).toBe(206);
      expect(ranged.headers['content-range']).toBe(`bytes 0-99/${payload.length}`);
      expect(ranged.headers['accept-ranges']).toBe('bytes');
      expect(ranged.body.length).toBe(100);

      const unsatisfiable = await user.agent
        .get(`/api/v1/meetings/${meeting.id}/media?kind=original`)
        .set('Range', `bytes=${payload.length + 10}-`);
      expect(unsatisfiable.status).toBe(416);

      // Processing was queued; nothing was transcribed inside the request.
      const detail = await user.agent.get(`/api/v1/meetings/${meeting.id}`);
      expect(detail.body.meeting.status).toBe('uploaded');
      const counts = await countJobsByStatus(pool, user.workspaceId);
      expect(counts.queued).toBeGreaterThanOrEqual(1);
    });

    it('reports NOT_CONFIGURED when storage is not set up, instead of pretending to store', async () => {
      const agent = request.agent(appNoStorage);
      const email = uniqueEmail('nostorage');
      const reg = await agent
        .post('/api/v1/auth/register')
        .send({ email, name: 'No storage', password: TEST_PASSWORD, locale: 'en' });
      const meeting = await agent
        .post('/api/v1/meetings')
        .set('x-csrf-token', reg.body.csrfToken)
        .send({ title: 'No storage meeting', consent: { obtained: true, method: 'verbal' } });
      const res = await agent
        .post(`/api/v1/meetings/${meeting.body.meeting.id}/uploads`)
        .set('x-csrf-token', reg.body.csrfToken)
        .send({ filename: 'a.ogg', mimeType: 'audio/ogg', totalBytes: 10 });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('NOT_CONFIGURED');
    });
  });

  describe('no provider, no fake output', () => {
    it('fails the transcription job loudly when no ASR provider is configured', async () => {
      const user = await register('noasr');
      const meeting = await createMeeting(user, true);
      const job = {
        id: randomUUID(),
        workspace_id: user.workspaceId,
        type: 'asr.transcribe',
        payload: { meetingId: meeting.id },
        status: 'running' as const,
        attempts: 1,
        max_attempts: 3,
        run_after: new Date(),
        locked_by: 'test',
        last_error: null,
        created_at: new Date(),
        finished_at: null,
      };
      await expect(HANDLERS['asr.transcribe'](pipeline, job)).rejects.toThrow(ProviderNotConfiguredError);

      // The meeting must not claim a transcript it does not have.
      const transcript = await user.agent.get(`/api/v1/meetings/${meeting.id}/transcript`);
      expect(transcript.status).toBe(200);
      expect(transcript.body.segments).toEqual([]);
    });
  });

  describe('workspace isolation', () => {
    it('hides another workspace\'s meeting, transcript and media', async () => {
      const owner = await register('owner-iso');
      const outsider = await register('outsider-iso');
      const meeting = await createMeeting(owner, true);

      for (const path of [
        `/api/v1/meetings/${meeting.id}`,
        `/api/v1/meetings/${meeting.id}/transcript`,
        `/api/v1/meetings/${meeting.id}/media`,
        `/api/v1/meetings/${meeting.id}/insights`,
      ]) {
        const res = await outsider.agent.get(path);
        expect([403, 404], `expected denial for ${path}`).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toContain('اجتماع الموقع');
      }
    });
  });

  describe('erasure', () => {
    it('deletes media, transcript artifacts and storage objects, and records the deletion', async () => {
      const user = await register('erase');
      const meeting = await createMeeting(user, true);
      const payload = Buffer.alloc(1200, 5);
      const init = await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads`)
        .set('x-csrf-token', user.csrf)
        .send({ filename: 'meeting.ogg', mimeType: 'audio/ogg', totalBytes: payload.length });
      const uploadId = init.body.uploadId as string;
      await user.agent
        .put(`/api/v1/meetings/${meeting.id}/uploads/${uploadId}/chunks/0`)
        .set('x-csrf-token', user.csrf)
        .set('content-type', 'application/octet-stream')
        .send(payload.subarray(0, 1024));
      await user.agent
        .put(`/api/v1/meetings/${meeting.id}/uploads/${uploadId}/chunks/1`)
        .set('x-csrf-token', user.csrf)
        .set('content-type', 'application/octet-stream')
        .send(payload.subarray(1024));
      await user.agent
        .post(`/api/v1/meetings/${meeting.id}/uploads/${uploadId}/complete`)
        .set('x-csrf-token', user.csrf)
        .send({});

      const storageKeyRow = await pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM meeting_media WHERE meeting_id = $1`,
        [meeting.id],
      );
      const storageKey = storageKeyRow.rows[0].storage_key;
      expect(await pipeline.registry.storage().head(storageKey)).not.toBeNull();

      const deleted = await user.agent
        .delete(`/api/v1/meetings/${meeting.id}`)
        .set('x-csrf-token', user.csrf);
      expect(deleted.status).toBe(200);
      expect(deleted.body.erasure).toBe('queued');

      // Run the purge job for real.
      const purgeJob = await pool.query<{ id: string; payload: Record<string, unknown> }>(
        `SELECT id, payload FROM jobs WHERE type = 'meeting.purge' AND payload->>'meetingId' = $1 LIMIT 1`,
        [meeting.id],
      );
      expect(purgeJob.rows).toHaveLength(1);
      const result = await HANDLERS['meeting.purge'](pipeline, {
        id: purgeJob.rows[0].id,
        workspace_id: user.workspaceId,
        type: 'meeting.purge',
        payload: purgeJob.rows[0].payload,
        status: 'running',
        attempts: 1,
        max_attempts: 3,
        run_after: new Date(),
        locked_by: 'test',
        last_error: null,
        created_at: new Date(),
        finished_at: null,
      });
      expect(result.purged).toBe(true);

      // The bytes are really gone from storage.
      expect(await pipeline.registry.storage().head(storageKey)).toBeNull();

      const media = await pool.query(`SELECT purged_at FROM meeting_media WHERE meeting_id = $1`, [meeting.id]);
      expect(media.rows.every((r) => (r as { purged_at: Date | null }).purged_at !== null)).toBe(true);

      const deletions = await user.agent.get('/api/v1/workspace/deletions');
      expect(deletions.status).toBe(200);
      expect(deletions.body.deletions.some((row: { target_id: string }) => row.target_id === meeting.id)).toBe(true);
    });
  });
});
