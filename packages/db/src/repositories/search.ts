import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

/**
 * Search is permission-filtered in SQL: every query is bound to the caller's
 * workspace, and the fusion step upstream never widens that set.
 *
 * Arabic text is matched through `text_normalized`, written by the application
 * with normalizeForSearch() — which is why "الموقع" and "الموقـع" both hit.
 */
export type SearchHitType = 'segment' | 'decision' | 'action_item' | 'task' | 'meeting' | 'person';

export interface SearchHit {
  type: SearchHitType;
  id: string;
  meeting_id: string | null;
  meeting_title: string | null;
  title: string;
  snippet: string;
  start_ms: number | null;
  occurred_at: Date | null;
  rank: number;
}

export async function lexicalSearch(
  db: Queryable,
  scope: Scope,
  input: { normalizedQuery: string; types?: SearchHitType[]; limit?: number },
): Promise<SearchHit[]> {
  const limit = Math.min(input.limit ?? 40, 100);
  const types = input.types ?? ['segment', 'decision', 'action_item', 'task', 'meeting', 'person'];
  const { rows } = await db.query<SearchHit>(
    `WITH q AS (
       SELECT websearch_to_tsquery('simple', $2) AS tsq, $2::text AS raw
     )
     SELECT * FROM (
       SELECT 'segment'::text AS type, s.id, s.meeting_id, m.title AS meeting_title,
              COALESCE(sm_person.display_name, s.speaker_label) AS title,
              s.text AS snippet, s.start_ms,
              COALESCE(m.started_at, m.created_at) AS occurred_at,
              ts_rank(s.tsv, q.tsq) + similarity(s.text_normalized, q.raw) * 0.3 AS rank
         FROM transcript_segments s
         JOIN q ON true
         JOIN meetings m ON m.id = s.meeting_id AND m.deleted_at IS NULL
         LEFT JOIN people sm_person ON sm_person.id = s.person_id
        WHERE s.workspace_id = $1 AND 'segment' = ANY($3)
          AND (s.tsv @@ q.tsq OR s.text_normalized % q.raw)

       UNION ALL
       SELECT 'decision', d.id, d.meeting_id, m.title, 'decision', d.text, d.start_ms,
              d.created_at, ts_rank(d.tsv, q.tsq) + similarity(d.text_normalized, q.raw) * 0.3
         FROM decisions d JOIN q ON true
         JOIN meetings m ON m.id = d.meeting_id AND m.deleted_at IS NULL
        WHERE d.workspace_id = $1 AND 'decision' = ANY($3)
          AND (d.tsv @@ q.tsq OR d.text_normalized % q.raw)

       UNION ALL
       SELECT 'action_item', a.id, a.meeting_id, m.title, 'action item', a.title, a.start_ms,
              a.created_at, ts_rank(a.tsv, q.tsq) + similarity(a.title_normalized, q.raw) * 0.3
         FROM action_items a JOIN q ON true
         JOIN meetings m ON m.id = a.meeting_id AND m.deleted_at IS NULL
        WHERE a.workspace_id = $1 AND 'action_item' = ANY($3)
          AND (a.tsv @@ q.tsq OR a.title_normalized % q.raw)

       UNION ALL
       SELECT 'task', t.id, t.source_meeting_id, NULL, 'task', t.title, NULL,
              t.created_at, ts_rank(t.tsv, q.tsq) + similarity(t.title_normalized, q.raw) * 0.3
         FROM tasks t JOIN q ON true
        WHERE t.workspace_id = $1 AND t.deleted_at IS NULL AND 'task' = ANY($3)
          AND (t.tsv @@ q.tsq OR t.title_normalized % q.raw)

       UNION ALL
       SELECT 'meeting', m.id, m.id, m.title, 'meeting', m.title, NULL,
              COALESCE(m.started_at, m.created_at), similarity(m.title_normalized, q.raw)
         FROM meetings m JOIN q ON true
        WHERE m.workspace_id = $1 AND m.deleted_at IS NULL AND 'meeting' = ANY($3)
          AND m.title_normalized % q.raw

       UNION ALL
       SELECT 'person', p.id, NULL, NULL, 'person', p.display_name, NULL,
              p.created_at, similarity(p.name_normalized, q.raw)
         FROM people p JOIN q ON true
        WHERE p.workspace_id = $1 AND p.deleted_at IS NULL AND 'person' = ANY($3)
          AND p.name_normalized % q.raw
     ) hits
     WHERE rank > 0
     ORDER BY rank DESC
     LIMIT $4`,
    [scope.workspaceId, input.normalizedQuery, types, limit],
  );
  return rows;
}

export interface VectorHit {
  id: string;
  meeting_id: string;
  meeting_title: string;
  speaker: string;
  text: string;
  start_ms: number;
  occurred_at: Date | null;
  distance: number;
}

export async function vectorSearch(
  db: Queryable,
  scope: Scope,
  input: { embedding: number[]; limit?: number; meetingIds?: string[] },
): Promise<VectorHit[]> {
  const { rows } = await db.query<VectorHit>(
    `SELECT s.id, s.meeting_id, m.title AS meeting_title,
            COALESCE(p.display_name, s.speaker_label) AS speaker,
            s.text, s.start_ms, COALESCE(m.started_at, m.created_at) AS occurred_at,
            (s.embedding <=> $2::vector) AS distance
       FROM transcript_segments s
       JOIN meetings m ON m.id = s.meeting_id AND m.deleted_at IS NULL
       LEFT JOIN people p ON p.id = s.person_id
      WHERE s.workspace_id = $1
        AND s.embedding IS NOT NULL
        AND ($4::uuid[] IS NULL OR s.meeting_id = ANY($4))
      ORDER BY s.embedding <=> $2::vector
      LIMIT $3`,
    [scope.workspaceId, JSON.stringify(input.embedding), Math.min(input.limit ?? 30, 100), input.meetingIds ?? null],
  );
  return rows;
}

/** Lexical retrieval restricted to a segment corpus, used by RAG when no embeddings exist. */
export async function segmentLexicalSearch(
  db: Queryable,
  scope: Scope,
  input: { normalizedQuery: string; limit?: number; meetingIds?: string[] },
): Promise<VectorHit[]> {
  const { rows } = await db.query<VectorHit>(
    `WITH q AS (SELECT websearch_to_tsquery('simple', $2) AS tsq, $2::text AS raw)
     SELECT s.id, s.meeting_id, m.title AS meeting_title,
            COALESCE(p.display_name, s.speaker_label) AS speaker,
            s.text, s.start_ms, COALESCE(m.started_at, m.created_at) AS occurred_at,
            (1 - (ts_rank(s.tsv, q.tsq) + similarity(s.text_normalized, q.raw) * 0.3)) AS distance
       FROM transcript_segments s
       JOIN q ON true
       JOIN meetings m ON m.id = s.meeting_id AND m.deleted_at IS NULL
       LEFT JOIN people p ON p.id = s.person_id
      WHERE s.workspace_id = $1
        AND ($4::uuid[] IS NULL OR s.meeting_id = ANY($4))
        AND (s.tsv @@ q.tsq OR s.text_normalized % q.raw)
      ORDER BY (ts_rank(s.tsv, q.tsq) + similarity(s.text_normalized, q.raw) * 0.3) DESC
      LIMIT $3`,
    [scope.workspaceId, input.normalizedQuery, Math.min(input.limit ?? 30, 100), input.meetingIds ?? null],
  );
  return rows;
}

export async function segmentsByIds(
  db: Queryable,
  scope: Scope,
  ids: string[],
): Promise<Array<{ id: string; meeting_id: string; start_ms: number; end_ms: number; text: string; speaker_label: string }>> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    meeting_id: string;
    start_ms: number;
    end_ms: number;
    text: string;
    speaker_label: string;
  }>(
    `SELECT id, meeting_id, start_ms, end_ms, text, speaker_label
       FROM transcript_segments WHERE workspace_id = $1 AND id = ANY($2)`,
    [scope.workspaceId, ids],
  );
  return rows;
}
