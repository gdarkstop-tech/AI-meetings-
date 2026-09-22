import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

export interface ResearchRequestRow {
  id: string;
  workspace_id: string;
  question: string;
  origin_meeting_id: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  failure_reason: string | null;
  requested_by: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface ResearchSourceRow {
  id: string;
  request_id: string;
  url: string;
  title: string | null;
  publisher: string | null;
  snippet: string | null;
  content_hash: string | null;
  retrieved_at: Date;
}

export interface ResearchReportRow {
  id: string;
  request_id: string;
  findings: Array<Record<string, unknown>>;
  report_md: string;
  provider_id: string;
  model_version: string;
  generated_at: Date;
}

export async function createResearchRequest(
  db: Queryable,
  scope: Scope,
  input: { question: string; originMeetingId?: string | null; originSegmentId?: string | null },
): Promise<ResearchRequestRow> {
  const { rows } = await db.query<ResearchRequestRow>(
    `INSERT INTO research_requests (workspace_id, question, origin_meeting_id, origin_segment_id, requested_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [scope.workspaceId, input.question, input.originMeetingId ?? null, input.originSegmentId ?? null, scope.userId],
  );
  return rows[0];
}

export async function listResearchRequests(db: Queryable, scope: Scope): Promise<ResearchRequestRow[]> {
  const { rows } = await db.query<ResearchRequestRow>(
    `SELECT * FROM research_requests WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [scope.workspaceId],
  );
  return rows;
}

export async function findResearchRequest(
  db: Queryable,
  scope: Scope,
  id: string,
): Promise<ResearchRequestRow | null> {
  const { rows } = await db.query<ResearchRequestRow>(
    `SELECT * FROM research_requests WHERE id = $1 AND workspace_id = $2`,
    [id, scope.workspaceId],
  );
  return rows[0] ?? null;
}

export async function findResearchRequestUnscoped(db: Queryable, id: string): Promise<ResearchRequestRow | null> {
  const { rows } = await db.query<ResearchRequestRow>(`SELECT * FROM research_requests WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function setResearchStatus(
  db: Queryable,
  id: string,
  status: 'running' | 'completed' | 'failed',
  failureReason?: string | null,
): Promise<void> {
  await db.query(
    `UPDATE research_requests
        SET status = $2, failure_reason = $3,
            completed_at = CASE WHEN $2 IN ('completed','failed') THEN now() ELSE completed_at END
      WHERE id = $1`,
    [id, status, failureReason ?? null],
  );
}

/** Sources are stored with their URL and retrieval time — provenance, not vibes. */
export async function insertResearchSources(
  db: Queryable,
  input: {
    workspaceId: string;
    requestId: string;
    sources: Array<{ url: string; title?: string | null; publisher?: string | null; snippet?: string | null; contentHash?: string | null }>;
  },
): Promise<ResearchSourceRow[]> {
  const out: ResearchSourceRow[] = [];
  for (const source of input.sources) {
    const { rows } = await db.query<ResearchSourceRow>(
      `INSERT INTO research_sources (workspace_id, request_id, url, title, publisher, snippet, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.workspaceId,
        input.requestId,
        source.url,
        source.title ?? null,
        source.publisher ?? null,
        source.snippet ?? null,
        source.contentHash ?? null,
      ],
    );
    out.push(rows[0]);
  }
  return out;
}

export async function listResearchSources(db: Queryable, requestId: string): Promise<ResearchSourceRow[]> {
  const { rows } = await db.query<ResearchSourceRow>(
    `SELECT * FROM research_sources WHERE request_id = $1 ORDER BY retrieved_at ASC`,
    [requestId],
  );
  return rows;
}

export async function saveResearchReport(
  db: Queryable,
  input: {
    workspaceId: string;
    requestId: string;
    findings: Array<Record<string, unknown>>;
    reportMd: string;
    providerId: string;
    modelVersion: string;
  },
): Promise<ResearchReportRow> {
  const { rows } = await db.query<ResearchReportRow>(
    `INSERT INTO research_reports (workspace_id, request_id, findings, report_md, provider_id, model_version)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.workspaceId,
      input.requestId,
      JSON.stringify(input.findings),
      input.reportMd,
      input.providerId,
      input.modelVersion,
    ],
  );
  return rows[0];
}

export async function findResearchReport(db: Queryable, requestId: string): Promise<ResearchReportRow | null> {
  const { rows } = await db.query<ResearchReportRow>(
    `SELECT * FROM research_reports WHERE request_id = $1 ORDER BY generated_at DESC LIMIT 1`,
    [requestId],
  );
  return rows[0] ?? null;
}
