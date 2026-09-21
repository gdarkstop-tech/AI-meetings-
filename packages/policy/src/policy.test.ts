import { describe, expect, it } from 'vitest';
import { ForbiddenError, type Scope } from '@alia/core';
import { assertScopeMatches, can, permissionsFor, requirePermission } from './index.js';

const scope = (role: Scope['role']): Scope => ({ workspaceId: 'w1', userId: 'u1', role });

describe('RBAC', () => {
  it('grants owners everything and viewers almost nothing', () => {
    expect(can('owner', 'workspace.members.manage')).toBe(true);
    expect(can('viewer', 'workspace.members.manage')).toBe(false);
    expect(can('viewer', 'meeting.create')).toBe(false);
    expect(can('member', 'meeting.create')).toBe(true);
    expect(can('member', 'audit.read')).toBe(false);
  });

  it('requirePermission throws ForbiddenError for insufficient roles', () => {
    expect(() => requirePermission(scope('owner'), 'audit.read')).not.toThrow();
    expect(() => requirePermission(scope('member'), 'audit.read')).toThrow(ForbiddenError);
  });

  it('rejects a scope that does not match the requested workspace', () => {
    expect(() => assertScopeMatches(scope('owner'), 'w1')).not.toThrow();
    expect(() => assertScopeMatches(scope('owner'), 'w2')).toThrow(ForbiddenError);
  });

  it('lists permissions per role without leaking extras', () => {
    expect(permissionsFor('viewer')).not.toContain('meeting.delete');
    expect(permissionsFor('owner')).toContain('meeting.delete');
  });
});
