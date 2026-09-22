import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderNotConfiguredError, type Scope } from '@alia/core';
import {
  addMember,
  createResearchRequest,
  createUser,
  createWorkspace,
  findResearchReport,
  findResearchRequest,
  listResearchSources,
  withTransaction,
  type Pool,
} from '@alia/db';
import type {
  LLMJsonRequest,
  LLMJsonResult,
  LLMProvider,
  ProviderRegistry,
  WebSearchProvider,
} from '@alia/providers';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchResearchPage, findingsSchema, htmlToText, isBlockedAddress, resolvePublicUrl, runResearch } from './research.js';
import type { PipelineContext } from './context.js';
import { buildTestPipeline, hasTestDatabase, setupTestDatabase, uniqueEmail } from '../../../test/support/db.js';

const d = hasTestDatabase ? describe : describe.skip;

/** Scripted providers, local to this test file, exercising OUR validation. */
class ScriptedLLM implements LLMProvider {
  readonly id = 'scripted-test';
  readonly modelVersion = 'scripted-1';
  constructor(private readonly plan: unknown, private readonly findings: unknown) {}
  async completeJson<T>(request: LLMJsonRequest<T>): Promise<LLMJsonResult<T>> {
    const payload = request.schema === (findingsSchema as never) ? this.findings : this.plan;
    return {
      value: request.schema.parse(payload) as T,
      modelVersion: this.modelVersion,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
    };
  }
}

class ScriptedSearch implements WebSearchProvider {
  readonly id = 'scripted-search';
  public queries: string[] = [];
  async search(input: { query: string; limit: number }) {
    this.queries.push(input.query);
    return [
      { url: 'https://example.test/market-report', title: 'Market report', snippet: 'Egypt market grew 12% in 2026.', publisher: 'example.test' },
      { url: 'https://example.test/competitors', title: 'Competitor list', snippet: 'Three main competitors operate locally.', publisher: 'example.test' },
    ];
  }
}

function registryWith(llm: LLMProvider | null, search: WebSearchProvider | null): ProviderRegistry {
  const missing = (kind: string) => () => {
    throw new ProviderNotConfiguredError(kind);
  };
  return {
    statuses: () => [],
    isConfigured: (kind) => (kind === 'llm' ? Boolean(llm) : kind === 'search' ? Boolean(search) : false),
    storage: missing('storage'),
    asr: missing('asr'),
    embeddings: missing('embeddings'),
    calendar: missing('calendar') as never,
    email: missing('email') as never,
    oauthConfig: missing('oauth') as never,
    llm: () => {
      if (!llm) throw new ProviderNotConfiguredError('llm');
      return llm;
    },
    webSearch: () => {
      if (!search) throw new ProviderNotConfiguredError('search');
      return search;
    },
  };
}

d('research pipeline (provenance or nothing)', () => {
  let pool: Pool;
  let scope: Scope;
  let base: PipelineContext;

  beforeAll(async () => {
    pool = await setupTestDatabase();
    base = buildTestPipeline(pool, {});
    const created = await withTransaction(pool, async (client) => {
      const user = await createUser(client, {
        email: uniqueEmail('research'),
        name: 'Research Tester',
        passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      });
      const workspace = await createWorkspace(client, { name: 'Research workspace' });
      await addMember(client, { workspaceId: workspace.id, userId: user.id, role: 'owner' });
      return { user, workspace };
    });
    scope = { workspaceId: created.workspace.id, userId: created.user.id, role: 'owner' };
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('refuses to run without a web search provider instead of answering from memory', async () => {
    const request = await createResearchRequest(pool, scope, { question: 'Who are our competitors in Egypt?' });
    const ctx: PipelineContext = { ...base, registry: registryWith(new ScriptedLLM({}, {}), null) };
    await expect(runResearch(ctx, request.id)).rejects.toThrow(ProviderNotConfiguredError);
  });

  it('stores every source with its URL and retrieval time, and drops uncited findings', async () => {
    const request = await createResearchRequest(pool, scope, { question: 'Who are our competitors in Egypt?' });
    const search = new ScriptedSearch();
    const llm = new ScriptedLLM(
      { queries: ['competitors in Egypt', 'Egypt market 2026'], rationale: 'coverage' },
      {
        summary: 'Three competitors; market grew 12%.',
        gaps: ['No pricing data in these sources'],
        findings: [
          { claim: 'The market grew 12% in 2026', detail: 'Reported by the market report', source_numbers: [1], confidence: 'high' },
          { claim: 'Three main competitors operate locally', detail: 'From the competitor list', source_numbers: [2], confidence: 'medium' },
          // Fabricated: cites a source that was never retrieved.
          { claim: 'A fourth competitor raised $50M', detail: 'invented', source_numbers: [99], confidence: 'high' },
        ],
      },
    );
    const ctx: PipelineContext = { ...base, registry: registryWith(llm, search) };

    const outcome = await runResearch(ctx, request.id);

    expect(outcome.sources).toBeGreaterThan(0);
    expect(outcome.findings).toBe(2);
    expect(outcome.droppedFindings).toBe(1);
    expect(search.queries).toContain('competitors in Egypt');

    const sources = await listResearchSources(pool, request.id);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.retrieved_at).toBeInstanceOf(Date);
      expect(source.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    const report = await findResearchReport(pool, request.id);
    expect(report).not.toBeNull();
    expect(report!.report_md).toContain('Sources');
    expect(report!.report_md).not.toContain('fourth competitor');
    expect(report!.report_md).toContain('Not answered by these sources');

    const updated = await findResearchRequest(pool, scope, request.id);
    expect(updated?.status).toBe('completed');
  }, 60_000);

  it('marks the request failed when search returns nothing, without inventing a report', async () => {
    const request = await createResearchRequest(pool, scope, { question: 'A question with no results at all' });
    const emptySearch: WebSearchProvider = { id: 'empty', search: async () => [] };
    const ctx: PipelineContext = {
      ...base,
      registry: registryWith(new ScriptedLLM({ queries: ['nothing'], rationale: 'x' }, {}), emptySearch),
    };
    const outcome = await runResearch(ctx, request.id);
    expect(outcome.sources).toBe(0);
    expect(await findResearchReport(pool, request.id)).toBeNull();
    const updated = await findResearchRequest(pool, scope, request.id);
    expect(updated?.status).toBe('failed');
  });

  it('extracts readable text from HTML for citation', () => {
    const html = '<html><head><style>body{}</style></head><body><h1>Title</h1><p>Hello &amp; welcome</p><script>evil()</script></body></html>';
    const text = htmlToText(html);
    expect(text).toBe('Title Hello & welcome');
    expect(text).not.toContain('evil');
  });
});

/**
 * Regression tests for the SSRF defect found in verification: the research
 * fetcher used to follow any URL a search provider returned, including internal
 * addresses and redirects to cloud metadata endpoints.
 */
describe('research fetcher SSRF guard', () => {
  it('blocks loopback, private, link-local, CGNAT and reserved addresses', () => {
    for (const address of [
      '127.0.0.1', '127.9.9.9', '0.0.0.0', '10.1.2.3', '172.16.5.4', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1',
      '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip',
    ]) {
      expect(isBlockedAddress(address), `${address} must be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedAddress(address), `${address} must be allowed`).toBe(false);
    }
  });

  it('refuses non-http schemes, credentials in the URL, and private hosts', async () => {
    expect(await resolvePublicUrl('file:///etc/passwd')).toBeNull();
    expect(await resolvePublicUrl('ftp://example.com/x')).toBeNull();
    expect(await resolvePublicUrl('http://user:pass@example.com/')).toBeNull();
    expect(await resolvePublicUrl('http://127.0.0.1:9911/')).toBeNull();
    expect(await resolvePublicUrl('http://localhost:9911/')).toBeNull();
    expect(await resolvePublicUrl('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(await resolvePublicUrl('http://[::1]/')).toBeNull();
    expect(await resolvePublicUrl('not a url at all')).toBeNull();
  });

  it('does not read an internal service even when it is reachable and returns HTML', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>INTERNAL-ONLY-SECRET</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const text = await fetchResearchPage(`http://127.0.0.1:${port}/`);
      expect(text).toBeNull();
      // The guard runs before any request: the internal service was never hit.
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  }, 20_000);

  it('does not follow a redirect that points at an internal address', async () => {
    let metadataHits = 0;
    const internal = createServer((_req, res) => {
      metadataHits += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>credentials</html>');
    });
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve));
    const internalPort = (internal.address() as AddressInfo).port;

    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));

    try {
      // The first hop is itself loopback, so it is refused outright; the point
      // of the assertion is that the internal target is never fetched.
      const text = await fetchResearchPage(
        `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/`,
      );
      expect(text).toBeNull();
      expect(metadataHits).toBe(0);
    } finally {
      internal.close();
      redirector.close();
    }
  }, 20_000);
});
