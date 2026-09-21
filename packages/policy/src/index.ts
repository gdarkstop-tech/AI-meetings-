import { ForbiddenError, type Scope, type WorkspaceRole } from '@alia/core';

/**
 * Deterministic RBAC. The model is never consulted here and never will be:
 * authorization is code, not inference (docs/03-security.md §2).
 */
export const PERMISSIONS = [
  'workspace.read',
  'workspace.update',
  'workspace.members.read',
  'workspace.members.manage',
  'audit.read',
  'jobs.read',
  'meeting.read',
  'meeting.create',
  'meeting.delete',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set<Permission>([
    'workspace.read',
    'workspace.update',
    'workspace.members.read',
    'workspace.members.manage',
    'audit.read',
    'jobs.read',
    'meeting.read',
    'meeting.create',
    'meeting.delete',
  ]),
  member: new Set<Permission>([
    'workspace.read',
    'workspace.members.read',
    'jobs.read',
    'meeting.read',
    'meeting.create',
  ]),
  viewer: new Set<Permission>(['workspace.read', 'workspace.members.read', 'meeting.read']),
};

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function permissionsFor(role: WorkspaceRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

/** Throws ForbiddenError when the scope's role lacks the permission. */
export function requirePermission(scope: Scope, permission: Permission): void {
  if (!can(scope.role, permission)) {
    throw new ForbiddenError(`Role "${scope.role}" may not perform "${permission}".`);
  }
}

/**
 * Guard against a scope being used for a different workspace than the one the
 * request targets. Defence in depth behind the repository-level filter.
 */
export function assertScopeMatches(scope: Scope, workspaceId: string): void {
  if (scope.workspaceId !== workspaceId) {
    throw new ForbiddenError('Scope does not match the requested workspace.');
  }
}
