import { Router } from 'express';
import { checkExtensions, pingDatabase } from '@alia/db';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from './helpers.js';

const startedAt = Date.now();

/**
 * Health, readiness and an honest capability report.
 *
 * `capabilities` is what the UI renders: a feature backed by a configured
 * provider says so, and one without says exactly which environment variables
 * are missing. Nothing is described as working when it cannot run.
 */
export function systemRoutes(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  router.get(
    '/ready',
    asyncHandler(async (req, res) => {
      if (!(await pingDatabase(req.ctx.pool))) {
        res.status(503).json({ status: 'unavailable', database: 'unreachable', requestId: req.ctx.requestId });
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

  router.get('/api/v1/system/capabilities', requireAuth, (req, res) => {
    const providers = req.ctx.registry.statuses();
    const configured = (kind: string) => providers.find((p) => p.kind === kind)?.configured ?? false;
    res.json({
      providers,
      features: {
        auth: 'available',
        workspaces: 'available',
        audit: 'available',
        jobQueue: 'available',
        meetings: 'available',
        tasks: 'available',
        search: 'available',
        upload: configured('storage') ? 'available' : 'not_configured',
        transcription: configured('asr') ? 'available' : 'not_configured',
        analysis: configured('llm') ? 'available' : 'not_configured',
        semanticSearch: configured('embeddings') ? 'available' : 'not_configured',
        askAi: configured('llm') ? 'available' : 'not_configured',
        calendar: configured('calendar') ? 'available' : 'not_configured',
        email: configured('email') ? 'available' : 'not_configured',
        research: configured('search') ? 'available' : 'not_configured',
      },
    });
  });

  return router;
}
