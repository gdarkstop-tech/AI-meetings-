import { Router, type Request } from 'express';
import { z } from 'zod';
import { NotFoundError, ProviderNotConfiguredError, type Scope } from '@alia/core';
import {
  appendMessage,
  createConversation,
  createResearchRequest,
  enqueueJob,
  findConversation,
  findResearchReport,
  findResearchRequest,
  listConversations,
  listMessages,
  listResearchRequests,
  listResearchSources,
  withTransaction,
  writeAudit,
} from '@alia/db';
import { askQuestion, searchWorkspace } from '@alia/pipeline';
import { requirePermission } from '@alia/policy';
import type { Config } from '../config.js';
import { requireScope } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, parseBody, uuidSchema } from './helpers.js';

const scopeOf = (req: Request): Scope => req.ctx.scope as Scope;

/** Search and Ask AI. Both are permission-filtered before any model sees data. */
export function intelligenceRoutes(config: Config): Router {
  const router = Router();
  const aiLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_AI_WINDOW_MS,
    max: config.RATE_LIMIT_AI_MAX,
    name: 'ai',
  });

  router.get(
    '/search',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const query = String(req.query.q ?? '').slice(0, 500);
      if (!query.trim()) {
        res.json({ hits: [], semanticAvailable: false, degradedReason: null });
        return;
      }
      const types = req.query.types
        ? String(req.query.types)
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
      const outcome = await searchWorkspace({
        pool: req.ctx.pool,
        registry: req.ctx.registry,
        scope,
        query,
        types: types as never,
        limit: Number(req.query.limit ?? 25),
      });
      res.json(outcome);
    }),
  );

  router.get(
    '/conversations',
    requireScope,
    asyncHandler(async (req, res) => {
      res.json({ conversations: await listConversations(req.ctx.pool, scopeOf(req)) });
    }),
  );

  router.get(
    '/conversations/:conversationId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      const conversation = await findConversation(req.ctx.pool, scope, uuidSchema.parse(req.params.conversationId));
      if (!conversation) throw new NotFoundError('Conversation not found');
      res.json({ conversation, messages: await listMessages(req.ctx.pool, conversation.id) });
    }),
  );

  router.post(
    '/ask',
    requireScope,
    aiLimiter,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const input = parseBody(
        z.object({
          question: z.string().trim().min(3).max(1000),
          conversationId: z.string().uuid().optional(),
          meetingIds: z.array(z.string().uuid()).max(50).optional(),
        }),
        req.body,
      );

      let conversationId = input.conversationId;
      if (conversationId) {
        const existing = await findConversation(req.ctx.pool, scope, conversationId);
        if (!existing) throw new NotFoundError('Conversation not found');
      } else {
        const created = await createConversation(req.ctx.pool, scope, input.question.slice(0, 80));
        conversationId = created.id;
      }

      await appendMessage(req.ctx.pool, {
        workspaceId: scope.workspaceId,
        conversationId,
        role: 'user',
        content: input.question,
      });

      const result = await askQuestion({
        pool: req.ctx.pool,
        registry: req.ctx.registry,
        scope,
        question: input.question,
        conversationId,
        meetingIds: input.meetingIds,
      });

      res.json({
        conversationId,
        answer: result.answer,
        citations: result.citations,
        sufficient: result.sufficient,
        model: result.modelVersion,
        droppedCitations: result.droppedCitations,
      });
    }),
  );

  // --------------------------------------------------------------- research
  router.post(
    '/research',
    requireScope,
    aiLimiter,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const input = parseBody(
        z.object({
          question: z.string().trim().min(8).max(500),
          originMeetingId: z.string().uuid().optional(),
        }),
        req.body,
      );
      // Refuse before creating a request we cannot possibly fulfil.
      if (!req.ctx.registry.isConfigured('search')) throw new ProviderNotConfiguredError('search');
      if (!req.ctx.registry.isConfigured('llm')) throw new ProviderNotConfiguredError('llm');

      const request = await withTransaction(req.ctx.pool, async (client) => {
        const row = await createResearchRequest(client, scope, {
          question: input.question,
          originMeetingId: input.originMeetingId ?? null,
        });
        await enqueueJob(client, {
          workspaceId: scope.workspaceId,
          type: 'research.run',
          payload: { requestId: row.id },
          maxAttempts: 2,
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'research.request',
          targetType: 'research_request',
          targetId: row.id,
          result: 'success',
        });
        return row;
      });
      res.status(201).json({ request });
    }),
  );

  router.get(
    '/research',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      res.json({ requests: await listResearchRequests(req.ctx.pool, scope) });
    }),
  );

  router.get(
    '/research/:requestId',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const request = await findResearchRequest(req.ctx.pool, scope, uuidSchema.parse(req.params.requestId));
      if (!request) throw new NotFoundError('Research request not found');
      const [sources, report] = await Promise.all([
        listResearchSources(req.ctx.pool, request.id),
        findResearchReport(req.ctx.pool, request.id),
      ]);
      res.json({ request, sources, report });
    }),
  );

  return router;
}
