import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@alia/core';

/**
 * Central error handler. Clients get a stable code and a correlation id;
 * stack traces and internal details never leave the server.
 */
export function errorHandler(isProduction: boolean) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = req.ctx?.requestId ?? 'unknown';

    if (err instanceof AppError) {
      req.ctx?.log.warn('request_failed', {
        code: err.code,
        status: err.httpStatus,
        reason: err.message,
      });
      res.status(err.httpStatus).json({
        error: { code: err.code, message: err.message, requestId, details: err.details ?? undefined },
      });
      return;
    }

    req.ctx?.log.error('unhandled_error', {
      error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      stack: !isProduction && err instanceof Error ? err.stack?.split('\n').slice(0, 4) : undefined,
    });
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'Internal server error', requestId },
    });
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.ctx?.requestId ?? 'unknown' },
  });
}
