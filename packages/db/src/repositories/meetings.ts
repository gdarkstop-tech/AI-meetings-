import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

export type MeetingStatus = 'draft' | 'recording' | 'uploaded' | 'processing' | 'ready' | 'failed';

export interface MeetingRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  notes: string | null;
  language: 'ar' | 'en' | 'mixed';
  status: MeetingStatus;
  failure_reason: string | null;
  failure_code: string | null;
  source: 'live_recording' | 'upload' | 'integration';
  scheduled_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_ms: string | null;
  consent_obtained: boolean;
  consent_method: string | null;
  consent_note: string | null;
  consent_recorded_at: Date | null;
  retention_expires_at: Date | null;
  media_purged_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MeetingMediaRow {
  id: string;
  meeting_id: string;
  kind: 'original' | 'normalized';
  storage_key: string;
  mime_type: string;
  bytes: string;
  duration_ms: string | null;
  checksum_sha256: string | null;
  purged_at: Date | null;
  created_at: Date;
}

export async function createMeeting(
  db: Queryable,
  scope: Scope,
  input: {
    title: string;
    titleNormalized: string;
    language: 'ar' | 'en' | 'mixed';
    source: 'live_recording' | 'upload' | 'integration';
    projectId?: string | null;
    description?: string | null;
    notes?: string | null;
    scheduledAt?: Date | null;
    consent: { obtained: boolean; method?: string | null; note?: string | null };
    retentionExpiresAt: Date | null;
  },
): Promise<MeetingRow> {
  const { rows } = await db.query<MeetingRow>(
    `INSERT INTO meetings
       (workspace_id, project_id, title, title_normalized, description, notes, language, source,
        scheduled_at, consent_obtained, consent_method, consent_note, consent_recorded_by,
        consent_recorded_at, retention_expires_at, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             CASE WHEN $10 THEN $13::uuid ELSE NULL END,
             CASE WHEN $10 THEN now() ELSE NULL END,
             $14,$13,'draft')
     RETURNING *`,
    [
      scope.workspaceId,
      input.projectId ?? null,
      input.title,
      input.titleNormalized,
      input.description ?? null,
      input.notes ?? null,
      input.language,
      input.source,
      input.scheduledAt ?? null,
      input.consent.obtained,
      input.consent.method ?? null,
      input.consent.note ?? null,
      scope.userId,
      input.retentionExpiresAt,
    ],
  );
  return rows[0];
}

export async function listMeetings(
  db: Queryable,
  scope: Scope,
  filters: { status?: MeetingStatus; projectId?: string; limit?: number; offset?: number } = {},
): Promise<MeetingRow[]> {
  const { rows } = await db.query<MeetingRow>(
    `SELECT * FROM meetings
      WHERE workspace_id = $1
        AND deleted_at IS NULL
        AND ($2::text IS NULL OR status = $2)
        AND ($3::uuid IS NULL OR project_id = $3)
      ORDER BY COALESCE(started_at, scheduled_at, created_at) DESC
      LIMIT $4 OFFSET $5`,
    [
      scope.workspaceId,
      filters.status ?? null,
      filters.projectId ?? null,
      Math.min(filters.limit ?? 50, 200),
      filters.offset ?? 0,
    ],
  );
  return rows;
}

/** Scope is mandatory: a meeting from another workspace is simply not found. */
export async function findMeeting(db: Queryable, scope: Scope, meetingId: string): Promise<MeetingRow | null> {
  const { rows } = await db.query<MeetingRow>(
    `SELECT * FROM meetings WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [meetingId, scope.workspaceId],
  );
  return rows[0] ?? null;
}

export async function findMeetingUnscoped(db: Queryable, meetingId: string): Promise<MeetingRow | null> {
  const { rows } = await db.query<MeetingRow>(`SELECT * FROM meetings WHERE id = $1`, [meetingId]);
  return rows[0] ?? null;
}

export async function updateMeeting(
  db: Queryable,
  scope: Scope,
  meetingId: string,
  patch: {
    title?: string;
    titleNormalized?: string;
    description?: string | null;
    notes?: string | null;
    projectId?: string | null;
    language?: 'ar' | 'en' | 'mixed';
    scheduledAt?: Date | null;
  },
): Promise<MeetingRow | null> {
  const { rows } = await db.query<MeetingRow>(
    `UPDATE meetings SET
       title = COALESCE($3, title),
       title_normalized = COALESCE($4, title_normalized),
       description = COALESCE($5, description),
       notes = COALESCE($6, notes),
       project_id = COALESCE($7, project_id),
       language = COALESCE($8, language),
       scheduled_at = COALESCE($9, scheduled_at),
       updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [
      meetingId,
      scope.workspaceId,
      patch.title ?? null,
      patch.titleNormalized ?? null,
      patch.description ?? null,
      patch.notes ?? null,
      patch.projectId ?? null,
      patch.language ?? null,
      patch.scheduledAt ?? null,
    ],
  );
  return rows[0] ?? null;
}

/**
 * Status transitions are guarded in SQL: the update only applies when the
 * current status is one the caller expects, so concurrent workers cannot move a
 * meeting backwards or mark a failed meeting ready.
 */
export async function transitionMeetingStatus(
  db: Queryable,
  meetingId: string,
  from: MeetingStatus[],
  to: MeetingStatus,
  extra: { failureReason?: string | null; failureCode?: string | null; durationMs?: number | null } = {},
): Promise<MeetingRow | null> {
  const { rows } = await db.query<MeetingRow>(
    `UPDATE meetings SET
       status = $3,
       failure_reason = $4,
       failure_code = $5,
       duration_ms = COALESCE($6, duration_ms),
       started_at = CASE WHEN $3 = 'recording' AND started_at IS NULL THEN now() ELSE started_at END,
       ended_at = CASE WHEN $3 IN ('uploaded','ready') AND ended_at IS NULL THEN now() ELSE ended_at END,
       updated_at = now()
     WHERE id = $1 AND status = ANY($2) AND deleted_at IS NULL
     RETURNING *`,
    [meetingId, from, to, extra.failureReason ?? null, extra.failureCode ?? null, extra.durationMs ?? null],
  );
  return rows[0] ?? null;
}

export async function recordConsent(
  db: Queryable,
  scope: Scope,
  meetingId: string,
  input: { method: string; note?: string | null },
): Promise<MeetingRow | null> {
  const { rows } = await db.query<MeetingRow>(
    `UPDATE meetings SET
       consent_obtained = true, consent_method = $3, consent_note = $4,
       consent_recorded_by = $5, consent_recorded_at = now(), updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [meetingId, scope.workspaceId, input.method, input.note ?? null, scope.userId],
  );
  return rows[0] ?? null;
}

export async function softDeleteMeeting(db: Queryable, scope: Scope, meetingId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE meetings SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [meetingId, scope.workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function addMeetingMedia(
  db: Queryable,
  input: {
    workspaceId: string;
    meetingId: string;
    kind: 'original' | 'normalized';
    storageKey: string;
    mimeType: string;
    bytes: number;
    durationMs?: number | null;
    checksum?: string | null;
  },
): Promise<MeetingMediaRow> {
  const { rows } = await db.query<MeetingMediaRow>(
    `INSERT INTO meeting_media (workspace_id, meeting_id, kind, storage_key, mime_type, bytes, duration_ms, checksum_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.workspaceId,
      input.meetingId,
      input.kind,
      input.storageKey,
      input.mimeType,
      input.bytes,
      input.durationMs ?? null,
      input.checksum ?? null,
    ],
  );
  return rows[0];
}

export async function listMeetingMedia(db: Queryable, meetingId: string): Promise<MeetingMediaRow[]> {
  const { rows } = await db.query<MeetingMediaRow>(
    `SELECT * FROM meeting_media WHERE meeting_id = $1 AND purged_at IS NULL ORDER BY created_at ASC`,
    [meetingId],
  );
  return rows;
}

export async function findMedia(
  db: Queryable,
  scope: Scope,
  meetingId: string,
  kind: 'original' | 'normalized',
): Promise<MeetingMediaRow | null> {
  const { rows } = await db.query<MeetingMediaRow>(
    `SELECT m.* FROM meeting_media m
      JOIN meetings mt ON mt.id = m.meeting_id
     WHERE m.meeting_id = $1 AND m.kind = $2 AND mt.workspace_id = $3
       AND m.purged_at IS NULL AND mt.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT 1`,
    [meetingId, kind, scope.workspaceId],
  );
  return rows[0] ?? null;
}

export async function markMediaPurged(db: Queryable, meetingId: string): Promise<number> {
  const res = await db.query(
    `UPDATE meeting_media SET purged_at = now() WHERE meeting_id = $1 AND purged_at IS NULL`,
    [meetingId],
  );
  return res.rowCount ?? 0;
}

// ----------------------------------------------------------------- uploads
export interface UploadSessionRow {
  id: string;
  workspace_id: string;
  meeting_id: string;
  filename: string;
  mime_type: string;
  total_bytes: string;
  chunk_size: number;
  received_chunks: number[];
  received_bytes: string;
  storage_prefix: string;
  status: 'open' | 'completed' | 'aborted';
  created_at: Date;
}

export async function createUploadSession(
  db: Queryable,
  input: {
    workspaceId: string;
    meetingId: string;
    filename: string;
    mimeType: string;
    totalBytes: number;
    chunkSize: number;
    storagePrefix: string;
    createdBy: string;
  },
): Promise<UploadSessionRow> {
  const { rows } = await db.query<UploadSessionRow>(
    `INSERT INTO upload_sessions
      (workspace_id, meeting_id, filename, mime_type, total_bytes, chunk_size, storage_prefix, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.workspaceId,
      input.meetingId,
      input.filename,
      input.mimeType,
      input.totalBytes,
      input.chunkSize,
      input.storagePrefix,
      input.createdBy,
    ],
  );
  return rows[0];
}

export async function findUploadSession(
  db: Queryable,
  scope: Scope,
  uploadId: string,
): Promise<UploadSessionRow | null> {
  const { rows } = await db.query<UploadSessionRow>(
    `SELECT * FROM upload_sessions WHERE id = $1 AND workspace_id = $2`,
    [uploadId, scope.workspaceId],
  );
  return rows[0] ?? null;
}

/** Idempotent chunk registration: re-uploading a chunk does not double-count. */
export async function registerChunk(
  db: Queryable,
  uploadId: string,
  chunkIndex: number,
  bytes: number,
): Promise<UploadSessionRow | null> {
  const { rows } = await db.query<UploadSessionRow>(
    `UPDATE upload_sessions SET
       received_chunks = CASE WHEN $2 = ANY(received_chunks) THEN received_chunks
                              ELSE array_append(received_chunks, $2) END,
       received_bytes = CASE WHEN $2 = ANY(received_chunks) THEN received_bytes
                             ELSE received_bytes + $3 END,
       updated_at = now()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [uploadId, chunkIndex, bytes],
  );
  return rows[0] ?? null;
}

export async function completeUploadSession(db: Queryable, uploadId: string): Promise<UploadSessionRow | null> {
  const { rows } = await db.query<UploadSessionRow>(
    `UPDATE upload_sessions SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'open' RETURNING *`,
    [uploadId],
  );
  return rows[0] ?? null;
}
