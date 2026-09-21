import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthenticatedError, CsrfError } from '@alia/core';
import { findLiveSessionByToken, findUserById, findMembership, safeEquals, touchSession } from '@alia/db';
import { parseCookies } from './context.js';

export const SESSION_COOKIE = 'alia_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the session from the cookie and attaches user + scope.
 * The scope is built here from the database, never from client input:
 * a client cannot claim a workspace or a role it does not have.
 */
export function loadSession() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return next();

      const session = await findLiveSessionByToken(req.ctx.pool, token);
      if (!session) return next();

      const user = await findUserById(req.ctx.pool, session.user_id);
      if (!user || user.status !== 'active') return next();

      req.ctx.session = {
        id: session.id,
        userId: session.user_id,
        csrfToken: session.csrf_token,
        workspaceId: session.workspace_id,
      };
      req.ctx.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        locale: user.locale,
        timezone: user.timezone,
      };
      req.ctx.log = req.ctx.log.child({ userId: user.id });

      if (session.workspace_id) {
        const membership = await findMembership(req.ctx.pool, session.workspace_id, user.id);
        if (membership) {
          req.ctx.scope = {
            workspaceId: membership.workspace_id,
            userId: user.id,
            role: membership.role,
          };
          req.ctx.role = membership.role;
        }
      }
      void touchSession(req.ctx.pool, session.id).catch(() => undefined);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.ctx.user || !req.ctx.session) return next(new UnauthenticatedError());
  next();
}

export function requireScope(req: Request, _res: Response, next: NextFunction): void {
  if (!req.ctx.user) return next(new UnauthenticatedError());
  if (!req.ctx.scope) {
    return next(new ForbiddenError('No workspace selected for this session.'));
  }
  next();
}

/**
 * Double-submit CSRF: the token lives in the session row (server side) and must
 * be echoed in a header the browser cannot set cross-origin.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const session = req.ctx.session;
  if (!session) return next(); // unauthenticated routes (login/register) have no session yet
  const header = req.headers['x-csrf-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !safeEquals(provided, session.csrfToken)) {
    return next(new CsrfError());
  }
  next();
}
