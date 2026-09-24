import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import express from 'express';
import { z } from 'zod';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  consentSatisfied,
  normalizeForSearch,
  retentionExpiry,
  type Scope,
} from '@alia/core';
import {
  addMeetingMedia,
  completeUploadSession,
  createMeeting,
  createUploadSession,
  enqueueJob,
  findMedia,
  findMeeting,
  findUploadSession,
  listChapters,
  listMeetingMedia,
  listMeetings,
  listSpeakerMap,
  recordConsent,
  registerChunk,
  softDeleteMeeting,
  transitionMeetingStatus,
  updateMeeting,
  withTransaction,
  workspaceSettings,
  writeAudit,
} from '@alia/db';
import { requirePermission } from '@alia/policy';
import type { Config } from '../config.js';
import { requireScope } from '../middleware/auth.js';
import { asyncHandler, parseBody, uuidSchema } from './helpers.js';

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  language: z.enum(['ar', 'en', 'mixed']).default('mixed'),
  source: z.enum(['live_recording', 'upload']).default('upload'),
  description: z.string().max(5000).optional(),
  notes: z.string().max(20_000).optional(),
  projectId: z.string().uuid().optional(),
  scheduledAt: z.string().datetime().optional(),
  consent: z
    .object({
      obtained: z.boolean(),
      method: z.enum(['verbal', 'written', 'implied_policy', 'not_required']).optional(),
      note: z.string().max(2000).optional(),
    })
    .default({ obtained: false }),
});

const uploadInitSchema = z.object({
  filename: z.string().min(1).max(300),
  mimeType: z.string().min(3).max(120),
  totalBytes: z.number().int().positive(),
});

const ALLOWED_MEDIA = /^(audio|video)\//;

const scopeOf = (req: Request): Scope => req.ctx.scope as Scope;

export function meetingRoutes(config: Config): Router {
  const router = Router();

  const assertConsent = async (
    req: Request,
    scope: Scope,
    meeting: { consent_obtained: boolean; consent_method: string | null },
  ) => {
    const settings = await workspaceSettings(req.ctx.pool, scope.workspaceId);
    const check = consentSatisfied({
      workspaceRequiresConsent: settings?.require_recording_consent ?? true,
      consentObtained: meeting.consent_obtained,
      consentMethod: (meeting.consent_method as never) ?? null,
    });
    if (!check.ok) throw new ForbiddenError(check.reason);
  };

  router.post(
    '/',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const input = parseBody(createSchema, req.body);
      const settings = await workspaceSettings(req.ctx.pool, scope.workspaceId);
      const retention = retentionExpiry({
        createdAt: new Date(),
        retentionDays: settings?.retention_days ?? 365,
        mediaRetentionDays: settings?.media_retention_days ?? null,
      });

      const meeting = await withTransaction(req.ctx.pool, async (client) => {
        const row = await createMeeting(client, scope, {
          title: input.title,
          titleNormalized: normalizeForSearch(input.title),
          language: input.language,
          source: input.source,
          description: input.description ?? null,
          notes: input.notes ?? null,
          projectId: input.projectId ?? null,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          consent: input.consent,
          retentionExpiresAt: retention.mediaExpiresAt,
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'meeting.create',
          targetType: 'meeting',
          targetId: row.id,
          payload: { language: input.language, source: input.source, consent: input.consent.obtained },
          result: 'success',
        });
        return row;
      });
      res.status(201).json({ meeting });
    }),
  );

  router.get(
    '/',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const meetings = await listMeetings(req.ctx.pool, scope, {
        status: req.query.status as never,
        projectId: (req.query.projectId as string) || undefined,
        limit: Number(req.query.limit ?? 50),
      });
      res.json({ meetings });
    }),
  );

  router.get(
    '/:meetingId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const meeting = await findMeeting(req.ctx.pool, scope, meetingId);
      if (!meeting) throw new NotFoundError('Meeting not found');
      const [media, speakers, chapters] = await Promise.all([
        listMeetingMedia(req.ctx.pool, meetingId),
        listSpeakerMap(req.ctx.pool, meetingId),
        listChapters(req.ctx.pool, scope, meetingId),
      ]);
      res.json({
        meeting,
        media: media.map((m) => ({
          kind: m.kind,
          mimeType: m.mime_type,
          bytes: Number(m.bytes),
          durationMs: m.duration_ms ? Number(m.duration_ms) : null,
          checksum: m.checksum_sha256,
        })),
        speakers,
        chapters,
      });
    }),
  );

  router.patch(
    '/:meetingId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const patch = parseBody(
        z.object({
          title: z.string().trim().min(1).max(300).optional(),
          description: z.string().max(5000).nullable().optional(),
          notes: z.string().max(20_000).nullable().optional(),
          language: z.enum(['ar', 'en', 'mixed']).optional(),
          projectId: z.string().uuid().nullable().optional(),
        }),
        req.body,
      );
      const updated = await updateMeeting(req.ctx.pool, scope, meetingId, {
        ...patch,
        titleNormalized: patch.title ? normalizeForSearch(patch.title) : undefined,
      });
      if (!updated) throw new NotFoundError('Meeting not found');
      res.json({ meeting: updated });
    }),
  );

  router.post(
    '/:meetingId/consent',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const input = parseBody(
        z.object({
          method: z.enum(['verbal', 'written', 'implied_policy', 'not_required']),
          note: z.string().max(2000).optional(),
        }),
        req.body,
      );
      const updated = await withTransaction(req.ctx.pool, async (client) => {
        const row = await recordConsent(client, scope, meetingId, input);
        if (!row) return null;
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'meeting.consent.record',
          targetType: 'meeting',
          targetId: meetingId,
          payload: { method: input.method },
          result: 'success',
        });
        return row;
      });
      if (!updated) throw new NotFoundError('Meeting not found');
      res.json({ meeting: updated });
    }),
  );

  // ------------------------------------------------------------- uploads
  router.post(
    '/:meetingId/uploads',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const meeting = await findMeeting(req.ctx.pool, scope, meetingId);
      if (!meeting) throw new NotFoundError('Meeting not found');

      const input = parseBody(uploadInitSchema, req.body);
      if (!ALLOWED_MEDIA.test(input.mimeType)) {
        throw new ValidationError('Only audio or video files can be uploaded.');
      }
      if (input.totalBytes > config.MAX_UPLOAD_BYTES) {
        throw new ValidationError(
          `File is larger than the ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
        );
      }
      // Consent is checked before a single byte is stored, not after.
      await assertConsent(req, scope, meeting);
      req.ctx.registry.storage(); // throws NOT_CONFIGURED when storage is unset

      const session = await createUploadSession(req.ctx.pool, {
        workspaceId: scope.workspaceId,
        meetingId,
        filename: input.filename.slice(0, 300),
        mimeType: input.mimeType,
        totalBytes: input.totalBytes,
        chunkSize: config.UPLOAD_CHUNK_SIZE,
        storagePrefix: `${scope.workspaceId}/uploads/${meetingId}`,
        createdBy: scope.userId,
      });
      res.status(201).json({
        uploadId: session.id,
        chunkSize: session.chunk_size,
        chunkCount: Math.ceil(input.totalBytes / session.chunk_size),
        receivedChunks: session.received_chunks,
      });
    }),
  );

  router.get(
    '/:meetingId/uploads/:uploadId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      const session = await findUploadSession(req.ctx.pool, scope, uuidSchema.parse(req.params.uploadId));
      if (!session) throw new NotFoundError('Upload session not found');
      res.json({
        uploadId: session.id,
        status: session.status,
        chunkSize: session.chunk_size,
        receivedChunks: session.received_chunks,
        receivedBytes: Number(session.received_bytes),
        totalBytes: Number(session.total_bytes),
      });
    }),
  );

  /** Resumable chunk upload: re-sending a chunk is safe and does not double-count. */
  router.put(
    '/:meetingId/uploads/:uploadId/chunks/:index',
    requireScope,
    express.raw({ type: () => true, limit: config.UPLOAD_CHUNK_SIZE + 1024 }),
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const uploadId = uuidSchema.parse(req.params.uploadId);
      const index = z.coerce.number().int().min(0).parse(req.params.index);
      const session = await findUploadSession(req.ctx.pool, scope, uploadId);
      if (!session) throw new NotFoundError('Upload session not found');
      if (session.status !== 'open') throw new ValidationError('Upload session is closed.');

      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new ValidationError('Empty chunk.');
      if (body.length > session.chunk_size) throw new ValidationError('Chunk exceeds the negotiated chunk size.');

      await req.ctx.registry
        .storage()
        .put({ key: `${session.storage_prefix}/${uploadId}/${index}`, body, contentType: 'application/octet-stream' });
      const updated = await registerChunk(req.ctx.pool, uploadId, index, body.length);
      res.json({
        receivedChunks: updated?.received_chunks.length ?? 0,
        receivedBytes: Number(updated?.received_bytes ?? 0),
      });
    }),
  );

  router.post(
    '/:meetingId/uploads/:uploadId/complete',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const uploadId = uuidSchema.parse(req.params.uploadId);
      const session = await findUploadSession(req.ctx.pool, scope, uploadId);
      if (!session) throw new NotFoundError('Upload session not found');

      const totalBytes = Number(session.total_bytes);
      const expected = Math.ceil(totalBytes / session.chunk_size);
      const missing: number[] = [];
      for (let i = 0; i < expected; i += 1) if (!session.received_chunks.includes(i)) missing.push(i);
      if (missing.length > 0) {
        throw new ValidationError(`Upload incomplete: ${missing.length} chunk(s) missing.`, { missing });
      }
      // The assembled object is streamed, so its length has to be known before the
      // first byte is sent (S3 rejects a stream body without one). Every chunk is
      // present by now, so a byte-count mismatch means the client announced a size
      // it did not upload: refuse deterministically rather than store a short object.
      const receivedBytes = Number(session.received_bytes);
      if (receivedBytes !== totalBytes) {
        throw new ValidationError(`Upload incomplete: ${receivedBytes} of ${totalBytes} bytes received.`, {
          receivedBytes,
          totalBytes,
        });
      }

      const storage = req.ctx.registry.storage();
      const hash = createHash('sha256');
      let bytes = 0;
      const assembled = Readable.from(
        (async function* () {
          for (let i = 0; i < expected; i += 1) {
            const chunk = await storage.getBuffer(`${session.storage_prefix}/${uploadId}/${i}`);
            hash.update(chunk);
            bytes += chunk.length;
            yield chunk;
          }
        })(),
      );

      const key = `${scope.workspaceId}/meetings/${meetingId}/original-${uploadId}`;
      await storage.put({ key, body: assembled, contentType: session.mime_type, bytes: totalBytes });
      await storage.deletePrefix(`${session.storage_prefix}/${uploadId}`);

      const media = await withTransaction(req.ctx.pool, async (client) => {
        await completeUploadSession(client, uploadId);
        const row = await addMeetingMedia(client, {
          workspaceId: scope.workspaceId,
          meetingId,
          kind: 'original',
          storageKey: key,
          mimeType: session.mime_type,
          bytes,
          checksum: hash.digest('hex'),
        });
        await transitionMeetingStatus(client, meetingId, ['draft', 'recording', 'failed', 'uploaded'], 'uploaded');
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'meeting.media.upload',
          targetType: 'meeting',
          targetId: meetingId,
          payload: { bytes, mimeType: session.mime_type },
          result: 'success',
        });
        await enqueueJob(client, {
          workspaceId: scope.workspaceId,
          type: 'media.normalize',
          payload: { meetingId },
          maxAttempts: 3,
        });
        return row;
      });

      res.status(201).json({
        media: { bytes: Number(media.bytes), checksum: media.checksum_sha256, storedAs: media.kind },
        processing: 'queued',
      });
    }),
  );

  /** Authorized media streaming; there are no public object URLs. */
  router.get(
    '/:meetingId/media',
    requireScope,
    asyncHandler(async (req: Request, res: Response) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const kind = (req.query.kind as string) === 'original' ? 'original' : 'normalized';
      const media =
        (await findMedia(req.ctx.pool, scope, meetingId, kind)) ??
        (await findMedia(req.ctx.pool, scope, meetingId, 'original'));
      if (!media) throw new NotFoundError('No media for this meeting');

      const storage = req.ctx.registry.storage();
      const total = Number(media.bytes);
      res.setHeader('Content-Type', media.mime_type);
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      // Range support is what makes the player seekable — clicking a timestamp
      // in the transcript is useless without it.
      res.setHeader('Accept-Ranges', 'bytes');

      const rangeHeader = req.headers.range;
      const match = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;

      if (match && total > 0) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`);
          res.end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        const partial = await storage.getStream(media.storage_key, { start, end });
        partial.on('error', () => res.destroy());
        partial.pipe(res);
        return;
      }

      if (total > 0) res.setHeader('Content-Length', String(total));
      const stream = await storage.getStream(media.storage_key);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  router.post(
    '/:meetingId/reprocess',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const meeting = await findMeeting(req.ctx.pool, scope, meetingId);
      if (!meeting) throw new NotFoundError('Meeting not found');
      const stage = parseBody(
        z.object({ stage: z.enum(['transcribe', 'analyze']).default('transcribe') }),
        req.body ?? {},
      );
      const jobType = stage.stage === 'analyze' ? 'analysis.run' : 'media.normalize';
      await withTransaction(req.ctx.pool, async (client) => {
        await transitionMeetingStatus(client, meetingId, ['ready', 'failed', 'uploaded', 'processing'], 'processing');
        await enqueueJob(client, {
          workspaceId: scope.workspaceId,
          type: jobType,
          payload: { meetingId },
          maxAttempts: 3,
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'meeting.reprocess',
          targetType: 'meeting',
          targetId: meetingId,
          payload: { stage: stage.stage },
          result: 'success',
        });
      });
      res.json({ queued: jobType });
    }),
  );

  /** Delete = erasure. Media, transcript, embeddings and AI artifacts all go. */
  router.delete(
    '/:meetingId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.delete');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const deleted = await withTransaction(req.ctx.pool, async (client) => {
        const ok = await softDeleteMeeting(client, scope, meetingId);
        if (!ok) return false;
        await enqueueJob(client, {
          workspaceId: scope.workspaceId,
          type: 'meeting.purge',
          payload: { meetingId, reason: 'user_request', requestedBy: scope.userId },
          maxAttempts: 3,
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'meeting.delete',
          targetType: 'meeting',
          targetId: meetingId,
          result: 'success',
          reason: 'user_request',
        });
        return true;
      });
      if (!deleted) throw new NotFoundError('Meeting not found');
      res.json({ deleted: true, erasure: 'queued' });
    }),
  );

  return router;
}
