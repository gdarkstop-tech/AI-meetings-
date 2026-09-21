import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, ValidationError, encryptSecret, sha256Hex, type Scope } from '@alia/core';
import {
  addMember,
  createUser,
  createWorkspace,
  findAction,
  listActions,
  updateWorkspaceSettings,
  upsertIntegration,
  withTransaction,
  type Pool,
} from '@alia/db';
import { approveAction, executeAction, proposeAction, rejectAction } from './gateway.js';
import type { PipelineContext } from './context.js';
import { buildTestPipeline, hasTestDatabase, setupTestDatabase, uniqueEmail } from '../../../test/support/db.js';

const d = hasTestDatabase ? describe : describe.skip;

d('Action Gateway (nothing leaves the system without approval)', () => {
  let pool: Pool;
  let ctx: PipelineContext;
  let scope: Scope;

  const emailPayload = {
    type: 'email.send' as const,
    provider: 'gmail' as const,
    to: ['client@example.test'],
    subject: 'Follow-up from our meeting',
    body: 'As discussed, the website ships Thursday.',
  };

  beforeAll(async () => {
    pool = await setupTestDatabase();
    ctx = buildTestPipeline(pool, {});
    const created = await withTransaction(pool, async (client) => {
      const user = await createUser(client, {
        email: uniqueEmail('gateway'),
        name: 'Gateway Tester',
        passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      });
      const workspace = await createWorkspace(client, { name: 'Gateway workspace' });
      await addMember(client, { workspaceId: workspace.id, userId: user.id, role: 'owner' });
      return { user, workspace };
    });
    scope = { workspaceId: created.workspace.id, userId: created.user.id, role: 'owner' };
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('refuses to propose an external action while the workspace has them disabled', async () => {
    await expect(
      proposeAction(ctx, scope, { payload: emailPayload, requestedVia: 'ai' }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses when no account is connected, even with external actions enabled', async () => {
    await updateWorkspaceSettings(pool, scope.workspaceId, { externalActionsEnabled: true });
    await expect(
      proposeAction(ctx, scope, { payload: emailPayload, requestedVia: 'ai' }),
    ).rejects.toThrow(/No connected account/i);
  });

  describe('with a connected account', () => {
    beforeAll(async () => {
      await updateWorkspaceSettings(pool, scope.workspaceId, { externalActionsEnabled: true });
      await upsertIntegration(pool, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        kind: 'google',
        scopes: ['https://www.googleapis.com/auth/gmail.send'],
        tokenCiphertext: encryptSecret(
          JSON.stringify({ accessToken: 'test-access-token', refreshToken: 'test-refresh-token' }),
          ctx.secretsKey,
        ),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'ceo@example.test',
      });
    });

    it('creates a PROPOSED action that requires approval, even when the AI asked for it', async () => {
      const action = await proposeAction(ctx, scope, { payload: emailPayload, requestedVia: 'ai' });
      expect(action.status).toBe('proposed');
      expect(action.requires_approval).toBe(true);
      expect(action.policy_reason).toMatch(/approval required/i);
      expect(action.provider_response_id).toBeNull();
    });

    it('is idempotent: proposing the same payload twice does not create two actions', async () => {
      const first = await proposeAction(ctx, scope, { payload: emailPayload, requestedVia: 'ui' });
      const second = await proposeAction(ctx, scope, { payload: emailPayload, requestedVia: 'ui' });
      expect(second.id).toBe(first.id);
      const all = await listActions(pool, scope, { status: 'proposed' });
      expect(all.filter((a) => a.payload_digest === first.payload_digest)).toHaveLength(1);
    });

    it('refuses to execute an action that has not been approved', async () => {
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'Unapproved send' },
        requestedVia: 'ai',
      });
      const result = await executeAction(ctx, action.id);
      expect(result.status).toBe('failed');
      const after = await findAction(pool, scope, action.id);
      expect(after?.status).toBe('proposed');
      expect(after?.provider_response_id).toBeNull();
    });

    it('rejects approval when the payload digest does not match what was reviewed', async () => {
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'Digest check' },
        requestedVia: 'ui',
      });
      await expect(approveAction(ctx, scope, action.id, sha256Hex('something-else'))).rejects.toThrow(ValidationError);
      const after = await findAction(pool, scope, action.id);
      expect(after?.status).toBe('proposed');
    });

    it('approves with the correct digest and queues execution rather than sending inline', async () => {
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'Approved send' },
        requestedVia: 'ui',
      });
      const approved = await approveAction(ctx, scope, action.id, action.payload_digest);
      expect(approved.status).toBe('approved');
      expect(approved.approved_by).toBe(scope.userId);

      const queued = await pool.query(
        `SELECT count(*)::int AS c FROM jobs WHERE type = 'action.execute' AND payload->>'actionId' = $1`,
        [action.id],
      );
      expect((queued.rows[0] as { c: number }).c).toBe(1);
    });

    it('executes a dry run without any external call and labels it as such', async () => {
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'Dry run only' },
        requestedVia: 'ui',
        dryRun: true,
      });
      await approveAction(ctx, scope, action.id, action.payload_digest);
      const result = await executeAction(ctx, action.id);
      expect(result.status).toBe('executed');
      expect(result.providerResponseId).toMatch(/^DRY-RUN-/);
      const after = await findAction(pool, scope, action.id);
      expect(after?.dry_run).toBe(true);
    });

    it('does not execute the same approved action twice', async () => {
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'Once only' },
        requestedVia: 'ui',
        dryRun: true,
      });
      await approveAction(ctx, scope, action.id, action.payload_digest);
      const first = await executeAction(ctx, action.id);
      const second = await executeAction(ctx, action.id);
      expect(first.status).toBe('executed');
      expect(second.status).toBe('failed');
    });

    it('records a failure honestly when the provider call fails', async () => {
      // Real Gmail call with a bogus token: it must fail and be recorded as failed.
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'Will fail at the provider' },
        requestedVia: 'ui',
      });
      await approveAction(ctx, scope, action.id, action.payload_digest);
      const result = await executeAction(ctx, action.id);
      expect(result.status).toBe('failed');
      const after = await findAction(pool, scope, action.id);
      expect(after?.status).toBe('failed');
      expect(after?.error).toBeTruthy();
      expect(after?.provider_response_id).toBeNull();
    }, 30_000);

    it('can reject a proposed action, which then cannot be executed', async () => {
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'To be rejected' },
        requestedVia: 'ai',
      });
      const rejected = await rejectAction(ctx, scope, action.id, 'Not appropriate to send');
      expect(rejected.status).toBe('rejected');
      const result = await executeAction(ctx, action.id);
      expect(result.status).toBe('failed');
    });

    it('writes an audit trail for propose, approve and execute', async () => {
      const action = await proposeAction(ctx, scope, {
        payload: { ...emailPayload, subject: 'Audited action' },
        requestedVia: 'ai',
        dryRun: true,
      });
      await approveAction(ctx, scope, action.id, action.payload_digest);
      await executeAction(ctx, action.id);
      const { rows } = await pool.query<{ action: string; result: string }>(
        `SELECT action, result FROM audit_log WHERE workspace_id = $1 AND target_id = $2 ORDER BY seq ASC`,
        [scope.workspaceId, action.id],
      );
      const actions = rows.map((r) => r.action);
      expect(actions.some((a) => a.startsWith('action.propose'))).toBe(true);
      expect(actions.some((a) => a.startsWith('action.approve'))).toBe(true);
      expect(actions.some((a) => a.startsWith('action.execute'))).toBe(true);
    });
  });
});
