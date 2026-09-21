import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from '@alia/db';
import type { Scope, WorkspaceRole } from '@alia/core';
import type { Logger } from '@alia/observability';

export interface RequestContext {
  requestId: string;
  log: Logger;
  pool: Pool;
  session?: { id: string; userId: string; csrfToken: string; workspaceId: string | null };
  user?: { id: string; email: string; name: string; locale: 'ar' | 'en'; timezone: string };
  scope?: Scope;
  role?: WorkspaceRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

export function contextMiddleware(pool: Pool, log: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    res.setHeader('x-request-id', requestId);
    req.ctx = {
      requestId,
      pool,
      log: log.child({ requestId, method: req.method, path: req.path }),
    };
    next();
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
