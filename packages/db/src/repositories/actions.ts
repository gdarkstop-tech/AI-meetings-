import type { Queryable } from '../client.js';
import type { Scope } from '@alia/core';

export type ActionStatus = 'proposed' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed';

export interface ActionRow {
  id: string;
  workspace_id: string;
  type: string;
  payload: Record<string, unknown>;
  payload_digest: string;
  summary: string;
  requested_by: string | null;
  requested_via: 'ui' | 'ai';
  source_meeting_id: string | null;
  status: ActionStatus;
  policy_reason: string | null;
  requires_approval: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_reason: string | null;
  idempotency_key: string;
  provider_id: string | null;
  provider_response_id: string | null;
  dry_run: boolean;
  error: string | null;
  created_at: Date;
  executed_at: Date | null;
}

export async function proposeAction(
  db: Queryable,
  input: {
    workspaceId: string;
    type: string;
    payload: Record<string, unknown>;
    payloadDigest: string;
    summary: string;
    requestedBy: string | null;
    requestedVia: 'ui' | 'ai';
    requiresApproval: boolean;
    policyReason: string;
    idempotencyKey: string;
    sourceMeetingId?: string | null;
    dryRun: boolean;
  },
): Promise<ActionRow> {
  const { rows } = await db.query<ActionRow>(
    `INSERT INTO actions
       (workspace_id, type, payload, payload_digest, summary, requested_by, requested_via,
        requires_approval, policy_reason, idempotency_key, source_meeting_id, dry_run)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [
      input.workspaceId,
      input.type,
      input.payload,
      input.payloadDigest,
      input.summary,
      input.requestedBy,
      input.requestedVia,
      input.requiresApproval,
      input.policyReason,
      input.idempotencyKey,
      input.sourceMeetingId ?? null,
      input.dryRun,
    ],
  );
  return rows[0];
}

export async function listActions(
  db: Queryable,
  scope: Scope,
  filters: { status?: ActionStatus; limit?: number } = {},
): Promise<ActionRow[]> {
  const { rows } = await db.query<ActionRow>(
    `SELECT * FROM actions
      WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [scope.workspaceId, filters.status ?? null, Math.min(filters.limit ?? 50, 200)],
  );
  return rows;
}

export async function findAction(db: Queryable, scope: Scope, id: string): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(`SELECT * FROM actions WHERE id = $1 AND workspace_id = $2`, [
    id,
    scope.workspaceId,
  ]);
  return rows[0] ?? null;
}

/**
 * Approval binds the exact payload digest that was shown to the approver.
 * If the payload changed since, the update matches no row and approval fails.
 */
export async function approveAction(
  db: Queryable,
  scope: Scope,
  id: string,
  payloadDigest: string,
): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE actions SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status = 'proposed' AND payload_digest = $4
      RETURNING *`,
    [id, scope.workspaceId, scope.userId, payloadDigest],
  );
  return rows[0] ?? null;
}

export async function rejectAction(
  db: Queryable,
  scope: Scope,
  id: string,
  reason: string,
): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE actions SET status = 'rejected', rejected_reason = $3, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status IN ('proposed','approved') RETURNING *`,
    [id, scope.workspaceId, reason],
  );
  return rows[0] ?? null;
}

/** Claim for execution: only one worker can move an action out of `approved`. */
export async function claimActionForExecution(db: Queryable, id: string): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE actions SET status = 'executing', updated_at = now()
      WHERE id = $1 AND status = 'approved' RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

export async function completeAction(
  db: Queryable,
  id: string,
  input: { providerId: string | null; providerResponseId: string | null },
): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE actions SET status = 'executed', provider_id = $2, provider_response_id = $3,
            executed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'executing' RETURNING *`,
    [id, input.providerId, input.providerResponseId],
  );
  return rows[0] ?? null;
}

export async function failAction(db: Queryable, id: string, error: string): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE actions SET status = 'failed', error = $2, updated_at = now()
      WHERE id = $1 AND status IN ('executing','approved') RETURNING *`,
    [id, error.slice(0, 1000)],
  );
  return rows[0] ?? null;
}

// --------------------------------------------------------------- integrations
export interface IntegrationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: 'google' | 'microsoft';
  scopes: string[];
  external_account_email: string | null;
  status: 'connected' | 'expired' | 'revoked' | 'error';
  token_ciphertext: string;
  token_expires_at: Date | null;
  last_error: string | null;
  connected_at: Date;
}

export async function upsertIntegration(
  db: Queryable,
  input: {
    workspaceId: string;
    userId: string;
    kind: 'google' | 'microsoft';
    scopes: string[];
    tokenCiphertext: string;
    tokenExpiresAt: Date | null;
    externalAccountEmail: string | null;
  },
): Promise<IntegrationRow> {
  const { rows } = await db.query<IntegrationRow>(
    `INSERT INTO integrations
       (workspace_id, user_id, kind, scopes, token_ciphertext, token_expires_at, external_account_email, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'connected')
     ON CONFLICT (workspace_id, user_id, kind) DO UPDATE SET
       scopes = EXCLUDED.scopes,
       token_ciphertext = EXCLUDED.token_ciphertext,
       token_expires_at = EXCLUDED.token_expires_at,
       external_account_email = EXCLUDED.external_account_email,
       status = 'connected', last_error = NULL, updated_at = now()
     RETURNING *`,
    [
      input.workspaceId,
      input.userId,
      input.kind,
      input.scopes,
      input.tokenCiphertext,
      input.tokenExpiresAt,
      input.externalAccountEmail,
    ],
  );
  return rows[0];
}

export async function findIntegration(
  db: Queryable,
  input: { workspaceId: string; userId: string; kind: 'google' | 'microsoft' },
): Promise<IntegrationRow | null> {
  const { rows } = await db.query<IntegrationRow>(
    `SELECT * FROM integrations WHERE workspace_id = $1 AND user_id = $2 AND kind = $3`,
    [input.workspaceId, input.userId, input.kind],
  );
  return rows[0] ?? null;
}

/** Never returns token material: this is what the UI is allowed to see. */
export async function listIntegrationsSafe(
  db: Queryable,
  scope: Scope,
): Promise<Array<{ kind: string; status: string; scopes: string[]; external_account_email: string | null; connected_at: Date; user_id: string }>> {
  const { rows } = await db.query<{
    kind: string;
    status: string;
    scopes: string[];
    external_account_email: string | null;
    connected_at: Date;
    user_id: string;
  }>(
    `SELECT kind, status, scopes, external_account_email, connected_at, user_id
       FROM integrations WHERE workspace_id = $1 ORDER BY kind`,
    [scope.workspaceId],
  );
  return rows;
}

export async function updateIntegrationTokens(
  db: Queryable,
  id: string,
  input: { tokenCiphertext: string; tokenExpiresAt: Date | null },
): Promise<void> {
  await db.query(
    `UPDATE integrations SET token_ciphertext = $2, token_expires_at = $3,
            last_refreshed_at = now(), status = 'connected', updated_at = now()
      WHERE id = $1`,
    [id, input.tokenCiphertext, input.tokenExpiresAt],
  );
}

export async function markIntegrationError(db: Queryable, id: string, error: string): Promise<void> {
  await db.query(`UPDATE integrations SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [
    id,
    error.slice(0, 500),
  ]);
}

export async function deleteIntegration(
  db: Queryable,
  input: { workspaceId: string; userId: string; kind: string },
): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM integrations WHERE workspace_id = $1 AND user_id = $2 AND kind = $3`,
    [input.workspaceId, input.userId, input.kind],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function saveOAuthState(
  db: Queryable,
  input: {
    state: string;
    workspaceId: string;
    userId: string;
    kind: string;
    scopes: string[];
    ttlSeconds: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_states (state, workspace_id, user_id, kind, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))`,
    [input.state, input.workspaceId, input.userId, input.kind, input.scopes, input.ttlSeconds],
  );
}

export async function consumeOAuthState(
  db: Queryable,
  state: string,
): Promise<{ workspace_id: string; user_id: string; kind: string; scopes: string[] } | null> {
  const { rows } = await db.query<{ workspace_id: string; user_id: string; kind: string; scopes: string[] }>(
    `DELETE FROM oauth_states WHERE state = $1 AND expires_at > now()
      RETURNING workspace_id, user_id, kind, scopes`,
    [state],
  );
  return rows[0] ?? null;
}
