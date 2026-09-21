import type { Queryable } from '../client.js';
import type { WorkspaceRole } from '@alia/core';

export interface WorkspaceRow {
  id: string;
  name: string;
  locale_default: 'ar' | 'en';
  timezone: string;
  retention_days: number;
  created_at: Date;
}

export interface MembershipRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  name: string;
  locale_default: 'ar' | 'en';
  timezone: string;
}

export async function createWorkspace(
  db: Queryable,
  input: { name: string; localeDefault?: 'ar' | 'en'; timezone?: string },
): Promise<WorkspaceRow> {
  const { rows } = await db.query<WorkspaceRow>(
    `INSERT INTO workspaces (name, locale_default, timezone) VALUES ($1,$2,$3) RETURNING *`,
    [input.name, input.localeDefault ?? 'en', input.timezone ?? 'UTC'],
  );
  return rows[0];
}

export async function addMember(
  db: Queryable,
  input: { workspaceId: string; userId: string; role: WorkspaceRole },
): Promise<void> {
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [input.workspaceId, input.userId, input.role],
  );
}

/** Every workspace this user belongs to. The only entry point for tenancy. */
export async function listMembershipsForUser(db: Queryable, userId: string): Promise<MembershipRow[]> {
  const { rows } = await db.query<MembershipRow>(
    `SELECT m.workspace_id, m.user_id, m.role, w.name, w.locale_default, w.timezone
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1
      ORDER BY w.created_at ASC`,
    [userId],
  );
  return rows;
}

/**
 * Resolve a user's role in one workspace. Returns null when the user is not a
 * member — callers must treat null as "no access", never as a default role.
 */
export async function findMembership(
  db: Queryable,
  workspaceId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const { rows } = await db.query<MembershipRow>(
    `SELECT m.workspace_id, m.user_id, m.role, w.name, w.locale_default, w.timezone
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0] ?? null;
}

export async function listMembers(
  db: Queryable,
  scopeWorkspaceId: string,
): Promise<Array<{ user_id: string; role: WorkspaceRole; email: string; name: string }>> {
  const { rows } = await db.query<{ user_id: string; role: WorkspaceRole; email: string; name: string }>(
    `SELECT m.user_id, m.role, u.email, u.name
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY m.created_at ASC`,
    [scopeWorkspaceId],
  );
  return rows;
}

export async function findWorkspaceById(
  db: Queryable,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  const { rows } = await db.query<WorkspaceRow>(
    `SELECT id, name, locale_default, timezone, retention_days, created_at
       FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}
