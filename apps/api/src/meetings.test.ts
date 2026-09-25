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
import { HANDLERS, runClaimedJob, type PipelineContext } from '@alia/pipeline';
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
  /**
   * An app whose speech-to-text and LLM report configured, so the API's
   * "is this provider set up?" checks pass. The keys are placeholders: the API
   * never runs jobs, and no test here executes a job with this app's
   * providers, so they are never sent anywhere.
   */
  let appProviders: Express;
  let pipeline: PipelineContext;
  let storageDir: string;

  const register = async (prefix: string, target: Express = app) => {
    const agent = request.agent(target);
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
    appProviders = buildServer({
      config,
      pipeline: buildTestPipeline(pool, {
        STORAGE_PROVIDER: 'local',
        STORAGE_LOCAL_DIR: storageDir,
        ASR_PROVIDER: 'elevenlabs',
        ELEVENLABS_API_KEY: 'placeholder-never-sent',
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'placeholder-never-sent',
      }),
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
        locked_at: new Date(),
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
        locked_at: new Date(),
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

  // ------------------------------------------------------------ pipeline guard
  type TestUser = Awaited<ReturnType<typeof register>>;
  const RECORDING = Buffer.concat([Buffer.alloc(1024, 1), Buffer.alloc(600, 2)]);

  const openUpload = async (user: TestUser, meetingId: string, payload = RECORDING) => {
    const init = await user.agent
      .post(`/api/v1/meetings/${meetingId}/uploads`)
      .set('x-csrf-token', user.csrf)
      .send({ filename: 'meeting.ogg', mimeType: 'audio/ogg', totalBytes: payload.length });
    expect(init.status).toBe(201);
    const uploadId = init.body.uploadId as string;
    for (let i = 0; i * 1024 < payload.length; i += 1) {
      const put = await user.agent
        .put(`/api/v1/meetings/${meetingId}/uploads/${uploadId}/chunks/${i}`)
        .set('x-csrf-token', user.csrf)
        .set('content-type', 'application/octet-stream')
        .send(payload.subarray(i * 1024, (i + 1) * 1024));
      expect(put.status).toBe(200);
    }
    return uploadId;
  };
  const completeUpload = (user: TestUser, meetingId: string, uploadId: string) =>
    user.agent.post(`/api/v1/meetings/${meetingId}/uploads/${uploadId}/complete`).set('x-csrf-token', user.csrf).send({});
  const reprocess = (user: TestUser, meetingId: string, stage: 'transcribe' | 'analyze') =>
    user.agent.post(`/api/v1/meetings/${meetingId}/reprocess`).set('x-csrf-token', user.csrf).send({ stage });
  const pipelineJobs = async (meetingId: string) =>
    (
      await pool.query<{ type: string; status: string }>(
        `SELECT type, status FROM jobs
          WHERE payload->>'meetingId' = $1 AND type IN ('media.normalize', 'asr.transcribe', 'analysis.run')`,
        [meetingId],
      )
    ).rows;
  /** Stand in for the worker having finished the meeting's pipeline. */
  const finishPipeline = async (meetingId: string) => {
    await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE payload->>'meetingId' = $1 AND status IN ('queued', 'running')`, [
      meetingId,
    ]);
    await pool.query(`UPDATE meetings SET status = 'ready' WHERE id = $1`, [meetingId]);
  };

  describe('processing is started at most once at a time', () => {
    it('queues exactly one paid transcription when Re-transcribe is sent six times at once', async () => {
      const user = await register('dedupe', appProviders);
      const meeting = await createMeeting(user, true);
      expect((await completeUpload(user, meeting.id, await openUpload(user, meeting.id))).status).toBe(201);
      await finishPipeline(meeting.id);

      const responses = await Promise.all(Array.from({ length: 6 }, () => reprocess(user, meeting.id, 'transcribe')));
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
      for (const refused of responses.filter((r) => r.status === 409)) {
        expect(refused.body.error.code).toBe('CONFLICT');
        expect(refused.body.error.details).toEqual({ stage: 'preparing', state: 'queued' });
      }
      const active = (await pipelineJobs(meeting.id)).filter((j) => j.status === 'queued' || j.status === 'running');
      expect(active).toEqual([{ type: 'media.normalize', status: 'queued' }]);
      const detail = await user.agent.get(`/api/v1/meetings/${meeting.id}`);
      expect(detail.body.processing).toEqual({ active: true, stage: 'preparing' });
    });

    it('lets a meeting stuck in "processing" with no live job be started again', async () => {
      // A meeting whose last job died before failures were recorded on meetings.
      const user = await register('stuck', appProviders);
      const meeting = await createMeeting(user, true);
      await completeUpload(user, meeting.id, await openUpload(user, meeting.id));
      await pool.query(`UPDATE jobs SET status = 'dead' WHERE payload->>'meetingId' = $1`, [meeting.id]);
      await pool.query(`UPDATE meetings SET status = 'processing' WHERE id = $1`, [meeting.id]);

      const before = await user.agent.get(`/api/v1/meetings/${meeting.id}`);
      expect(before.body.processing).toEqual({ active: false, stage: null });
      expect((await reprocess(user, meeting.id, 'transcribe')).status).toBe(200);
    });

    it('refuses to reprocess while the uploaded recording is still queued for processing', async () => {
      const user = await register('busy', appProviders);
      const meeting = await createMeeting(user, true);
      await completeUpload(user, meeting.id, await openUpload(user, meeting.id));

      const res = await reprocess(user, meeting.id, 'transcribe');
      expect(res.status).toBe(409);
      expect(await pipelineJobs(meeting.id)).toHaveLength(1);
    });

    it('refuses Re-transcribe when no speech-to-text provider is configured, leaving the meeting as it was', async () => {
      const user = await register('reproc-noasr');
      const meeting = await createMeeting(user, true);
      await completeUpload(user, meeting.id, await openUpload(user, meeting.id));
      await finishPipeline(meeting.id);

      const res = await reprocess(user, meeting.id, 'transcribe');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('NOT_CONFIGURED');
      const detail = await user.agent.get(`/api/v1/meetings/${meeting.id}`);
      expect(detail.body.meeting.status).toBe('ready');
      expect((await pipelineJobs(meeting.id)).filter((j) => j.status === 'queued')).toEqual([]);
    });

    it('refuses Re-transcribe when there is no recording yet', async () => {
      const user = await register('reproc-nomedia', appProviders);
      const meeting = await createMeeting(user, true);
      const res = await reprocess(user, meeting.id, 'transcribe');
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/no recording/i);
      expect(await pipelineJobs(meeting.id)).toEqual([]);
    });

    it('refuses Re-run analysis when there is no transcript to analyse', async () => {
      const user = await register('reproc-notranscript', appProviders);
      const meeting = await createMeeting(user, true);
      await completeUpload(user, meeting.id, await openUpload(user, meeting.id));
      await finishPipeline(meeting.id);

      const res = await reprocess(user, meeting.id, 'analyze');
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/no transcript/i);
      expect((await pipelineJobs(meeting.id)).map((j) => j.type)).toEqual(['media.normalize']);
    });

    it('does not let another workspace reprocess a meeting', async () => {
      const owner = await register('reproc-owner', appProviders);
      const outsider = await register('reproc-outsider', appProviders);
      const meeting = await createMeeting(owner, true);
      await completeUpload(owner, meeting.id, await openUpload(owner, meeting.id));
      await finishPipeline(meeting.id);

      const res = await reprocess(outsider, meeting.id, 'transcribe');
      expect(res.status).toBe(404);
      expect((await pipelineJobs(meeting.id)).filter((j) => j.status === 'queued')).toEqual([]);
    });
  });

  describe('an upload is completed once', () => {
    it('refuses a repeated completion and does not queue more processing', async () => {
      const user = await register('complete-twice');
      const meeting = await createMeeting(user, true);
      const uploadId = await openUpload(user, meeting.id);
      expect((await completeUpload(user, meeting.id, uploadId)).status).toBe(201);
      const again = await completeUpload(user, meeting.id, uploadId);
      expect(again.status).toBe(409);
      expect(await pipelineJobs(meeting.id)).toEqual([{ type: 'media.normalize', status: 'queued' }]);
    });

    it('lets exactly one of six simultaneous completions win; the others get a 409, never a 500', async () => {
      const user = await register('complete-race');
      const expectedChecksum = createHash('sha256').update(RECORDING).digest('hex');
      for (let round = 0; round < 3; round += 1) {
        const meeting = await createMeeting(user, true);
        const uploadId = await openUpload(user, meeting.id);

        const responses = await Promise.all(Array.from({ length: 6 }, () => completeUpload(user, meeting.id, uploadId)));

        expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
        for (const lost of responses.filter((r) => r.status === 409)) {
          expect(lost.body.error.code).toBe('CONFLICT');
          expect(lost.body.error.message).toMatch(/already (being )?completed/);
        }
        const won = responses.find((r) => r.status === 201)!;
        expect(won.body.media).toEqual({ bytes: RECORDING.length, checksum: expectedChecksum, storedAs: 'original' });

        // One processing chain, one media row, and the stored object is intact.
        expect(await pipelineJobs(meeting.id)).toEqual([{ type: 'media.normalize', status: 'queued' }]);
        const media = await pool.query<{ kind: string; bytes: string; checksum_sha256: string }>(
          'SELECT kind, bytes, checksum_sha256 FROM meeting_media WHERE meeting_id = $1',
          [meeting.id],
        );
        expect(media.rows).toEqual([{ kind: 'original', bytes: String(RECORDING.length), checksum_sha256: expectedChecksum }]);
        const download = await user.agent.get(`/api/v1/meetings/${meeting.id}/media?kind=original`).buffer(true);
        expect(createHash('sha256').update(download.body).digest('hex')).toBe(expectedChecksum);

        // The session is completed and its chunks were removed once, after the commit.
        const session = await pool.query<{ status: string; storage_prefix: string }>(
          'SELECT status, storage_prefix FROM upload_sessions WHERE id = $1',
          [uploadId],
        );
        expect(session.rows[0].status).toBe('completed');
        const storage = pipeline.registry.storage();
        for (const index of [0, 1]) {
          expect(await storage.head(`${session.rows[0].storage_prefix}/${uploadId}/${index}`)).toBeNull();
        }
      }
    });

    it("refuses to complete a meeting's upload under a different meeting, which would bypass that meeting's consent", async () => {
      const user = await register('complete-wrong-meeting');
      const consented = await createMeeting(user, true);
      const unconsented = await createMeeting(user, false);
      const uploadId = await openUpload(user, consented.id);

      const res = await completeUpload(user, unconsented.id, uploadId);
      expect(res.status).toBe(404);
      const media = await pool.query('SELECT id FROM meeting_media WHERE meeting_id = $1', [unconsented.id]);
      expect(media.rows).toEqual([]);
      expect(await pipelineJobs(unconsented.id)).toEqual([]);
      // The upload is still usable for the meeting it belongs to.
      expect((await completeUpload(user, consented.id, uploadId)).status).toBe(201);
    });
  });

  describe('a meeting whose processing cannot go on', () => {
    it('shows failed with a fixed, safe reason, and can be started again once fixed', async () => {
      const user = await register('failed-state');
      const meeting = await createMeeting(user, true);
      await completeUpload(user, meeting.id, await openUpload(user, meeting.id));
      // Stand in for normalization having succeeded and queued transcription.
      await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE payload->>'meetingId' = $1`, [meeting.id]);
      await pool.query(`UPDATE meetings SET status = 'processing' WHERE id = $1`, [meeting.id]);
      const { rows } = await pool.query(
        `INSERT INTO jobs (workspace_id, type, payload, status, attempts, locked_by, locked_at)
         VALUES ($1, 'asr.transcribe', $2, 'running', 1, 'test-worker', now()) RETURNING *`,
        [user.workspaceId, { meetingId: meeting.id }],
      );

      // The real transcription handler, with no ASR provider configured.
      await runClaimedJob(pipeline, { workerId: 'test-worker', batchSize: 1, leaseMs: 600_000 }, rows[0]);

      const detail = await user.agent.get(`/api/v1/meetings/${meeting.id}`);
      expect(detail.body.meeting.status).toBe('failed');
      expect(detail.body.meeting.failure_code).toBe('TRANSCRIPTION_NOT_CONFIGURED');
      expect(detail.body.meeting.failure_reason).toBe(
        'Speech-to-text is not configured. Configure a provider, then use Re-transcribe.',
      );
      expect(JSON.stringify(detail.body)).not.toContain('last_error');

      // Once a provider is configured, the user can start again from failed.
      const login = await request.agent(appProviders).post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
      expect(login.status).toBe(200);
      const again = await request
        .agent(appProviders)
        .post(`/api/v1/meetings/${meeting.id}/reprocess`)
        .set('Cookie', login.headers['set-cookie'])
        .set('x-csrf-token', login.body.csrfToken)
        .send({ stage: 'transcribe' });
      expect(again.status).toBe(200);
      const after = await user.agent.get(`/api/v1/meetings/${meeting.id}`);
      expect(after.body.meeting.status).toBe('processing');
      expect(after.body.meeting.failure_reason).toBeNull();
    });
  });
});
