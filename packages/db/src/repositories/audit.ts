import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type ActorType = 'user' | 'ai' | 'system';
export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditInput {
  workspaceId: string | null;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Arbitrary payload; only its digest is stored, never the payload itself. */
  payload?: unknown;
  result: AuditResult;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditRow {
  id: string;
  seq: string;
  workspace_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload_digest: string | null;
  result: AuditResult;
  reason: string | null;
  created_at: Date;
  prev_hash: string | null;
  hash: string;
}

/** Deterministic JSON so the same payload always yields the same digest. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, val]) => [k, walk(val)]));
  };
  return JSON.stringify(walk(value));
}

export function digestOf(payload: unknown): string | null {
  if (payload === undefined) return null;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function computeAuditHash(input: {
  prevHash: string | null;
  workspaceId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payloadDigest: string | null;
  result: string;
  createdAt: string;
}): string {
  return createHash('sha256')
    .update(canonicalJson({ ...input, prevHash: input.prevHash ?? '' }))
    .digest('hex');
}

/**
 * Append one audit record. Serialized per workspace with a transaction-scoped
 * advisory lock so the hash chain cannot interleave under concurrency.
 */
export async function writeAudit(client: PoolClient, input: AuditInput): Promise<AuditRow> {
  const lockKey = input.workspaceId ?? 'global';
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

  const prev = await client.query<{ hash: string }>(
    `SELECT hash FROM audit_log
      WHERE workspace_id IS NOT DISTINCT FROM $1
      ORDER BY seq DESC LIMIT 1`,
    [input.workspaceId],
  );
  const prevHash = prev.rows[0]?.hash ?? null;
  const payloadDigest = digestOf(input.payload);
  const createdAt = new Date().toISOString();

  const hash = computeAuditHash({
    prevHash,
    workspaceId: input.workspaceId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    payloadDigest,
    result: input.result,
    createdAt,
  });

  const { rows } = await client.query<AuditRow>(
    `INSERT INTO audit_log
       (workspace_id, actor_type, actor_id, action, target_type, target_id,
        payload_digest, result, reason, ip, user_agent, created_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      input.workspaceId,
      input.actorType,
      input.actorId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      payloadDigest,
      input.result,
      input.reason ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
      createdAt,
      prevHash,
      hash,
    ],
  );
  return rows[0];
}

export interface ChainVerification {
  ok: boolean;
  rowsChecked: number;
  brokenAtSeq: string | null;
  reason: string | null;
}

/** Recompute the chain for a workspace and report tampering. */
export async function verifyAuditChain(
  pool: Pool,
  workspaceId: string | null,
): Promise<ChainVerification> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT * FROM audit_log WHERE workspace_id IS NOT DISTINCT FROM $1 ORDER BY seq ASC`,
    [workspaceId],
  );
  let prevHash: string | null = null;
  for (const row of rows) {
    if ((row.prev_hash ?? null) !== prevHash) {
      return { ok: false, rowsChecked: rows.length, brokenAtSeq: row.seq, reason: 'prev_hash mismatch' };
    }
    const expected = computeAuditHash({
      prevHash,
      workspaceId: row.workspace_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      payloadDigest: row.payload_digest,
      result: row.result,
      createdAt: new Date(row.created_at).toISOString(),
    });
    if (expected !== row.hash) {
      return { ok: false, rowsChecked: rows.length, brokenAtSeq: row.seq, reason: 'hash mismatch' };
    }
    prevHash = row.hash;
  }
  return { ok: true, rowsChecked: rows.length, brokenAtSeq: null, reason: null };
}

export async function listAudit(
  pool: Pool,
  workspaceId: string,
  limit = 50,
): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT * FROM audit_log WHERE workspace_id = $1 ORDER BY seq DESC LIMIT $2`,
    [workspaceId, Math.min(limit, 200)],
  );
  return rows;
}
