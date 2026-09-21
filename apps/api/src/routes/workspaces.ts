import { Router, type Request } from 'express';
import { NotFoundError, type Scope } from '@alia/core';
import { countJobsByStatus, findWorkspaceById, listAudit, listMembers, verifyAuditChain } from '@alia/db';
import { assertScopeMatches, requirePermission } from '@alia/policy';
import { requireScope } from '../middleware/auth.js';
import { asyncHandler, uuidSchema } from './helpers.js';

/**
 * Every route here resolves the scope from the session (never from the URL),
 * then asserts the URL's workspace matches it, then checks the permission.
 * The repository call is finally filtered by `scope.workspaceId`.
 */
export function workspaceRoutes(): Router {
  const router = Router();

  // `requireScope` guarantees this is set before any handler below runs.
  const scopeFor = (req: Request): Scope => req.ctx.scope as Scope;

  router.get(
    '/:workspaceId/members',
    requireScope,
    asyncHandler(async (req, res) => {
      const workspaceId = uuidSchema.parse(req.params.workspaceId);
      const scope = scopeFor(req);
      assertScopeMatches(scope, workspaceId);
      requirePermission(scope, 'workspace.members.read');
      const members = await listMembers(req.ctx.pool, scope.workspaceId);
      res.json({ members });
    }),
  );

  router.get(
    '/:workspaceId/audit',
    requireScope,
    asyncHandler(async (req, res) => {
      const workspaceId = uuidSchema.parse(req.params.workspaceId);
      const scope = scopeFor(req);
      assertScopeMatches(scope, workspaceId);
      requirePermission(scope, 'audit.read');
      const limit = Number(req.query.limit ?? 50);
      const entries = await listAudit(req.ctx.pool, scope.workspaceId, Number.isFinite(limit) ? limit : 50);
      res.json({
        entries: entries.map((e) => ({
          id: e.id,
          seq: e.seq,
          actorType: e.actor_type,
          actorId: e.actor_id,
          action: e.action,
          targetType: e.target_type,
          targetId: e.target_id,
          result: e.result,
          reason: e.reason,
          createdAt: e.created_at,
          hash: e.hash,
          prevHash: e.prev_hash,
        })),
      });
    }),
  );

  router.get(
    '/:workspaceId/audit/verify',
    requireScope,
    asyncHandler(async (req, res) => {
      const workspaceId = uuidSchema.parse(req.params.workspaceId);
      const scope = scopeFor(req);
      assertScopeMatches(scope, workspaceId);
      requirePermission(scope, 'audit.read');
      const verification = await verifyAuditChain(req.ctx.pool, scope.workspaceId);
      res.json(verification);
    }),
  );

  router.get(
    '/:workspaceId/jobs',
    requireScope,
    asyncHandler(async (req, res) => {
      const workspaceId = uuidSchema.parse(req.params.workspaceId);
      const scope = scopeFor(req);
      assertScopeMatches(scope, workspaceId);
      requirePermission(scope, 'jobs.read');
      const counts = await countJobsByStatus(req.ctx.pool, scope.workspaceId);
      res.json({ counts });
    }),
  );

  router.get(
    '/:workspaceId',
    requireScope,
    asyncHandler(async (req, res) => {
      const workspaceId = uuidSchema.parse(req.params.workspaceId);
      const scope = scopeFor(req);
      assertScopeMatches(scope, workspaceId);
      requirePermission(scope, 'workspace.read');
      const workspace = await findWorkspaceById(req.ctx.pool, scope.workspaceId);
      if (!workspace) throw new NotFoundError('Workspace not found');
      res.json({ workspace, role: scope.role });
    }),
  );

  return router;
}
