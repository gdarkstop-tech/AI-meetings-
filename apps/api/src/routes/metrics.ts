import { Router } from 'express';
import { operationalMetrics } from '@alia/db';
import { asyncHandler } from './helpers.js';

/**
 * Prometheus-format metrics for monitoring and alerting.
 *
 * Exposed without a session because monitoring agents have none; protect it
 * with METRICS_TOKEN (bearer) when the endpoint is reachable from outside.
 * It contains counts only — no workspace names, no content.
 */
export function metricsRoutes(token: string | undefined): Router {
  const router = Router();

  router.get(
    '/metrics',
    asyncHandler(async (req, res) => {
      if (token) {
        const header = req.headers.authorization ?? '';
        if (header !== `Bearer ${token}`) {
          res.status(401).type('text/plain').send('unauthorized');
          return;
        }
      }
      const metrics = await operationalMetrics(req.ctx.pool);
      const lines: string[] = [
        '# HELP alia_jobs Jobs by status.',
        '# TYPE alia_jobs gauge',
        ...Object.entries(metrics.jobs).map(([status, count]) => `alia_jobs{status="${status}"} ${count}`),
        '# HELP alia_meetings Meetings by status.',
        '# TYPE alia_meetings gauge',
        ...Object.entries(metrics.meetings).map(([status, count]) => `alia_meetings{status="${status}"} ${count}`),
        '# HELP alia_actions Gateway actions by status.',
        '# TYPE alia_actions gauge',
        ...Object.entries(metrics.actions).map(([status, count]) => `alia_actions{status="${status}"} ${count}`),
        '# HELP alia_provider_calls_24h Provider calls in the last 24 hours.',
        '# TYPE alia_provider_calls_24h counter',
        `alia_provider_calls_24h{outcome="success"} ${metrics.providerCalls.success}`,
        `alia_provider_calls_24h{outcome="failure"} ${metrics.providerCalls.failure}`,
        '# HELP alia_provider_cost_usd_24h Provider spend in the last 24 hours.',
        '# TYPE alia_provider_cost_usd_24h gauge',
        `alia_provider_cost_usd_24h ${metrics.providerCalls.costUsd}`,
        '# HELP alia_oldest_queued_job_seconds Age of the oldest queued job; alert if this keeps growing.',
        '# TYPE alia_oldest_queued_job_seconds gauge',
        `alia_oldest_queued_job_seconds ${metrics.oldestQueuedJobSeconds}`,
      ];
      res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
    }),
  );

  return router;
}
