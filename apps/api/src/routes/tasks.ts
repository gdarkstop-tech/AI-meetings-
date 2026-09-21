import { Router, type Request } from 'express';
import { z } from 'zod';
import { NotFoundError, normalizeForSearch, type Scope } from '@alia/core';
import { createTask, listTasks, taskCounts, updateTask, withTransaction, writeAudit } from '@alia/db';
import { requirePermission } from '@alia/policy';
import { requireScope } from '../middleware/auth.js';
import { asyncHandler, parseBody, uuidSchema } from './helpers.js';

const scopeOf = (req: Request): Scope => req.ctx.scope as Scope;

export function taskRoutes(): Router {
  const router = Router();

  router.get(
    '/',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const tasks = await listTasks(req.ctx.pool, scope, {
        view: req.query.view as never,
        status: (req.query.status as string) || undefined,
        meetingId: (req.query.meetingId as string) || undefined,
      });
      res.json({ tasks, counts: await taskCounts(req.ctx.pool, scope) });
    }),
  );

  router.post(
    '/',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const input = parseBody(
        z.object({
          title: z.string().trim().min(1).max(300),
          description: z.string().max(10_000).optional(),
          dueAt: z.string().datetime().optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
          assigneeUserId: z.string().uuid().optional(),
        }),
        req.body,
      );
      const task = await withTransaction(req.ctx.pool, async (client) => {
        const row = await createTask(client, scope, {
          title: input.title,
          titleNormalized: normalizeForSearch(input.title),
          description: input.description ?? null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          priority: input.priority,
          assigneeUserId: input.assigneeUserId ?? null,
          sourceType: 'manual',
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'task.create',
          targetType: 'task',
          targetId: row.id,
          result: 'success',
        });
        return row;
      });
      res.status(201).json({ task });
    }),
  );

  router.patch(
    '/:taskId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const taskId = uuidSchema.parse(req.params.taskId);
      const patch = parseBody(
        z.object({
          title: z.string().trim().min(1).max(300).optional(),
          description: z.string().max(10_000).nullable().optional(),
          status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          dueAt: z.string().datetime().nullable().optional(),
          assigneeUserId: z.string().uuid().nullable().optional(),
        }),
        req.body,
      );
      const updated = await withTransaction(req.ctx.pool, async (client) => {
        const row = await updateTask(client, scope, taskId, {
          ...patch,
          titleNormalized: patch.title ? normalizeForSearch(patch.title) : undefined,
          dueAt: patch.dueAt ? new Date(patch.dueAt) : undefined,
        });
        if (!row) return null;
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'task.update',
          targetType: 'task',
          targetId: taskId,
          payload: patch,
          result: 'success',
        });
        return row;
      });
      if (!updated) throw new NotFoundError('Task not found');
      res.json({ task: updated });
    }),
  );

  return router;
}
