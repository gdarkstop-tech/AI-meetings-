import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError, encryptSecret, type Scope } from '@alia/core';
import {
  consumeOAuthState,
  deleteIntegration,
  findIntegration,
  findMeeting,
  listActions,
  listIntegrationsSafe,
  saveOAuthState,
  upsertIntegration,
  withTransaction,
  workspaceSettings,
  writeAudit,
} from '@alia/db';
import {
  approveAction,
  calendarEventPayload,
  emailSendPayload,
  generateFollowUp,
  proposeAction,
  rejectAction,
} from '@alia/pipeline';
import {
  GOOGLE_SCOPES,
  MICROSOFT_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  fetchAccountEmail,
  type OAuthKind,
} from '@alia/providers';
import { requirePermission } from '@alia/policy';
import { requireScope } from '../middleware/auth.js';
import { asyncHandler, parseBody, uuidSchema } from './helpers.js';

const scopeOf = (req: Request): Scope => req.ctx.scope as Scope;

const proposeSchema = z.discriminatedUnion('type', [
  emailSendPayload.extend({ type: z.literal('email.send'), sourceMeetingId: z.string().uuid().optional(), dryRun: z.boolean().optional() }),
  calendarEventPayload.extend({ type: z.literal('calendar.create_event'), sourceMeetingId: z.string().uuid().optional(), dryRun: z.boolean().optional() }),
]);

/** Action Gateway + integrations. Nothing external happens without approval. */
export function actionRoutes(): Router {
  const router = Router();

  router.get(
    '/actions',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.read');
      const actions = await listActions(req.ctx.pool, scope, {
        status: req.query.status as never,
        limit: Number(req.query.limit ?? 50),
      });
      res.json({
        actions: actions.map((a) => ({
          id: a.id,
          type: a.type,
          summary: a.summary,
          payload: a.payload,
          payloadDigest: a.payload_digest,
          status: a.status,
          requiresApproval: a.requires_approval,
          requestedVia: a.requested_via,
          policyReason: a.policy_reason,
          dryRun: a.dry_run,
          providerResponseId: a.provider_response_id,
          error: a.error,
          createdAt: a.created_at,
          executedAt: a.executed_at,
        })),
      });
    }),
  );

  router.post(
    '/actions',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const input = parseBody(proposeSchema, req.body);
      const { sourceMeetingId, dryRun, ...payload } = input;
      const action = await proposeAction(req.ctx.pipeline, scope, {
        payload: payload as never,
        requestedVia: 'ui',
        sourceMeetingId: sourceMeetingId ?? null,
        dryRun,
      });
      res.status(201).json({
        action: {
          id: action.id,
          type: action.type,
          summary: action.summary,
          status: action.status,
          payloadDigest: action.payload_digest,
          requiresApproval: action.requires_approval,
        },
      });
    }),
  );

  router.post(
    '/actions/:actionId/approve',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const actionId = uuidSchema.parse(req.params.actionId);
      const { payloadDigest } = parseBody(z.object({ payloadDigest: z.string().min(16) }), req.body);
      const action = await approveAction(req.ctx.pipeline, scope, actionId, payloadDigest);
      res.json({ action: { id: action.id, status: action.status }, execution: 'queued' });
    }),
  );

  router.post(
    '/actions/:actionId/reject',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const actionId = uuidSchema.parse(req.params.actionId);
      const { reason } = parseBody(z.object({ reason: z.string().min(1).max(500) }), req.body);
      const action = await rejectAction(req.ctx.pipeline, scope, actionId, reason);
      res.json({ action: { id: action.id, status: action.status } });
    }),
  );

  /** AI drafts a follow-up; it lands in the approval queue, never in an outbox. */
  router.post(
    '/meetings/:meetingId/followup',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'meeting.create');
      const meetingId = uuidSchema.parse(req.params.meetingId);
      const meeting = await findMeeting(req.ctx.pool, scope, meetingId);
      if (!meeting) throw new NotFoundError('Meeting not found');

      const llm = req.ctx.registry.llm();
      const { draft, modelVersion } = await generateFollowUp({
        pool: req.ctx.pool,
        llm,
        scope,
        meetingId,
      });

      const recipients = parseBody(
        z.object({ to: z.array(z.string().email()).min(1).max(25), provider: z.enum(['gmail', 'microsoft']).optional() }),
        req.body,
      );

      const settings = await workspaceSettings(req.ctx.pool, scope.workspaceId);
      const provider = recipients.provider ?? 'gmail';
      const integration = await findIntegration(req.ctx.pool, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        kind: provider === 'gmail' ? 'google' : 'microsoft',
      });

      if (!settings?.external_actions_enabled || !integration) {
        // Honest: we produced a draft but cannot propose a send.
        res.status(200).json({
          draft,
          model: modelVersion,
          proposedAction: null,
          reason: !settings?.external_actions_enabled
            ? 'External actions are disabled for this workspace; the draft was not queued for sending.'
            : `No connected ${provider} account; the draft was not queued for sending.`,
        });
        return;
      }

      const action = await proposeAction(req.ctx.pipeline, scope, {
        payload: {
          type: 'email.send',
          provider,
          to: recipients.to,
          subject: draft.email.subject,
          body: draft.email.body,
        },
        requestedVia: 'ai',
        sourceMeetingId: meetingId,
      });
      res.status(201).json({
        draft,
        model: modelVersion,
        proposedAction: { id: action.id, status: action.status, payloadDigest: action.payload_digest },
      });
    }),
  );

  // ----------------------------------------------------------- integrations
  router.get(
    '/integrations',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.read');
      res.json({
        integrations: await listIntegrationsSafe(req.ctx.pool, scope),
        providers: req.ctx.registry.statuses(),
      });
    }),
  );

  router.post(
    '/integrations/:kind/authorize',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const kind = z.enum(['google', 'microsoft']).parse(req.params.kind) as OAuthKind;
      const config = req.ctx.registry.oauthConfig(kind); // throws NOT_CONFIGURED
      const { capabilities } = parseBody(
        z.object({ capabilities: z.array(z.enum(['calendar', 'email', 'email_send'])).min(1) }),
        req.body,
      );

      // Minimum scopes, requested incrementally per capability.
      const scopes = new Set<string>();
      if (kind === 'google') {
        scopes.add(GOOGLE_SCOPES.profile);
        if (capabilities.includes('calendar')) scopes.add(GOOGLE_SCOPES.calendarWrite);
        if (capabilities.includes('email')) scopes.add(GOOGLE_SCOPES.mailRead);
        if (capabilities.includes('email_send')) scopes.add(GOOGLE_SCOPES.mailSend);
      } else {
        scopes.add(MICROSOFT_SCOPES.profile);
        scopes.add(MICROSOFT_SCOPES.offline);
        if (capabilities.includes('calendar')) scopes.add(MICROSOFT_SCOPES.calendarWrite);
        if (capabilities.includes('email')) scopes.add(MICROSOFT_SCOPES.mailRead);
        if (capabilities.includes('email_send')) scopes.add(MICROSOFT_SCOPES.mailSend);
      }

      const state = randomBytes(24).toString('base64url');
      await saveOAuthState(req.ctx.pool, {
        state,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        kind,
        scopes: [...scopes],
        ttlSeconds: 600,
      });
      res.json({ authorizeUrl: buildAuthorizeUrl({ kind, config, scopes: [...scopes], state }) });
    }),
  );

  /** OAuth callback. Tokens are encrypted before they touch the database. */
  router.get(
    '/integrations/:kind/callback',
    asyncHandler(async (req, res) => {
      const kind = z.enum(['google', 'microsoft']).parse(req.params.kind) as OAuthKind;
      const query = z
        .object({ code: z.string().min(1).optional(), state: z.string().min(1), error: z.string().optional() })
        .parse(req.query);

      const pending = await consumeOAuthState(req.ctx.pool, query.state);
      if (!pending) throw new ForbiddenError('OAuth state is invalid or expired.');
      if (query.error || !query.code) {
        throw new ValidationError(`Authorization was not completed: ${query.error ?? 'no code returned'}`);
      }

      const config = req.ctx.registry.oauthConfig(kind);
      const tokens = await exchangeCode({ kind, config, code: query.code });
      const email = await fetchAccountEmail(kind, tokens.accessToken);

      await withTransaction(req.ctx.pool, async (client) => {
        await upsertIntegration(client, {
          workspaceId: pending.workspace_id,
          userId: pending.user_id,
          kind,
          scopes: tokens.scopes.length ? tokens.scopes : pending.scopes,
          tokenCiphertext: encryptSecret(
            JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
            req.ctx.pipeline.secretsKey,
          ),
          tokenExpiresAt: tokens.expiresAt,
          externalAccountEmail: email,
        });
        await writeAudit(client, {
          workspaceId: pending.workspace_id,
          actorType: 'user',
          actorId: pending.user_id,
          action: 'integration.connect',
          targetType: 'integration',
          targetId: kind,
          payload: { scopes: tokens.scopes, account: email },
          result: 'success',
        });
      });

      const redirect = req.ctx.pipeline.publicBaseUrl ?? '';
      res.redirect(`${redirect}/settings?connected=${kind}`);
    }),
  );

  router.delete(
    '/integrations/:kind',
    requireScope,
    asyncHandler(async (req, res) => {
      const scope = scopeOf(req);
      requirePermission(scope, 'workspace.update');
      const kind = z.enum(['google', 'microsoft']).parse(req.params.kind);
      const removed = await withTransaction(req.ctx.pool, async (client) => {
        const ok = await deleteIntegration(client, {
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          kind,
        });
        if (ok) {
          await writeAudit(client, {
            workspaceId: scope.workspaceId,
            actorType: 'user',
            actorId: scope.userId,
            action: 'integration.disconnect',
            targetType: 'integration',
            targetId: kind,
            result: 'success',
          });
        }
        return ok;
      });
      if (!removed) throw new NotFoundError('Integration not connected');
      res.json({ disconnected: kind });
    }),
  );

  return router;
}
