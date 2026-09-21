import { Router } from 'express';
import { checkExtensions, pingDatabase } from '@alia/db';
import { providerStatuses } from '@alia/providers';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from './helpers.js';

const startedAt = Date.now();

export function systemRoutes(): Router {
  const router = Router();

  /** Liveness: the process is up. No dependencies touched. */
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  /** Readiness: the database answers and required extensions are installed. */
  router.get(
    '/ready',
    asyncHandler(async (req, res) => {
      if (!(await pingDatabase(req.ctx.pool))) {
        res.status(503).json({
          status: 'unavailable',
          database: 'unreachable',
          requestId: req.ctx.requestId,
        });
        return;
      }
      const extensions = await checkExtensions(req.ctx.pool);
      const missing = extensions.filter((e) => !e.installed).map((e) => e.name);
      res.status(missing.length ? 503 : 200).json({
        status: missing.length ? 'degraded' : 'ok',
        database: 'ok',
        extensions,
        missing,
      });
    }),
  );

  /**
   * Honest capability report: which external providers are configured.
   * Phase 1 has none; the UI uses this to show features as unavailable rather
   * than pretending they work.
   */
  router.get('/api/v1/system/capabilities', requireAuth, (_req, res) => {
    const providers = providerStatuses();
    res.json({
      phase: 1,
      providers,
      features: {
        auth: 'available',
        workspaces: 'available',
        audit: 'available',
        jobQueue: 'available',
        meetings: 'not_implemented',
        transcription: 'not_configured',
        analysis: 'not_configured',
        search: 'not_implemented',
        askAi: 'not_implemented',
        integrations: 'not_configured',
      },
    });
  });

  return router;
}
