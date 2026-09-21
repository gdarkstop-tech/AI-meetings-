import { randomBytes } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import {
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
  displayNameSchema,
  emailSchema,
  localeSchema,
  passwordSchema,
} from '@alia/core';
import {
  addMember,
  createSession,
  createUser,
  createWorkspace,
  findMembership,
  findUserByEmail,
  generateSessionToken,
  listMembershipsForUser,
  revokeSession,
  setSessionWorkspace,
  touchLastLogin,
  updateUserPreferences,
  withTransaction,
  writeAudit,
} from '@alia/db';
import { permissionsFor } from '@alia/policy';
import type { Config } from '../config.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, parseBody } from './helpers.js';

const registerSchema = z.object({
  email: emailSchema,
  name: displayNameSchema,
  password: passwordSchema,
  locale: localeSchema.default('en'),
  workspaceName: displayNameSchema.optional(),
});

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });
const switchSchema = z.object({ workspaceId: z.string().uuid() });
const prefsSchema = z.object({ locale: localeSchema.optional(), timezone: z.string().min(1).max(64).optional() });

export function authRoutes(config: Config): Router {
  const router = Router();
  const ttlSeconds = config.SESSION_TTL_HOURS * 3600;

  const setSessionCookie = (res: Response, token: string): void => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: ttlSeconds * 1000,
      path: '/',
    });
  };

  const registerLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_REGISTER_WINDOW_MS,
    max: config.RATE_LIMIT_REGISTER_MAX,
    name: 'register',
  });
  const loginLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_LOGIN_WINDOW_MS,
    max: config.RATE_LIMIT_LOGIN_MAX,
    name: 'login',
  });

  router.post(
    '/register',
    registerLimiter,
    asyncHandler(async (req, res) => {
      const input = parseBody(registerSchema, req.body);
      const existing = await findUserByEmail(req.ctx.pool, input.email);
      if (existing) throw new ConflictError('An account with this email already exists.');

      const passwordHash = await hashPassword(input.password);
      const token = generateSessionToken();
      const csrfToken = randomBytes(24).toString('base64url');

      const result = await withTransaction(req.ctx.pool, async (client) => {
        const user = await createUser(client, {
          email: input.email,
          name: input.name,
          passwordHash,
          locale: input.locale,
        });
        const workspace = await createWorkspace(client, {
          name: input.workspaceName ?? `${input.name} workspace`,
          localeDefault: input.locale,
        });
        await addMember(client, { workspaceId: workspace.id, userId: user.id, role: 'owner' });
        await writeAudit(client, {
          workspaceId: workspace.id,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.register',
          targetType: 'user',
          targetId: user.id,
          result: 'success',
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        });
        await createSession(client, {
          userId: user.id,
          token,
          csrfToken,
          workspaceId: workspace.id,
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          ttlSeconds,
        });
        return { user, workspace };
      });

      setSessionCookie(res, token);
      req.ctx.log.info('user_registered', { userId: result.user.id, workspaceId: result.workspace.id });
      res.status(201).json({
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          locale: result.user.locale,
          timezone: result.user.timezone,
        },
        workspace: { id: result.workspace.id, name: result.workspace.name, role: 'owner' },
        csrfToken,
      });
    }),
  );

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const input = parseBody(loginSchema, req.body);
      const user = await findUserByEmail(req.ctx.pool, input.email);
      const ok = user ? await verifyPassword(input.password, user.password_hash) : false;

      if (!user || !ok || user.status !== 'active') {
        await withTransaction(req.ctx.pool, (client) =>
          writeAudit(client, {
            workspaceId: null,
            actorType: 'user',
            actorId: user?.id ?? null,
            action: 'auth.login',
            targetType: 'user',
            targetId: user?.id ?? null,
            result: 'failure',
            reason: user ? 'invalid_password_or_inactive' : 'unknown_email',
            ip: req.ip ?? null,
            userAgent: req.get('user-agent') ?? null,
          }),
        );
        req.ctx.log.warn('login_failed', { emailKnown: Boolean(user) });
        // Same message for both cases: do not reveal which emails exist.
        throw new UnauthenticatedError('Invalid email or password.');
      }

      const memberships = await listMembershipsForUser(req.ctx.pool, user.id);
      const token = generateSessionToken();
      const csrfToken = randomBytes(24).toString('base64url');
      const workspaceId = memberships[0]?.workspace_id ?? null;

      await withTransaction(req.ctx.pool, async (client) => {
        await createSession(client, {
          userId: user.id,
          token,
          csrfToken,
          workspaceId,
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          ttlSeconds,
        });
        await touchLastLogin(client, user.id);
        await writeAudit(client, {
          workspaceId,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.login',
          targetType: 'user',
          targetId: user.id,
          result: 'success',
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        });
      });

      setSessionCookie(res, token);
      req.ctx.log.info('user_logged_in', { userId: user.id });
      res.json({
        user: { id: user.id, email: user.email, name: user.name, locale: user.locale, timezone: user.timezone },
        workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.name, role: m.role })),
        currentWorkspaceId: workspaceId,
        csrfToken,
      });
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    asyncHandler(async (req, res) => {
      const session = req.ctx.session!;
      await withTransaction(req.ctx.pool, async (client) => {
        await revokeSession(client, session.id);
        await writeAudit(client, {
          workspaceId: session.workspaceId,
          actorType: 'user',
          actorId: session.userId,
          action: 'auth.logout',
          targetType: 'session',
          targetId: session.id,
          result: 'success',
          ip: req.ip ?? null,
        });
      });
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.ctx.user!;
      const memberships = await listMembershipsForUser(req.ctx.pool, user.id);
      const scope = req.ctx.scope;
      res.json({
        user,
        workspaces: memberships.map((m) => ({
          id: m.workspace_id,
          name: m.name,
          role: m.role,
          localeDefault: m.locale_default,
          timezone: m.timezone,
        })),
        currentWorkspaceId: scope?.workspaceId ?? null,
        role: scope?.role ?? null,
        permissions: scope ? permissionsFor(scope.role) : [],
        csrfToken: req.ctx.session!.csrfToken,
      });
    }),
  );

  router.post(
    '/switch-workspace',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { workspaceId } = parseBody(switchSchema, req.body);
      const membership = await findMembership(req.ctx.pool, workspaceId, req.ctx.user!.id);
      if (!membership) throw new ForbiddenError('You are not a member of that workspace.');

      await withTransaction(req.ctx.pool, async (client) => {
        await setSessionWorkspace(client, req.ctx.session!.id, workspaceId);
        await writeAudit(client, {
          workspaceId,
          actorType: 'user',
          actorId: req.ctx.user!.id,
          action: 'workspace.switch',
          targetType: 'workspace',
          targetId: workspaceId,
          result: 'success',
        });
      });
      res.json({ workspaceId, role: membership.role, permissions: permissionsFor(membership.role) });
    }),
  );

  router.post(
    '/preferences',
    requireAuth,
    asyncHandler(async (req, res) => {
      const prefs = parseBody(prefsSchema, req.body);
      const updated = await updateUserPreferences(req.ctx.pool, req.ctx.user!.id, prefs);
      if (!updated) throw new UnauthenticatedError();
      await withTransaction(req.ctx.pool, (client) =>
        writeAudit(client, {
          workspaceId: req.ctx.session!.workspaceId,
          actorType: 'user',
          actorId: updated.id,
          action: 'user.preferences.update',
          targetType: 'user',
          targetId: updated.id,
          payload: prefs,
          result: 'success',
        }),
      );
      res.json({ locale: updated.locale, timezone: updated.timezone });
    }),
  );

  return router;
}
