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

// --------------------------------------------------------- external actions
/**
 * Policy for actions with effects outside the system (email, calendar).
 *
 * This is deterministic code, deliberately conservative, and it is the only
 * place that decides whether something may leave the building. The model can
 * propose; it can never approve, and it cannot reach a provider except through
 * an action that passed this function and then a human.
 */
export const EXTERNAL_ACTION_TYPES = ['email.send', 'calendar.create_event', 'calendar.delete_event'] as const;
export type ExternalActionType = (typeof EXTERNAL_ACTION_TYPES)[number];

export interface ActionPolicyInput {
  scope: Scope;
  type: string;
  requestedVia: 'ui' | 'ai';
  workspace: { externalActionsEnabled: boolean };
  integrationConnected: boolean;
}

export interface ActionPolicyDecision {
  allow: boolean;
  requiresApproval: boolean;
  reason: string;
}

export function evaluateExternalAction(input: ActionPolicyInput): ActionPolicyDecision {
  if (!EXTERNAL_ACTION_TYPES.includes(input.type as ExternalActionType)) {
    return { allow: false, requiresApproval: true, reason: `Unknown action type "${input.type}".` };
  }
  if (!input.workspace.externalActionsEnabled) {
    return {
      allow: false,
      requiresApproval: true,
      reason: 'External actions are disabled for this workspace.',
    };
  }
  if (!can(input.scope.role, 'meeting.create')) {
    return { allow: false, requiresApproval: true, reason: `Role "${input.scope.role}" may not propose actions.` };
  }
  if (!input.integrationConnected) {
    return {
      allow: false,
      requiresApproval: true,
      reason: 'No connected account for this action. Connect an integration first.',
    };
  }
  // Every external effect needs a human, whoever proposed it. There is no
  // "trusted" path that skips approval.
  return {
    allow: true,
    requiresApproval: true,
    reason:
      input.requestedVia === 'ai'
        ? 'AI-proposed external action: human approval required.'
        : 'External action: human approval required.',
  };
}
