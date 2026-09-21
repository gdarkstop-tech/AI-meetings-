import { z } from 'zod';
import { ForbiddenError, ValidationError, decryptSecret, encryptSecret, sha256Hex, type Scope } from '@alia/core';
import {
  approveAction as approveActionRow,
  claimActionForExecution,
  completeAction,
  enqueueJob,
  failAction,
  findAction,
  findIntegration,
  proposeAction as insertAction,
  recordProviderCall,
  rejectAction as rejectActionRow,
  updateIntegrationTokens,
  withTransaction,
  workspaceSettings,
  writeAudit,
  type ActionRow,
} from '@alia/db';
import { evaluateExternalAction } from '@alia/policy';
import { refreshAccessToken, type OAuthKind } from '@alia/providers';
import type { PipelineContext } from './context.js';

/**
 * The Action Gateway.
 *
 *   propose → deterministic policy → human approval → idempotent execution →
 *   audit with the provider's own response id
 *
 * Nothing reaches Gmail, Graph or Calendar except through executeAction, and
 * executeAction refuses to run anything that a human has not approved with the
 * exact payload digest they were shown.
 */
export const emailSendPayload = z.object({
  provider: z.enum(['gmail', 'microsoft']),
  to: z.array(z.string().email()).min(1).max(25),
  cc: z.array(z.string().email()).max(25).optional(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(50_000),
});

export const calendarEventPayload = z.object({
  provider: z.enum(['google', 'microsoft']),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timeZone: z.string().min(1).max(64),
  attendees: z.array(z.string().email()).max(50).default([]),
  location: z.string().max(300).optional(),
});

export type ActionPayload =
  | ({ type: 'email.send' } & z.infer<typeof emailSendPayload>)
  | ({ type: 'calendar.create_event' } & z.infer<typeof calendarEventPayload>);

function integrationKindFor(payload: ActionPayload): OAuthKind {
  if (payload.type === 'email.send') return payload.provider === 'gmail' ? 'google' : 'microsoft';
  return payload.provider === 'google' ? 'google' : 'microsoft';
}

function summarize(payload: ActionPayload): string {
  if (payload.type === 'email.send') {
    return `Send email "${payload.subject}" to ${payload.to.join(', ')}`;
  }
  return `Create calendar event "${payload.title}" at ${payload.startsAt} with ${payload.attendees.length} attendee(s)`;
}

export async function proposeAction(
  ctx: PipelineContext,
  scope: Scope,
  input: {
    payload: ActionPayload;
    requestedVia: 'ui' | 'ai';
    sourceMeetingId?: string | null;
    dryRun?: boolean;
  },
): Promise<ActionRow> {
  const settings = await workspaceSettings(ctx.pool, scope.workspaceId);
  if (!settings) throw new ValidationError('Workspace not found.');

  const kind = integrationKindFor(input.payload);
  const integration = await findIntegration(ctx.pool, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    kind,
  });

  const decision = evaluateExternalAction({
    scope,
    type: input.payload.type,
    requestedVia: input.requestedVia,
    workspace: { externalActionsEnabled: settings.external_actions_enabled },
    integrationConnected: Boolean(integration) || Boolean(input.dryRun),
  });

  const { type, ...rest } = input.payload;
  const payloadDigest = sha256Hex(JSON.stringify({ type, ...rest }));
  const idempotencyKey = sha256Hex(`${scope.workspaceId}:${type}:${payloadDigest}`);

  if (!decision.allow) {
    await withTransaction(ctx.pool, (client) =>
      writeAudit(client, {
        workspaceId: scope.workspaceId,
        actorType: input.requestedVia === 'ai' ? 'ai' : 'user',
        actorId: scope.userId,
        action: `action.propose:${type}`,
        targetType: 'action',
        targetId: null,
        payload: { digest: payloadDigest },
        result: 'denied',
        reason: decision.reason,
      }),
    );
    throw new ForbiddenError(decision.reason);
  }

  const action = await withTransaction(ctx.pool, async (client) => {
    const row = await insertAction(client, {
      workspaceId: scope.workspaceId,
      type,
      payload: rest as Record<string, unknown>,
      payloadDigest,
      summary: summarize(input.payload),
      requestedBy: scope.userId,
      requestedVia: input.requestedVia,
      requiresApproval: decision.requiresApproval,
      policyReason: decision.reason,
      idempotencyKey,
      sourceMeetingId: input.sourceMeetingId ?? null,
      dryRun: Boolean(input.dryRun),
    });
    await writeAudit(client, {
      workspaceId: scope.workspaceId,
      actorType: input.requestedVia === 'ai' ? 'ai' : 'user',
      actorId: scope.userId,
      action: `action.propose:${type}`,
      targetType: 'action',
      targetId: row.id,
      payload: { digest: payloadDigest },
      result: 'success',
      reason: decision.reason,
    });
    return row;
  });

  ctx.log.info('action_proposed', { actionId: action.id, type, requestedVia: input.requestedVia });
  return action;
}

export async function approveAction(
  ctx: PipelineContext,
  scope: Scope,
  actionId: string,
  payloadDigest: string,
): Promise<ActionRow> {
  const approved = await withTransaction(ctx.pool, async (client) => {
    const row = await approveActionRow(client, scope, actionId, payloadDigest);
    if (!row) return null;
    await writeAudit(client, {
      workspaceId: scope.workspaceId,
      actorType: 'user',
      actorId: scope.userId,
      action: `action.approve:${row.type}`,
      targetType: 'action',
      targetId: row.id,
      payload: { digest: payloadDigest },
      result: 'success',
    });
    await enqueueJob(client, {
      workspaceId: scope.workspaceId,
      type: 'action.execute',
      payload: { actionId: row.id, approvedByUserId: scope.userId },
      maxAttempts: 3,
    });
    return row;
  });

  if (!approved) {
    // Either it is not pending any more, or the payload changed since it was
    // shown to the approver. Both must fail closed.
    throw new ValidationError(
      'This action could not be approved: it is no longer pending, or its content changed since you reviewed it.',
    );
  }
  return approved;
}

export async function rejectAction(
  ctx: PipelineContext,
  scope: Scope,
  actionId: string,
  reason: string,
): Promise<ActionRow> {
  const row = await withTransaction(ctx.pool, async (client) => {
    const rejected = await rejectActionRow(client, scope, actionId, reason);
    if (!rejected) return null;
    await writeAudit(client, {
      workspaceId: scope.workspaceId,
      actorType: 'user',
      actorId: scope.userId,
      action: `action.reject:${rejected.type}`,
      targetType: 'action',
      targetId: rejected.id,
      result: 'success',
      reason,
    });
    return rejected;
  });
  if (!row) throw new ValidationError('Action is not in a rejectable state.');
  return row;
}

/** Decrypt, refresh if near expiry, re-encrypt. Tokens never leave this function. */
async function accessTokenFor(
  ctx: PipelineContext,
  input: { workspaceId: string; userId: string; kind: OAuthKind },
): Promise<string> {
  const integration = await findIntegration(ctx.pool, input);
  if (!integration) throw new ValidationError(`No connected ${input.kind} account for this user.`);

  const stored = JSON.parse(decryptSecret(integration.token_ciphertext, ctx.secretsKey)) as {
    accessToken: string;
    refreshToken?: string;
  };
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
  const needsRefresh = expiresAt > 0 && expiresAt - Date.now() < 120_000;

  if (!needsRefresh || !stored.refreshToken) return stored.accessToken;

  const refreshed = await refreshAccessToken({
    kind: input.kind,
    config: ctx.registry.oauthConfig(input.kind),
    refreshToken: stored.refreshToken,
  });
  await updateIntegrationTokens(ctx.pool, integration.id, {
    tokenCiphertext: encryptSecret(
      JSON.stringify({ accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken }),
      ctx.secretsKey,
    ),
    tokenExpiresAt: refreshed.expiresAt,
  });
  return refreshed.accessToken;
}

export interface ExecutionResult {
  status: 'executed' | 'failed';
  providerResponseId?: string;
  error?: string;
}

/**
 * Execute an approved action. Runs in the worker, never in a request.
 * A dry run performs no external call and is labelled as such everywhere.
 */
export async function executeAction(ctx: PipelineContext, actionId: string): Promise<ExecutionResult> {
  const claimed = await claimActionForExecution(ctx.pool, actionId);
  if (!claimed) {
    // Not approved, or another worker already took it. Never execute twice.
    return { status: 'failed', error: 'Action is not in an executable state.' };
  }

  const started = Date.now();
  try {
    if (claimed.requires_approval && !claimed.approved_by) {
      throw new ForbiddenError('Refusing to execute an action without a recorded approval.');
    }

    let providerResponseId: string;
    let providerId: string;

    if (claimed.dry_run) {
      providerId = 'dry-run';
      providerResponseId = `DRY-RUN-${claimed.id}`;
      ctx.log.warn('action_dry_run', { actionId: claimed.id, type: claimed.type });
    } else if (claimed.type === 'email.send') {
      const payload = emailSendPayload.parse(claimed.payload);
      const kind: OAuthKind = payload.provider === 'gmail' ? 'google' : 'microsoft';
      const integration = await findIntegration(ctx.pool, {
        workspaceId: claimed.workspace_id,
        userId: claimed.approved_by ?? claimed.requested_by!,
        kind,
      });
      const accessToken = await accessTokenFor(ctx, {
        workspaceId: claimed.workspace_id,
        userId: claimed.approved_by ?? claimed.requested_by!,
        kind,
      });
      const provider = ctx.registry.email(payload.provider);
      const sent = await provider.send({
        accessToken,
        draft: { to: payload.to, cc: payload.cc, subject: payload.subject, body: payload.body },
        fromAddress: integration?.external_account_email ?? 'me',
        idempotencyKey: claimed.idempotency_key,
      });
      providerId = provider.id;
      providerResponseId = sent.messageId;
    } else if (claimed.type === 'calendar.create_event') {
      const payload = calendarEventPayload.parse(claimed.payload);
      const kind: OAuthKind = payload.provider === 'google' ? 'google' : 'microsoft';
      const accessToken = await accessTokenFor(ctx, {
        workspaceId: claimed.workspace_id,
        userId: claimed.approved_by ?? claimed.requested_by!,
        kind,
      });
      const provider = ctx.registry.calendar(payload.provider);
      const created = await provider.createEvent({
        accessToken,
        draft: {
          title: payload.title,
          description: payload.description,
          startsAt: payload.startsAt,
          endsAt: payload.endsAt,
          timeZone: payload.timeZone,
          attendees: payload.attendees,
          location: payload.location,
        },
        idempotencyKey: claimed.idempotency_key,
      });
      providerId = provider.id;
      providerResponseId = created.externalId;
    } else {
      throw new ValidationError(`Unsupported action type: ${claimed.type}`);
    }

    await completeAction(ctx.pool, claimed.id, { providerId, providerResponseId });
    await recordProviderCall(ctx.pool, {
      workspaceId: claimed.workspace_id,
      providerKind: claimed.type.startsWith('email') ? 'email' : 'calendar',
      providerId,
      operation: claimed.type,
      latencyMs: Date.now() - started,
      outcome: 'success',
    });
    await withTransaction(ctx.pool, (client) =>
      writeAudit(client, {
        workspaceId: claimed.workspace_id,
        actorType: 'system',
        actorId: null,
        action: `action.execute:${claimed.type}`,
        targetType: 'action',
        targetId: claimed.id,
        payload: { providerResponseId, dryRun: claimed.dry_run },
        result: 'success',
        reason: claimed.dry_run ? 'dry run: no external call was made' : null,
      }),
    );
    return { status: 'executed', providerResponseId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failAction(ctx.pool, claimed.id, message);
    await recordProviderCall(ctx.pool, {
      workspaceId: claimed.workspace_id,
      providerKind: claimed.type.startsWith('email') ? 'email' : 'calendar',
      providerId: 'unknown',
      operation: claimed.type,
      latencyMs: Date.now() - started,
      outcome: 'failure',
      errorCode: message.slice(0, 80),
    });
    await withTransaction(ctx.pool, (client) =>
      writeAudit(client, {
        workspaceId: claimed.workspace_id,
        actorType: 'system',
        actorId: null,
        action: `action.execute:${claimed.type}`,
        targetType: 'action',
        targetId: claimed.id,
        result: 'failure',
        reason: message.slice(0, 500),
      }),
    );
    ctx.log.error('action_failed', { actionId: claimed.id, type: claimed.type });
    return { status: 'failed', error: message };
  }
}

export async function getAction(ctx: PipelineContext, scope: Scope, id: string): Promise<ActionRow | null> {
  return findAction(ctx.pool, scope, id);
}
