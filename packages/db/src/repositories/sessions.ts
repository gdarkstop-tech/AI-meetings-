import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../client.js';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  workspace_id: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function createSession(
  db: Queryable,
  input: {
    userId: string;
    token: string;
    csrfToken: string;
    workspaceId: string | null;
    ip?: string | null;
    userAgent?: string | null;
    ttlSeconds: number;
  },
): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, workspace_id, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))
     RETURNING *`,
    [
      input.userId,
      hashSessionToken(input.token),
      input.csrfToken,
      input.workspaceId,
      input.ip ?? null,
      input.userAgent ?? null,
      input.ttlSeconds,
    ],
  );
  return rows[0];
}

/** Look up a live session by its raw token. Expired or revoked returns null. */
export async function findLiveSessionByToken(db: Queryable, token: string): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT * FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashSessionToken(token)],
  );
  return rows[0] ?? null;
}

export async function touchSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
}

export async function setSessionWorkspace(
  db: Queryable,
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  await db.query('UPDATE sessions SET workspace_id = $2 WHERE id = $1', [sessionId, workspaceId]);
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessionsForUser(db: Queryable, userId: string): Promise<number> {
  const res = await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
  return res.rowCount ?? 0;
}
