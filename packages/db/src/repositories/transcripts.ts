import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

export interface TranscriptVersionRow {
  id: string;
  meeting_id: string;
  provider_id: string;
  model_version: string;
  language_hint: string;
  is_current: boolean;
  segment_count: number;
  stats: Record<string, unknown>;
  created_at: Date;
}

export interface SegmentRow {
  id: string;
  meeting_id: string;
  version_id: string;
  idx: number;
  start_ms: number;
  end_ms: number;
  speaker_label: string;
  person_id: string | null;
  text: string;
  language: string | null;
  confidence: number | null;
}

export interface SegmentInput {
  idx: number;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  textNormalized: string;
  language?: string | null;
  confidence?: number | null;
}

export async function createTranscriptVersion(
  db: Queryable,
  input: {
    workspaceId: string;
    meetingId: string;
    providerId: string;
    modelVersion: string;
    languageHint: string;
    stats?: Record<string, unknown>;
  },
): Promise<TranscriptVersionRow> {
  await db.query(`UPDATE transcript_versions SET is_current = false WHERE meeting_id = $1`, [input.meetingId]);
  const { rows } = await db.query<TranscriptVersionRow>(
    `INSERT INTO transcript_versions (workspace_id, meeting_id, provider_id, model_version, language_hint, stats)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.workspaceId,
      input.meetingId,
      input.providerId,
      input.modelVersion,
      input.languageHint,
      input.stats ?? {},
    ],
  );
  return rows[0];
}

/** Bulk insert; one statement per 500 segments keeps parameter counts sane. */
export async function insertSegments(
  db: Queryable,
  input: { workspaceId: string; meetingId: string; versionId: string; segments: SegmentInput[] },
): Promise<number> {
  let inserted = 0;
  const batchSize = 500;
  for (let offset = 0; offset < input.segments.length; offset += batchSize) {
    const batch = input.segments.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((segment, i) => {
      const base = i * 10;
      values.push(
        input.workspaceId,
        input.meetingId,
        input.versionId,
        segment.idx,
        segment.startMs,
        segment.endMs,
        segment.speaker,
        segment.text,
        segment.textNormalized,
        segment.confidence ?? null,
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
    });
    const res = await db.query(
      `INSERT INTO transcript_segments
         (workspace_id, meeting_id, version_id, idx, start_ms, end_ms, speaker_label, text, text_normalized, confidence)
       VALUES ${tuples.join(',')}`,
      values,
    );
    inserted += res.rowCount ?? 0;
  }
  await db.query(`UPDATE transcript_versions SET segment_count = $2 WHERE id = $1`, [
    input.versionId,
    input.segments.length,
  ]);
  return inserted;
}

export async function currentTranscriptVersion(
  db: Queryable,
  meetingId: string,
): Promise<TranscriptVersionRow | null> {
  const { rows } = await db.query<TranscriptVersionRow>(
    `SELECT * FROM transcript_versions WHERE meeting_id = $1 AND is_current = true ORDER BY created_at DESC LIMIT 1`,
    [meetingId],
  );
  return rows[0] ?? null;
}

export async function listSegments(
  db: Queryable,
  scope: Scope,
  meetingId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<SegmentRow[]> {
  const { rows } = await db.query<SegmentRow>(
    `SELECT s.id, s.meeting_id, s.version_id, s.idx, s.start_ms, s.end_ms, s.speaker_label,
            s.person_id, s.text, s.language, s.confidence
       FROM transcript_segments s
       JOIN transcript_versions v ON v.id = s.version_id AND v.is_current = true
      WHERE s.meeting_id = $1 AND s.workspace_id = $2
      ORDER BY s.idx ASC
      LIMIT $3 OFFSET $4`,
    [meetingId, scope.workspaceId, options.limit ?? 5000, options.offset ?? 0],
  );
  return rows;
}

export async function listSegmentsForPipeline(db: Queryable, versionId: string): Promise<SegmentRow[]> {
  const { rows } = await db.query<SegmentRow>(
    `SELECT id, meeting_id, version_id, idx, start_ms, end_ms, speaker_label, person_id, text, language, confidence
       FROM transcript_segments WHERE version_id = $1 ORDER BY idx ASC`,
    [versionId],
  );
  return rows;
}

export async function segmentsMissingEmbeddings(
  db: Queryable,
  versionId: string,
  limit = 200,
): Promise<Array<{ id: string; text: string }>> {
  const { rows } = await db.query<{ id: string; text: string }>(
    `SELECT id, text FROM transcript_segments
      WHERE version_id = $1 AND embedding IS NULL AND length(btrim(text)) > 0
      ORDER BY idx ASC LIMIT $2`,
    [versionId, limit],
  );
  return rows;
}

export async function storeEmbeddings(
  db: Queryable,
  rows: Array<{ id: string; vector: number[] }>,
): Promise<number> {
  let updated = 0;
  for (const row of rows) {
    const res = await db.query(`UPDATE transcript_segments SET embedding = $2::vector WHERE id = $1`, [
      row.id,
      JSON.stringify(row.vector),
    ]);
    updated += res.rowCount ?? 0;
  }
  return updated;
}

// ------------------------------------------------------------ people / speakers
export interface PersonRow {
  id: string;
  workspace_id: string;
  display_name: string;
  email: string | null;
  aliases: string[];
  created_at: Date;
}

export async function upsertPerson(
  db: Queryable,
  scope: Scope,
  input: { displayName: string; nameNormalized: string; email?: string | null },
): Promise<PersonRow> {
  const existing = await db.query<PersonRow>(
    `SELECT * FROM people WHERE workspace_id = $1 AND name_normalized = $2 AND deleted_at IS NULL LIMIT 1`,
    [scope.workspaceId, input.nameNormalized],
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await db.query<PersonRow>(
    `INSERT INTO people (workspace_id, display_name, name_normalized, email, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [scope.workspaceId, input.displayName, input.nameNormalized, input.email ?? null, scope.userId],
  );
  return rows[0];
}

export async function listPeople(db: Queryable, scope: Scope): Promise<PersonRow[]> {
  const { rows } = await db.query<PersonRow>(
    `SELECT * FROM people WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY display_name ASC`,
    [scope.workspaceId],
  );
  return rows;
}

/**
 * Bind a diarized label to a real person for one meeting, and apply it to that
 * meeting's segments. The raw provider label is preserved in speaker_label.
 */
export async function assignSpeaker(
  db: Queryable,
  scope: Scope,
  input: { meetingId: string; speakerLabel: string; personId: string },
): Promise<number> {
  await db.query(
    `INSERT INTO speaker_map (workspace_id, meeting_id, speaker_label, person_id, confirmed_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (meeting_id, speaker_label)
     DO UPDATE SET person_id = EXCLUDED.person_id, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
    [scope.workspaceId, input.meetingId, input.speakerLabel, input.personId, scope.userId],
  );
  const res = await db.query(
    `UPDATE transcript_segments SET person_id = $3
      WHERE meeting_id = $1 AND speaker_label = $2 AND workspace_id = $4`,
    [input.meetingId, input.speakerLabel, input.personId, scope.workspaceId],
  );
  return res.rowCount ?? 0;
}

export async function listSpeakerMap(
  db: Queryable,
  meetingId: string,
): Promise<Array<{ speaker_label: string; person_id: string; display_name: string }>> {
  const { rows } = await db.query<{ speaker_label: string; person_id: string; display_name: string }>(
    `SELECT sm.speaker_label, sm.person_id, p.display_name
       FROM speaker_map sm JOIN people p ON p.id = sm.person_id
      WHERE sm.meeting_id = $1 ORDER BY sm.speaker_label`,
    [meetingId],
  );
  return rows;
}

export async function distinctSpeakers(db: Queryable, meetingId: string): Promise<string[]> {
  const { rows } = await db.query<{ speaker_label: string }>(
    `SELECT DISTINCT speaker_label FROM transcript_segments WHERE meeting_id = $1 ORDER BY speaker_label`,
    [meetingId],
  );
  return rows.map((r) => r.speaker_label);
}
