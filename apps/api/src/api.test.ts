import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from '@alia/db';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { createLogger } from '@alia/observability';
import {
  TEST_DATABASE_URL,
  TEST_PASSWORD,
  TEST_SECRETS_KEY,
  buildTestPipeline,
  hasTestDatabase,
  setupTestDatabase,
  uniqueEmail,
} from '../../../test/support/db.js';

const d = hasTestDatabase ? describe : describe.skip;
if (!hasTestDatabase) {
  console.warn('[api.test] SKIPPED: TEST_DATABASE_URL is not set. API tests run against a real database.');
}

interface Registered {
  agent: ReturnType<typeof request.agent>;
  userId: string;
  workspaceId: string;
  csrfToken: string;
  email: string;
}

d('API (real database, real HTTP)', () => {
  let pool: Pool;
  let app: Express;

  const registerUser = async (prefix: string, locale: 'ar' | 'en' = 'en'): Promise<Registered> => {
    const agent = request.agent(app);
    const email = uniqueEmail(prefix);
    const res = await agent
      .post('/api/v1/auth/register')
      .send({ email, name: `${prefix} user`, password: TEST_PASSWORD, locale });
    expect(res.status).toBe(201);
    return {
      agent,
      email,
      userId: res.body.user.id,
      workspaceId: res.body.workspace.id,
      csrfToken: res.body.csrfToken,
    };
  };

  beforeAll(async () => {
    pool = await setupTestDatabase();
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'error',
      // The suite registers many accounts from one IP; the login limiter keeps
      // its production value because the brute-force test asserts it fires.
      RATE_LIMIT_REGISTER_MAX: '500',
      SECRETS_KEY: TEST_SECRETS_KEY,
    } as NodeJS.ProcessEnv);
    app = buildServer({
      config,
      pipeline: buildTestPipeline(pool),
      logger: createLogger({ level: 'error', write: () => {} }),
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('health and readiness', () => {
    it('GET /health reports the process is up', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /ready checks the database and required extensions', async () => {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.database).toBe('ok');
      expect(res.body.missing).toEqual([]);
      expect(res.body.extensions.map((e: { name: string }) => e.name).sort()).toEqual([
        'pg_trgm',
        'unaccent',
        'vector',
      ]);
    });
  });

  describe('authentication', () => {
    it('registers, authenticates the session cookie and returns the profile', async () => {
      const user = await registerUser('reg');
      const me = await user.agent.get('/api/v1/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe(user.email);
      expect(me.body.currentWorkspaceId).toBe(user.workspaceId);
      expect(me.body.role).toBe('owner');
      expect(me.body.permissions).toContain('audit.read');
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(res.body.error.requestId).toBeTruthy();
    });

    it('gives the same error for an unknown email and a wrong password', async () => {
      const user = await registerUser('login');
      const wrongPassword = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'definitely-not-the-password' });
      const unknownEmail = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail('ghost'), password: TEST_PASSWORD });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });

    it('logs in with the correct password and revokes the session on logout', async () => {
      const user = await registerUser('logout');
      const agent = request.agent(app);
      const login = await agent.post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
      expect(login.status).toBe(200);
      const csrf = login.body.csrfToken;

      expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
      const logout = await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrf);
      expect(logout.status).toBe(204);
      expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    });

    it('rejects weak passwords and malformed emails', async () => {
      const short = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('weak'), name: 'Weak', password: 'short' });
      expect(short.status).toBe(400);
      expect(short.body.error.code).toBe('VALIDATION_FAILED');

      const badEmail = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', name: 'Bad', password: TEST_PASSWORD });
      expect(badEmail.status).toBe(400);
    });

    it('rejects a duplicate registration', async () => {
      const user = await registerUser('dup');
      const again = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: user.email, name: 'Dup', password: TEST_PASSWORD });
      expect(again.status).toBe(409);
    });
  });

  describe('CSRF protection', () => {
    it('blocks a state-changing request without the token and allows it with the token', async () => {
      const user = await registerUser('csrf');
      const without = await user.agent.post('/api/v1/auth/preferences').send({ locale: 'ar' });
      expect(without.status).toBe(403);
      expect(without.body.error.code).toBe('CSRF_FAILED');

      const withToken = await user.agent
        .post('/api/v1/auth/preferences')
        .set('x-csrf-token', user.csrfToken)
        .send({ locale: 'ar' });
      expect(withToken.status).toBe(200);
      expect(withToken.body.locale).toBe('ar');
    });

    it('rejects a forged CSRF token', async () => {
      const user = await registerUser('csrf2');
      const res = await user.agent
        .post('/api/v1/auth/preferences')
        .set('x-csrf-token', 'forged-token-value')
        .send({ locale: 'ar' });
      expect(res.status).toBe(403);
    });
  });

  describe('workspace isolation (the tenancy invariant)', () => {
    it('a user of workspace A cannot read ANY resource of workspace B', async () => {
      const alice = await registerUser('alice');
      const bob = await registerUser('bob');
      expect(alice.workspaceId).not.toBe(bob.workspaceId);

      for (const path of [
        `/api/v1/workspaces/${bob.workspaceId}`,
        `/api/v1/workspaces/${bob.workspaceId}/members`,
        `/api/v1/workspaces/${bob.workspaceId}/audit`,
        `/api/v1/workspaces/${bob.workspaceId}/audit/verify`,
        `/api/v1/workspaces/${bob.workspaceId}/jobs`,
      ]) {
        const res = await alice.agent.get(path);
        expect(res.status, `expected 403 for ${path}`).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(JSON.stringify(res.body)).not.toContain(bob.email);
      }
    });

    it('a user cannot switch into a workspace they do not belong to', async () => {
      const alice = await registerUser('alice2');
      const bob = await registerUser('bob2');
      const res = await alice.agent
        .post('/api/v1/auth/switch-workspace')
        .set('x-csrf-token', alice.csrfToken)
        .send({ workspaceId: bob.workspaceId });
      expect(res.status).toBe(403);
    });

    it('reads its own workspace successfully', async () => {
      const user = await registerUser('own');
      const res = await user.agent.get(`/api/v1/workspaces/${user.workspaceId}/members`);
      expect(res.status).toBe(200);
      expect(res.body.members).toHaveLength(1);
      expect(res.body.members[0].email).toBe(user.email);
    });
  });

  describe('audit trail', () => {
    it('records registration and login, and the chain verifies', async () => {
      const user = await registerUser('audited');
      const entries = await user.agent.get(`/api/v1/workspaces/${user.workspaceId}/audit`);
      expect(entries.status).toBe(200);
      const actions = entries.body.entries.map((e: { action: string }) => e.action);
      expect(actions).toContain('auth.register');

      const verify = await user.agent.get(`/api/v1/workspaces/${user.workspaceId}/audit/verify`);
      expect(verify.status).toBe(200);
      expect(verify.body.ok).toBe(true);
    });
  });

  describe('capabilities', () => {
    it('reports every external provider as not configured — no fake integrations', async () => {
      const user = await registerUser('caps');
      const res = await user.agent.get('/api/v1/system/capabilities');
      expect(res.status).toBe(200);
      expect(res.body.providers.every((p: { configured: boolean }) => p.configured === false)).toBe(true);
      expect(res.body.features.transcription).toBe('not_configured');
      expect(res.body.features.analysis).toBe('not_configured');
      expect(res.body.features.meetings).toBe('available');
    });
  });

  describe('rate limiting', () => {
    it('blocks brute-force login attempts with 429', async () => {
      const email = uniqueEmail('brute');
      const statuses: number[] = [];
      for (let i = 0; i < 25; i += 1) {
        const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password' });
        statuses.push(res.status);
        if (res.status === 429) break;
      }
      expect(statuses).toContain(429);
    });
  });

  describe('metrics', () => {
    it('exposes Prometheus metrics with counts and no content', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('alia_jobs{status=');
      expect(res.text).toContain('alia_oldest_queued_job_seconds');
      expect(res.text).toContain('alia_provider_cost_usd_24h');
      // Operational counts only — never workspace names or meeting titles.
      expect(res.text).not.toMatch(/@example\.test/);
    });

    it('requires the bearer token when one is configured', async () => {
      const guarded = buildServer({
        config: loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: TEST_DATABASE_URL,
          LOG_LEVEL: 'error',
          SECRETS_KEY: TEST_SECRETS_KEY,
          METRICS_TOKEN: 'secret-metrics-token',
        } as NodeJS.ProcessEnv),
        pipeline: buildTestPipeline(pool),
        logger: createLogger({ level: 'error', write: () => {} }),
      });
      expect((await request(guarded).get('/metrics')).status).toBe(401);
      const ok = await request(guarded).get('/metrics').set('Authorization', 'Bearer secret-metrics-token');
      expect(ok.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('returns a correlation id and never a stack trace', async () => {
      const res = await request(app).get('/api/v1/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body.error.requestId).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(/);
      expect(res.headers['x-request-id']).toBeTruthy();
    });
  });
});
