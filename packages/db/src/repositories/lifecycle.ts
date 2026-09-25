import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

// ------------------------------------------------------------ provider calls
export async function recordProviderCall(
  db: Queryable,
  input: {
    workspaceId: string | null;
    jobId?: string | null;
    meetingId?: string | null;
    providerKind: string;
    providerId: string;
    modelVersion?: string | null;
    operation: string;
    latencyMs?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    audioSeconds?: number | null;
    costUsd?: number | null;
    outcome: 'success' | 'failure';
    errorCode?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO provider_calls
       (workspace_id, job_id, meeting_id, provider_kind, provider_id, model_version, operation,
        latency_ms, input_tokens, output_tokens, audio_seconds, cost_usd, outcome, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      input.workspaceId,
      input.jobId ?? null,
      input.meetingId ?? null,
      input.providerKind,
      input.providerId,
      input.modelVersion ?? null,
      input.operation,
      input.latencyMs ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.audioSeconds ?? null,
      input.costUsd ?? null,
      input.outcome,
      input.errorCode ?? null,
    ],
  );
}

export interface CostSummaryRow {
  provider_kind: string;
  provider_id: string;
  calls: string;
  failures: string;
  audio_seconds: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_usd: string | null;
}

export async function costSummary(db: Queryable, scope: Scope, days = 30): Promise<CostSummaryRow[]> {
  const { rows } = await db.query<CostSummaryRow>(
    `SELECT provider_kind, provider_id,
            count(*)::text AS calls,
            count(*) FILTER (WHERE outcome = 'failure')::text AS failures,
            COALESCE(sum(audio_seconds),0)::text AS audio_seconds,
            COALESCE(sum(input_tokens),0)::text AS input_tokens,
            COALESCE(sum(output_tokens),0)::text AS output_tokens,
            COALESCE(sum(cost_usd),0)::text AS cost_usd
       FROM provider_calls
      WHERE workspace_id = $1 AND created_at > now() - make_interval(days => $2)
      GROUP BY provider_kind, provider_id
      ORDER BY cost_usd DESC NULLS LAST`,
    [scope.workspaceId, days],
  );
  return rows;
}

/** Audio minutes consumed this calendar month, for the workspace quota. */
/**
 * Whether `jobId` has already recorded a successful `providerKind` call. The
 * success record is written in the same transaction as the call's results, so
 * `true` means the paid work for this job is done and stored: a re-run of the
 * job (after a crash and lease recovery) must reuse it, not call again.
 */
export async function hasSuccessfulProviderCall(db: Queryable, jobId: string, providerKind: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM provider_calls WHERE job_id = $1 AND provider_kind = $2 AND outcome = 'success' LIMIT 1`,
    [jobId, providerKind],
  );
  return rows.length > 0;
}

export async function audioMinutesThisMonth(db: Queryable, workspaceId: string): Promise<number> {
  const { rows } = await db.query<{ minutes: string }>(
    `SELECT COALESCE(sum(audio_seconds) / 60.0, 0)::text AS minutes
       FROM provider_calls
      WHERE workspace_id = $1 AND provider_kind = 'asr'
        AND created_at >= date_trunc('month', now())`,
    [workspaceId],
  );
  return Number(rows[0]?.minutes ?? 0);
}

// ------------------------------------------------------------------ retention
export interface RetentionCandidate {
  id: string;
  workspace_id: string;
  title: string;
  retention_expires_at: Date;
}

export async function meetingsPastRetention(db: Queryable, limit = 50): Promise<RetentionCandidate[]> {
  const { rows } = await db.query<RetentionCandidate>(
    `SELECT id, workspace_id, title, retention_expires_at
       FROM meetings
      WHERE deleted_at IS NULL
        AND media_purged_at IS NULL
        AND retention_expires_at IS NOT NULL
        AND retention_expires_at < now()
      ORDER BY retention_expires_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface PurgeCounts {
  media: number;
  segments: number;
  summaries: number;
  decisions: number;
  actionItems: number;
  chapters: number;
  embeddings: number;
}

/**
 * Irreversible erasure of a meeting's content.
 *
 * Deletes derived artifacts (segments and their embeddings, summaries,
 * decisions, action items, chapters) and marks media rows purged so the storage
 * objects can be removed by the caller. Accepted tasks survive on purpose —
 * they are work items, not recordings — but lose their transcript pointer.
 */
export async function purgeMeetingContent(db: Queryable, meetingId: string): Promise<PurgeCounts> {
  const counts: PurgeCounts = {
    media: 0,
    segments: 0,
    summaries: 0,
    decisions: 0,
    actionItems: 0,
    chapters: 0,
    embeddings: 0,
  };

  const embedded = await db.query(
    `SELECT count(*)::int AS c FROM transcript_segments WHERE meeting_id = $1 AND embedding IS NOT NULL`,
    [meetingId],
  );
  counts.embeddings = (embedded.rows[0] as { c: number } | undefined)?.c ?? 0;

  await db.query(`UPDATE tasks SET source_segment_id = NULL WHERE source_meeting_id = $1`, [meetingId]);

  counts.segments = (await db.query(`DELETE FROM transcript_segments WHERE meeting_id = $1`, [meetingId])).rowCount ?? 0;
  await db.query(`DELETE FROM transcript_versions WHERE meeting_id = $1`, [meetingId]);
  counts.summaries = (await db.query(`DELETE FROM summaries WHERE meeting_id = $1`, [meetingId])).rowCount ?? 0;
  counts.decisions = (await db.query(`DELETE FROM decisions WHERE meeting_id = $1`, [meetingId])).rowCount ?? 0;
  counts.actionItems = (await db.query(`DELETE FROM action_items WHERE meeting_id = $1`, [meetingId])).rowCount ?? 0;
  counts.chapters = (await db.query(`DELETE FROM chapters WHERE meeting_id = $1`, [meetingId])).rowCount ?? 0;
  counts.media = (await db.query(
    `UPDATE meeting_media SET purged_at = now() WHERE meeting_id = $1 AND purged_at IS NULL`,
    [meetingId],
  )).rowCount ?? 0;

  await db.query(
    `UPDATE meetings SET media_purged_at = now(), updated_at = now() WHERE id = $1`,
    [meetingId],
  );
  return counts;
}

export async function recordDeletion(
  db: Queryable,
  input: {
    workspaceId: string;
    targetType: string;
    targetId: string;
    reason: 'user_request' | 'retention_policy' | 'workspace_deletion';
    requestedBy: string | null;
    artifacts: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO deletion_records (workspace_id, target_type, target_id, reason, requested_by, artifacts)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.workspaceId, input.targetType, input.targetId, input.reason, input.requestedBy, input.artifacts],
  );
}

export async function listDeletions(db: Queryable, scope: Scope, limit = 50): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    `SELECT id, target_type, target_id, reason, artifacts, completed_at
       FROM deletion_records WHERE workspace_id = $1 ORDER BY completed_at DESC LIMIT $2`,
    [scope.workspaceId, Math.min(limit, 200)],
  );
  return rows as Array<Record<string, unknown>>;
}

/** Full workspace export payload, assembled from the caller's own data only. */
export async function exportWorkspace(db: Queryable, scope: Scope): Promise<Record<string, unknown>> {
  const query = async (sql: string) => (await db.query(sql, [scope.workspaceId])).rows;
  return {
    exportedAt: new Date().toISOString(),
    workspaceId: scope.workspaceId,
    workspace: await query(`SELECT * FROM workspaces WHERE id = $1`),
    members: await query(
      `SELECT u.email, u.name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1`,
    ),
    meetings: await query(`SELECT * FROM meetings WHERE workspace_id = $1 AND deleted_at IS NULL`),
    transcript_segments: await query(
      `SELECT id, meeting_id, idx, start_ms, end_ms, speaker_label, text FROM transcript_segments WHERE workspace_id = $1`,
    ),
    summaries: await query(`SELECT * FROM summaries WHERE workspace_id = $1`),
    decisions: await query(`SELECT * FROM decisions WHERE workspace_id = $1`),
    action_items: await query(`SELECT * FROM action_items WHERE workspace_id = $1`),
    tasks: await query(`SELECT * FROM tasks WHERE workspace_id = $1 AND deleted_at IS NULL`),
    people: await query(`SELECT * FROM people WHERE workspace_id = $1 AND deleted_at IS NULL`),
    memory: await query(`SELECT * FROM memory_entries WHERE workspace_id = $1`),
    actions: await query(`SELECT id, type, summary, status, created_at, executed_at FROM actions WHERE workspace_id = $1`),
    deletions: await query(`SELECT * FROM deletion_records WHERE workspace_id = $1`),
  };
}

export async function workspaceSettings(
  db: Queryable,
  workspaceId: string,
): Promise<{
  id: string;
  name: string;
  timezone: string;
  retention_days: number;
  media_retention_days: number | null;
  require_recording_consent: boolean;
  ai_enabled: boolean;
  external_actions_enabled: boolean;
  monthly_audio_minutes_quota: number;
} | null> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    timezone: string;
    retention_days: number;
    media_retention_days: number | null;
    require_recording_consent: boolean;
    ai_enabled: boolean;
    external_actions_enabled: boolean;
    monthly_audio_minutes_quota: number;
  }>(
    `SELECT id, name, timezone, retention_days, media_retention_days, require_recording_consent,
            ai_enabled, external_actions_enabled, monthly_audio_minutes_quota
       FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function updateWorkspaceSettings(
  db: Queryable,
  workspaceId: string,
  patch: {
    retentionDays?: number;
    mediaRetentionDays?: number | null;
    requireRecordingConsent?: boolean;
    aiEnabled?: boolean;
    externalActionsEnabled?: boolean;
    monthlyAudioMinutesQuota?: number;
    timezone?: string;
  },
): Promise<void> {
  await db.query(
    `UPDATE workspaces SET
       retention_days = COALESCE($2, retention_days),
       media_retention_days = COALESCE($3, media_retention_days),
       require_recording_consent = COALESCE($4, require_recording_consent),
       ai_enabled = COALESCE($5, ai_enabled),
       external_actions_enabled = COALESCE($6, external_actions_enabled),
       monthly_audio_minutes_quota = COALESCE($7, monthly_audio_minutes_quota),
       timezone = COALESCE($8, timezone),
       updated_at = now()
     WHERE id = $1`,
    [
      workspaceId,
      patch.retentionDays ?? null,
      patch.mediaRetentionDays ?? null,
      patch.requireRecordingConsent ?? null,
      patch.aiEnabled ?? null,
      patch.externalActionsEnabled ?? null,
      patch.monthlyAudioMinutesQuota ?? null,
      patch.timezone ?? null,
    ],
  );
}

// ----------------------------------------------------------------- metrics
export interface OperationalMetrics {
  jobs: Record<string, number>;
  meetings: Record<string, number>;
  actions: Record<string, number>;
  providerCalls: { success: number; failure: number; costUsd: number };
  oldestQueuedJobSeconds: number;
}

/** Cross-workspace operational counts for monitoring. No content, no names. */
export async function operationalMetrics(db: Queryable): Promise<OperationalMetrics> {
  const grouped = async (sql: string): Promise<Record<string, number>> => {
    const { rows } = await db.query<{ k: string; c: string }>(sql);
    return Object.fromEntries(rows.map((r) => [r.k, Number(r.c)]));
  };

  const providerCalls = await db.query<{ outcome: string; c: string; cost: string }>(
    `SELECT outcome, count(*)::text AS c, COALESCE(sum(cost_usd),0)::text AS cost
       FROM provider_calls WHERE created_at > now() - interval '24 hours' GROUP BY outcome`,
  );
  const oldest = await db.query<{ age: string }>(
    `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(run_after))), 0)::text AS age
       FROM jobs WHERE status = 'queued'`,
  );

  return {
    jobs: await grouped(`SELECT status AS k, count(*)::text AS c FROM jobs GROUP BY status`),
    meetings: await grouped(
      `SELECT status AS k, count(*)::text AS c FROM meetings WHERE deleted_at IS NULL GROUP BY status`,
    ),
    actions: await grouped(`SELECT status AS k, count(*)::text AS c FROM actions GROUP BY status`),
    providerCalls: {
      success: Number(providerCalls.rows.find((r) => r.outcome === 'success')?.c ?? 0),
      failure: Number(providerCalls.rows.find((r) => r.outcome === 'failure')?.c ?? 0),
      costUsd: providerCalls.rows.reduce((sum, r) => sum + Number(r.cost ?? 0), 0),
    },
    oldestQueuedJobSeconds: Math.max(0, Math.round(Number(oldest.rows[0]?.age ?? 0))),
  };
}
