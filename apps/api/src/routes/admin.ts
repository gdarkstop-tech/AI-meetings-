import { Router, type Request } from 'express';
import { z } from 'zod';
import { NotFoundError, type Scope } from '@alia/core';
import {
  costSummary,
  countJobsByStatus,
  deleteMemory,
  exportWorkspace,
  listDeletions,
  listMemory,
  upsertMemory,
  updateWorkspaceSettings,
  withTransaction,
  workspaceSettings,
  writeAudit,
} from '@alia/db';
import { requirePermission } from '@alia/policy';
import { requireScope } from '../middleware/auth.js';
import { asyncHandler, parseBody, uuidSchema } from './helpers.js';

const scopeOf = (req: Request): Scope => req.ctx.scope as Scope;

/** Workspace governance: privacy policy, cost, jobs, export, memory. */
export function adminRoutes(): Router {
  const router = Router();

  router.get(
    '/settings',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.read');
      const settings = await workspaceSettings(req.ctx.pool, scope.workspaceId);
      if (!settings) throw new NotFoundError('Workspace not found');
      res.json({ settings });
    }),
  );

  router.patch(
    '/settings',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const patch = parseBody(
        z.object({
          retentionDays: z.number().int().min(1).max(3650).optional(),
          mediaRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
          requireRecordingConsent: z.boolean().optional(),
          aiEnabled: z.boolean().optional(),
          externalActionsEnabled: z.boolean().optional(),
          monthlyAudioMinutesQuota: z.number().int().min(0).max(1_000_000).optional(),
          timezone: z.string().min(1).max(64).optional(),
        }),
        req.body,
      );
      await withTransaction(req.ctx.pool, async (client) => {
        await updateWorkspaceSettings(client, scope.workspaceId, patch);
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'workspace.settings.update',
          targetType: 'workspace',
          targetId: scope.workspaceId,
          payload: patch,
          result: 'success',
        });
      });
      res.json({ settings: await workspaceSettings(req.ctx.pool, scope.workspaceId) });
    }),
  );

  /** Real spend, computed from recorded provider calls — not an estimate. */
  router.get(
    '/costs',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'audit.read');
      const days = Math.min(Number(req.query.days ?? 30), 365);
      const rows = await costSummary(req.ctx.pool, scope, days);
      res.json({
        days,
        providers: rows.map((r) => ({
          kind: r.provider_kind,
          provider: r.provider_id,
          calls: Number(r.calls),
          failures: Number(r.failures),
          audioMinutes: Number(r.audio_seconds ?? 0) / 60,
          inputTokens: Number(r.input_tokens ?? 0),
          outputTokens: Number(r.output_tokens ?? 0),
          costUsd: Number(r.cost_usd ?? 0),
        })),
        totalCostUsd: rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0),
      });
    }),
  );

  router.get(
    '/jobs',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'jobs.read');
      res.json({ counts: await countJobsByStatus(req.ctx.pool, scope.workspaceId) });
    }),
  );

  router.get(
    '/deletions',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'audit.read');
      res.json({ deletions: await listDeletions(req.ctx.pool, scope) });
    }),
  );

  /** Data export (portability / DSR). Scoped to the caller's workspace only. */
  router.get(
    '/export',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const data = await exportWorkspace(req.ctx.pool, scope);
      await withTransaction(req.ctx.pool, (client) =>
        writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'workspace.export',
          targetType: 'workspace',
          targetId: scope.workspaceId,
          result: 'success',
        }),
      );
      res.setHeader('Content-Disposition', `attachment; filename="workspace-export-${scope.workspaceId}.json"`);
      res.json(data);
    }),
  );

  // ------------------------------------------------------------ AI memory
  router.get(
    '/memory',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.read');
      const entries = await listMemory(req.ctx.pool, scope);
      res.json({
        entries: entries.map((e) => ({
          id: e.id,
          scope: e.scope,
          type: e.type,
          key: e.key,
          value: e.value,
          source: { type: e.source_type, id: e.source_id },
          createdBy: e.created_by,
          createdAt: e.created_at,
        })),
      });
    }),
  );

  router.post(
    '/memory',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const input = parseBody(
        z.object({
          scope: z.enum(['workspace', 'user', 'project']).default('workspace'),
          type: z.enum(['preference', 'fact', 'project', 'person', 'topic']),
          key: z.string().min(1).max(200),
          value: z.record(z.string(), z.unknown()),
          sourceType: z.enum(['user', 'meeting', 'decision', 'task']).default('user'),
          sourceId: z.string().uuid().optional(),
        }),
        req.body,
      );
      const entry = await withTransaction(req.ctx.pool, async (client) => {
        const row = await upsertMemory(client, scope, {
          scope: input.scope,
          scopeRefId: input.scope === 'user' ? scope.userId : null,
          type: input.type,
          key: input.key,
          value: input.value as Record<string, unknown>,
          sourceType: input.sourceType,
          sourceId: input.sourceId ?? null,
          createdBy: 'user',
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'memory.create',
          targetType: 'memory',
          targetId: row.id,
          result: 'success',
        });
        return row;
      });
      res.status(201).json({ entry });
    }),
  );

  /** Deletion is real deletion: the row is removed and the removal is audited. */
  router.delete(
    '/memory/:memoryId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const memoryId = uuidSchema.parse(req.params.memoryId);
      const removed = await withTransaction(req.ctx.pool, async (client) => {
        const ok = await deleteMemory(client, scope, memoryId);
        if (ok) {
          await writeAudit(client, {
            workspaceId: scope.workspaceId,
            actorType: 'user',
            actorId: scope.userId,
            action: 'memory.delete',
            targetType: 'memory',
            targetId: memoryId,
            result: 'success',
          });
        }
        return ok;
      });
      if (!removed) throw new NotFoundError('Memory entry not found');
      res.json({ deleted: true });
    }),
  );

  return router;
}
