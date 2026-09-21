import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

// ------------------------------------------------------------------ summaries
export interface SummaryRow {
  id: string;
  meeting_id: string;
  kind: 'tldr' | 'executive' | 'detailed';
  content: Record<string, unknown>;
  output_language: string;
  provider_id: string;
  model_version: string;
  prompt_version: string;
  generated_at: Date;
}

export async function replaceSummary(
  db: Queryable,
  input: {
    workspaceId: string;
    meetingId: string;
    kind: 'tldr' | 'executive' | 'detailed';
    content: Record<string, unknown>;
    outputLanguage: string;
    providerId: string;
    modelVersion: string;
    promptVersion: string;
  },
): Promise<SummaryRow> {
  const { rows } = await db.query<SummaryRow>(
    `INSERT INTO summaries
       (workspace_id, meeting_id, kind, content, output_language, provider_id, model_version, prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.workspaceId,
      input.meetingId,
      input.kind,
      input.content,
      input.outputLanguage,
      input.providerId,
      input.modelVersion,
      input.promptVersion,
    ],
  );
  // Previous versions are superseded, never overwritten or deleted.
  await db.query(
    `UPDATE summaries SET superseded_by = $1
      WHERE meeting_id = $2 AND kind = $3 AND id <> $1 AND superseded_by IS NULL`,
    [rows[0].id, input.meetingId, input.kind],
  );
  return rows[0];
}

export async function listSummaries(db: Queryable, scope: Scope, meetingId: string): Promise<SummaryRow[]> {
  const { rows } = await db.query<SummaryRow>(
    `SELECT * FROM summaries
      WHERE meeting_id = $1 AND workspace_id = $2 AND superseded_by IS NULL
      ORDER BY CASE kind WHEN 'tldr' THEN 0 WHEN 'executive' THEN 1 ELSE 2 END`,
    [meetingId, scope.workspaceId],
  );
  return rows;
}

// ------------------------------------------------------------------ decisions
export interface DecisionRow {
  id: string;
  meeting_id: string;
  text: string;
  owner_hint: string | null;
  owner_person_id: string | null;
  decided_on: Date | null;
  context: string | null;
  evidence_segment_ids: string[];
  start_ms: number;
  confidence: 'low' | 'medium' | 'high';
  status: 'suggested' | 'accepted' | 'rejected' | 'edited';
  created_at: Date;
}

export async function insertDecisions(
  db: Queryable,
  input: {
    workspaceId: string;
    meetingId: string;
    providerId: string;
    modelVersion: string;
    promptVersion: string;
    items: Array<{
      text: string;
      textNormalized: string;
      ownerHint?: string | null;
      decidedOn?: string | null;
      context?: string | null;
      evidenceSegmentIds: string[];
      startMs: number;
      confidence: 'low' | 'medium' | 'high';
    }>;
  },
): Promise<DecisionRow[]> {
  const out: DecisionRow[] = [];
  for (const item of input.items) {
    const { rows } = await db.query<DecisionRow>(
      `INSERT INTO decisions
         (workspace_id, meeting_id, text, text_normalized, owner_hint, decided_on, context,
          evidence_segment_ids, start_ms, confidence, provider_id, model_version, prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        input.workspaceId,
        input.meetingId,
        item.text,
        item.textNormalized,
        item.ownerHint ?? null,
        item.decidedOn ?? null,
        item.context ?? null,
        item.evidenceSegmentIds,
        item.startMs,
        item.confidence,
        input.providerId,
        input.modelVersion,
        input.promptVersion,
      ],
    );
    out.push(rows[0]);
  }
  return out;
}

export async function listDecisions(
  db: Queryable,
  scope: Scope,
  filters: { meetingId?: string; status?: string; limit?: number } = {},
): Promise<DecisionRow[]> {
  const { rows } = await db.query<DecisionRow>(
    `SELECT * FROM decisions
      WHERE workspace_id = $1
        AND ($2::uuid IS NULL OR meeting_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC, start_ms ASC
      LIMIT $4`,
    [scope.workspaceId, filters.meetingId ?? null, filters.status ?? null, Math.min(filters.limit ?? 100, 500)],
  );
  return rows;
}

export async function reviewDecision(
  db: Queryable,
  scope: Scope,
  decisionId: string,
  input: { status: 'accepted' | 'rejected' | 'edited'; text?: string; textNormalized?: string; ownerPersonId?: string | null },
): Promise<DecisionRow | null> {
  const { rows } = await db.query<DecisionRow>(
    `UPDATE decisions SET
       status = $3,
       text = COALESCE($4, text),
       text_normalized = COALESCE($5, text_normalized),
       owner_person_id = COALESCE($6, owner_person_id),
       reviewed_by = $7, reviewed_at = now()
     WHERE id = $1 AND workspace_id = $2
     RETURNING *`,
    [
      decisionId,
      scope.workspaceId,
      input.status,
      input.text ?? null,
      input.textNormalized ?? null,
      input.ownerPersonId ?? null,
      scope.userId,
    ],
  );
  return rows[0] ?? null;
}

// --------------------------------------------------------------- action items
export interface ActionItemRow {
  id: string;
  meeting_id: string;
  title: string;
  description: string | null;
  assignee_hint: string | null;
  assignee_person_id: string | null;
  due_at: Date | null;
  due_source_text: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  evidence_segment_ids: string[];
  start_ms: number;
  confidence: 'low' | 'medium' | 'high';
  status: 'suggested' | 'accepted' | 'rejected';
  task_id: string | null;
  created_at: Date;
}

export async function insertActionItems(
  db: Queryable,
  input: {
    workspaceId: string;
    meetingId: string;
    providerId: string;
    modelVersion: string;
    promptVersion: string;
    items: Array<{
      title: string;
      titleNormalized: string;
      description?: string | null;
      assigneeHint?: string | null;
      dueAt?: Date | null;
      dueSourceText?: string | null;
      priority: 'low' | 'normal' | 'high' | 'urgent';
      evidenceSegmentIds: string[];
      startMs: number;
      confidence: 'low' | 'medium' | 'high';
    }>;
  },
): Promise<ActionItemRow[]> {
  const out: ActionItemRow[] = [];
  for (const item of input.items) {
    const { rows } = await db.query<ActionItemRow>(
      `INSERT INTO action_items
         (workspace_id, meeting_id, title, title_normalized, description, assignee_hint, due_at,
          due_source_text, priority, evidence_segment_ids, start_ms, confidence,
          provider_id, model_version, prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        input.workspaceId,
        input.meetingId,
        item.title,
        item.titleNormalized,
        item.description ?? null,
        item.assigneeHint ?? null,
        item.dueAt ?? null,
        item.dueSourceText ?? null,
        item.priority,
        item.evidenceSegmentIds,
        item.startMs,
        item.confidence,
        input.providerId,
        input.modelVersion,
        input.promptVersion,
      ],
    );
    out.push(rows[0]);
  }
  return out;
}

export async function listActionItems(
  db: Queryable,
  scope: Scope,
  filters: { meetingId?: string; status?: string; limit?: number } = {},
): Promise<ActionItemRow[]> {
  const { rows } = await db.query<ActionItemRow>(
    `SELECT * FROM action_items
      WHERE workspace_id = $1
        AND ($2::uuid IS NULL OR meeting_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY start_ms ASC LIMIT $4`,
    [scope.workspaceId, filters.meetingId ?? null, filters.status ?? null, Math.min(filters.limit ?? 200, 500)],
  );
  return rows;
}

export async function findActionItem(db: Queryable, scope: Scope, id: string): Promise<ActionItemRow | null> {
  const { rows } = await db.query<ActionItemRow>(
    `SELECT * FROM action_items WHERE id = $1 AND workspace_id = $2`,
    [id, scope.workspaceId],
  );
  return rows[0] ?? null;
}

export async function markActionItemReviewed(
  db: Queryable,
  scope: Scope,
  id: string,
  input: { status: 'accepted' | 'rejected'; taskId?: string | null },
): Promise<ActionItemRow | null> {
  const { rows } = await db.query<ActionItemRow>(
    `UPDATE action_items SET status = $3, task_id = COALESCE($4, task_id), reviewed_by = $5, reviewed_at = now()
      WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [id, scope.workspaceId, input.status, input.taskId ?? null, scope.userId],
  );
  return rows[0] ?? null;
}

// -------------------------------------------------------------------- chapters
export async function replaceChapters(
  db: Queryable,
  input: {
    workspaceId: string;
    meetingId: string;
    chapters: Array<{ title: string; startMs: number; endMs: number; evidenceSegmentIds: string[] }>;
  },
): Promise<number> {
  await db.query(`DELETE FROM chapters WHERE meeting_id = $1`, [input.meetingId]);
  let count = 0;
  for (const chapter of input.chapters) {
    await db.query(
      `INSERT INTO chapters (workspace_id, meeting_id, title, start_ms, end_ms, evidence_segment_ids)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        input.workspaceId,
        input.meetingId,
        chapter.title,
        chapter.startMs,
        chapter.endMs,
        chapter.evidenceSegmentIds,
      ],
    );
    count += 1;
  }
  return count;
}

export async function listChapters(
  db: Queryable,
  scope: Scope,
  meetingId: string,
): Promise<Array<{ id: string; title: string; start_ms: number; end_ms: number }>> {
  const { rows } = await db.query<{ id: string; title: string; start_ms: number; end_ms: number }>(
    `SELECT id, title, start_ms, end_ms FROM chapters
      WHERE meeting_id = $1 AND workspace_id = $2 ORDER BY start_ms ASC`,
    [meetingId, scope.workspaceId],
  );
  return rows;
}

// ----------------------------------------------------------------------- tasks
export interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  assignee_user_id: string | null;
  assignee_person_id: string | null;
  due_at: Date | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  source_type: 'manual' | 'meeting' | 'email' | 'ai';
  source_meeting_id: string | null;
  source_segment_id: string | null;
  source_action_item_id: string | null;
  completed_at: Date | null;
  created_at: Date;
}

export async function createTask(
  db: Queryable,
  scope: Scope,
  input: {
    title: string;
    titleNormalized: string;
    description?: string | null;
    assigneeUserId?: string | null;
    assigneePersonId?: string | null;
    dueAt?: Date | null;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    sourceType?: 'manual' | 'meeting' | 'email' | 'ai';
    sourceMeetingId?: string | null;
    sourceSegmentId?: string | null;
    sourceActionItemId?: string | null;
  },
): Promise<TaskRow> {
  const { rows } = await db.query<TaskRow>(
    `INSERT INTO tasks
       (workspace_id, title, title_normalized, description, assignee_user_id, assignee_person_id,
        due_at, priority, source_type, source_meeting_id, source_segment_id, source_action_item_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      scope.workspaceId,
      input.title,
      input.titleNormalized,
      input.description ?? null,
      input.assigneeUserId ?? null,
      input.assigneePersonId ?? null,
      input.dueAt ?? null,
      input.priority ?? 'normal',
      input.sourceType ?? 'manual',
      input.sourceMeetingId ?? null,
      input.sourceSegmentId ?? null,
      input.sourceActionItemId ?? null,
      scope.userId,
    ],
  );
  return rows[0];
}

export async function listTasks(
  db: Queryable,
  scope: Scope,
  filters: { view?: 'inbox' | 'today' | 'upcoming' | 'overdue' | 'completed' | 'mine'; status?: string; meetingId?: string } = {},
): Promise<TaskRow[]> {
  const { rows } = await db.query<TaskRow>(
    `SELECT * FROM tasks
      WHERE workspace_id = $1 AND deleted_at IS NULL
        AND ($2::text IS NULL OR status = $2)
        AND ($3::uuid IS NULL OR source_meeting_id = $3)
        AND CASE $4::text
              WHEN 'today' THEN due_at IS NOT NULL AND due_at::date = (now() AT TIME ZONE 'UTC')::date AND status <> 'DONE'
              WHEN 'upcoming' THEN due_at IS NOT NULL AND due_at > now() AND status <> 'DONE'
              WHEN 'overdue' THEN due_at IS NOT NULL AND due_at < now() AND status NOT IN ('DONE','CANCELLED')
              WHEN 'completed' THEN status = 'DONE'
              WHEN 'mine' THEN assignee_user_id = $5::uuid AND status <> 'DONE'
              WHEN 'inbox' THEN status = 'TODO'
              ELSE true
            END
      ORDER BY (due_at IS NULL), due_at ASC, created_at DESC
      LIMIT 300`,
    [scope.workspaceId, filters.status ?? null, filters.meetingId ?? null, filters.view ?? null, scope.userId],
  );
  return rows;
}

export async function updateTask(
  db: Queryable,
  scope: Scope,
  taskId: string,
  patch: {
    title?: string;
    titleNormalized?: string;
    description?: string | null;
    status?: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    dueAt?: Date | null;
    assigneeUserId?: string | null;
  },
): Promise<TaskRow | null> {
  const { rows } = await db.query<TaskRow>(
    `UPDATE tasks SET
       title = COALESCE($3, title),
       title_normalized = COALESCE($4, title_normalized),
       description = COALESCE($5, description),
       status = COALESCE($6, status),
       priority = COALESCE($7, priority),
       due_at = COALESCE($8, due_at),
       assignee_user_id = COALESCE($9, assignee_user_id),
       completed_at = CASE WHEN $6 = 'DONE' THEN now() WHEN $6 IS NOT NULL THEN NULL ELSE completed_at END,
       updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [
      taskId,
      scope.workspaceId,
      patch.title ?? null,
      patch.titleNormalized ?? null,
      patch.description ?? null,
      patch.status ?? null,
      patch.priority ?? null,
      patch.dueAt ?? null,
      patch.assigneeUserId ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function taskCounts(db: Queryable, scope: Scope): Promise<Record<string, number>> {
  const { rows } = await db.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM tasks
      WHERE workspace_id = $1 AND deleted_at IS NULL GROUP BY status`,
    [scope.workspaceId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}
