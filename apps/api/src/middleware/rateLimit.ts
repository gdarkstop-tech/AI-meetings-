import type { NextFunction, Request, Response } from 'express';
import { RateLimitedError } from '@alia/core';

/**
 * Fixed-window limiter held in process memory.
 *
 * LIMITATION (documented, not hidden): this protects a single process only.
 * A multi-instance deployment needs a shared store; that lands with the
 * production host decision (see docs/PLAN.md D1).
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: { windowMs: number; max: number; name: string }) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${options.name}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      }
      return next();
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader('retry-after', Math.ceil((bucket.resetAt - now) / 1000));
      return next(new RateLimitedError('Too many attempts. Please wait and try again.'));
    }
    next();
  };
}
