import { Router, type Request } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError, normalizeForSearch, type Scope } from '@alia/core';
import {
  assignSpeaker,
  createTask,
  distinctSpeakers,
  findActionItem,
  findMeeting,
  listActionItems,
  listChapters,
  listDecisions,
  listPeople,
  listSegments,
  listSpeakerMap,
  listSummaries,
  markActionItemReviewed,
  reviewDecision,
  upsertPerson,
  withTransaction,
  writeAudit,
} from '@alia/db';
import { requirePermission } from '@alia/policy';
import { requireScope } from '../middleware/auth.js';
import { asyncHandler, parseBody, uuidSchema } from './helpers.js';

const scopeOf = (req: Request): Scope => req.ctx.scope as Scope;

/**
 * Transcript and AI artifacts.
 *
 * Everything the AI produced arrives as `suggested`; the accept/reject routes
 * here are the only way it becomes real, and each transition is audited.
 */
export function insightRoutes(): Router {
  const router = Router();

  router.get(
    '/meetings/:meetingId/transcript',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const meeting = await findMeeting(req.ctx.pool, scope, meetingId);
      if (!meeting) throw new NotFoundError('Meeting not found');
      const [segments, speakers] = await Promise.all([
        listSegments(req.ctx.pool, scope, meetingId, { limit: Number(req.query.limit ?? 5000) }),
        listSpeakerMap(req.ctx.pool, meetingId),
      ]);
      const names = new Map(speakers.map((s) => [s.speaker_label, s.display_name]));
      res.json({
        meetingId,
        status: meeting.status,
        segments: segments.map((s) => ({
          id: s.id,
          idx: s.idx,
          startMs: s.start_ms,
          endMs: s.end_ms,
          speaker: names.get(s.speaker_label) ?? s.speaker_label,
          speakerLabel: s.speaker_label,
          text: s.text,
          confidence: s.confidence,
        })),
      });
    }),
  );

  router.get(
    '/meetings/:meetingId/insights',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      // Confirm the meeting is visible in this workspace before returning
      // anything; an out-of-scope id must look like a missing one.
      const meeting = await findMeeting(req.ctx.pool, scope, meetingId);
      if (!meeting) throw new NotFoundError('Meeting not found');
      const [summaries, decisions, actionItems, chapters] = await Promise.all([
        listSummaries(req.ctx.pool, scope, meetingId),
        listDecisions(req.ctx.pool, scope, { meetingId }),
        listActionItems(req.ctx.pool, scope, { meetingId }),
        listChapters(req.ctx.pool, scope, meetingId),
      ]);
      res.json({
        summaries: summaries.map((s) => ({
          kind: s.kind,
          content: s.content,
          language: s.output_language,
          model: s.model_version,
          promptVersion: s.prompt_version,
          generatedAt: s.generated_at,
        })),
        decisions,
        actionItems,
        chapters,
      });
    }),
  );

  router.post(
    '/decisions/:decisionId/review',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const decisionId = uuidSchema.parse(req.params.decisionId);
      const input = parseBody(
        z.object({
          status: z.enum(['accepted', 'rejected', 'edited']),
          text: z.string().min(1).max(2000).optional(),
          ownerPersonId: z.string().uuid().nullable().optional(),
        }),
        req.body,
      );
      const updated = await withTransaction(req.ctx.pool, async (client) => {
        const row = await reviewDecision(client, scope, decisionId, {
          status: input.status,
          text: input.text,
          textNormalized: input.text ? normalizeForSearch(input.text) : undefined,
          ownerPersonId: input.ownerPersonId ?? null,
        });
        if (!row) return null;
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: `decision.${input.status}`,
          targetType: 'decision',
          targetId: decisionId,
          result: 'success',
        });
        return row;
      });
      if (!updated) throw new NotFoundError('Decision not found');
      res.json({ decision: updated });
    }),
  );

  /** Accepting an action item is what creates a real task, with its source link. */
  router.post(
    '/action-items/:actionItemId/accept',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const id = uuidSchema.parse(req.params.actionItemId);
      const input = parseBody(
        z.object({
          title: z.string().min(1).max(300).optional(),
          assigneeUserId: z.string().uuid().nullable().optional(),
          dueAt: z.string().datetime().nullable().optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        }),
        req.body ?? {},
      );
      const existing = await findActionItem(req.ctx.pool, scope, id);
      if (!existing) throw new NotFoundError('Action item not found');
      if (existing.status === 'accepted' && existing.task_id) {
        throw new ValidationError('This action item already has a task.');
      }

      const result = await withTransaction(req.ctx.pool, async (client) => {
        const title = input.title ?? existing.title;
        const task = await createTask(client, scope, {
          title,
          titleNormalized: normalizeForSearch(title),
          description: existing.description,
          assigneeUserId: input.assigneeUserId ?? null,
          assigneePersonId: existing.assignee_person_id,
          dueAt: input.dueAt ? new Date(input.dueAt) : existing.due_at,
          priority: input.priority ?? existing.priority,
          sourceType: 'meeting',
          sourceMeetingId: existing.meeting_id,
          sourceSegmentId: existing.evidence_segment_ids[0] ?? null,
          sourceActionItemId: existing.id,
        });
        const updated = await markActionItemReviewed(client, scope, id, {
          status: 'accepted',
          taskId: task.id,
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'action_item.accept',
          targetType: 'action_item',
          targetId: id,
          payload: { taskId: task.id },
          result: 'success',
        });
        return { task, actionItem: updated };
      });
      res.status(201).json(result);
    }),
  );

  router.post(
    '/action-items/:actionItemId/reject',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const id = uuidSchema.parse(req.params.actionItemId);
      const updated = await withTransaction(req.ctx.pool, async (client) => {
        const row = await markActionItemReviewed(client, scope, id, { status: 'rejected' });
        if (!row) return null;
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'action_item.reject',
          targetType: 'action_item',
          targetId: id,
          result: 'success',
        });
        return row;
      });
      if (!updated) throw new NotFoundError('Action item not found');
      res.json({ actionItem: updated });
    }),
  );

  // ------------------------------------------------------------- speakers
  router.get(
    '/meetings/:meetingId/speakers',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const meeting = await findMeeting(req.ctx.pool, scope, meetingId);
      if (!meeting) throw new NotFoundError('Meeting not found');
      const [labels, mapped, people] = await Promise.all([
        distinctSpeakers(req.ctx.pool, meetingId),
        listSpeakerMap(req.ctx.pool, meetingId),
        listPeople(req.ctx.pool, scope),
      ]);
      res.json({ labels, mapped, people });
    }),
  );

  /** Speaker identity is a human decision; diarization only proposes labels. */
  router.post(
    '/meetings/:meetingId/speakers',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const input = parseBody(
        z.object({
          speakerLabel: z.string().min(1).max(80),
          personId: z.string().uuid().optional(),
          displayName: z.string().min(1).max(120).optional(),
        }),
        req.body,
      );
      if (!input.personId && !input.displayName) {
        throw new ValidationError('Provide either personId or displayName.');
      }
      const result = await withTransaction(req.ctx.pool, async (client) => {
        const person = input.personId
          ? { id: input.personId }
          : await upsertPerson(client, scope, {
              displayName: input.displayName!,
              nameNormalized: normalizeForSearch(input.displayName!),
            });
        const updated = await assignSpeaker(client, scope, {
          meetingId,
          speakerLabel: input.speakerLabel,
          personId: person.id,
        });
        await writeAudit(client, {
          workspaceId: scope.workspaceId,
          actorType: 'user',
          actorId: scope.userId,
          action: 'speaker.assign',
          targetType: 'meeting',
          targetId: meetingId,
          payload: { speakerLabel: input.speakerLabel, personId: person.id },
          result: 'success',
        });
        return { personId: person.id, segmentsUpdated: updated };
      });
      res.json(result);
    }),
  );

  router.get(
    '/people',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      res.json({ people: await listPeople(req.ctx.pool, scope) });
    }),
  );

  return router;
}
