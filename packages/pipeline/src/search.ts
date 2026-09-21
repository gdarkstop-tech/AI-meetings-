import { normalizeForSearch } from '@alia/core';
import type { Scope } from '@alia/core';
import { lexicalSearch, vectorSearch, type Pool, type SearchHit, type SearchHitType } from '@alia/db';
import type { ProviderRegistry } from '@alia/providers';

export interface FusedHit {
  type: SearchHitType;
  id: string;
  meetingId: string | null;
  meetingTitle: string | null;
  title: string;
  snippet: string;
  startMs: number | null;
  occurredAt: string | null;
  score: number;
  matchedBy: Array<'lexical' | 'semantic'>;
}

/**
 * Reciprocal rank fusion: combines lexical and semantic result lists without
 * needing their scores to be comparable. Pure function, unit-tested.
 */
export function reciprocalRankFusion(
  lists: Array<{ source: 'lexical' | 'semantic'; ids: string[] }>,
  k = 60,
): Map<string, { score: number; sources: Array<'lexical' | 'semantic'> }> {
  const fused = new Map<string, { score: number; sources: Array<'lexical' | 'semantic'> }>();
  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const existing = fused.get(id) ?? { score: 0, sources: [] };
      existing.score += 1 / (k + index + 1);
      if (!existing.sources.includes(list.source)) existing.sources.push(list.source);
      fused.set(id, existing);
    });
  }
  return fused;
}

export interface SearchOutcome {
  hits: FusedHit[];
  semanticAvailable: boolean;
  /** Honest note shown in the UI when semantic search could not run. */
  degradedReason: string | null;
}

export async function searchWorkspace(input: {
  pool: Pool;
  registry: ProviderRegistry;
  scope: Scope;
  query: string;
  types?: SearchHitType[];
  limit?: number;
}): Promise<SearchOutcome> {
  const normalized = normalizeForSearch(input.query);
  if (!normalized) return { hits: [], semanticAvailable: false, degradedReason: null };

  const lexical = await lexicalSearch(input.pool, input.scope, {
    normalizedQuery: normalized,
    types: input.types,
    limit: (input.limit ?? 25) * 2,
  });

  let semanticAvailable = false;
  let degradedReason: string | null = null;
  const semanticHits: SearchHit[] = [];

  if (input.registry.isConfigured('embeddings')) {
    try {
      const embeddings = input.registry.embeddings();
      const { vectors } = await embeddings.embed([input.query]);
      const rows = await vectorSearch(input.pool, input.scope, {
        embedding: vectors[0],
        limit: (input.limit ?? 25) * 2,
      });
      semanticAvailable = true;
      for (const row of rows) {
        semanticHits.push({
          type: 'segment',
          id: row.id,
          meeting_id: row.meeting_id,
          meeting_title: row.meeting_title,
          title: row.speaker,
          snippet: row.text,
          start_ms: row.start_ms,
          occurred_at: row.occurred_at,
          rank: 1 - row.distance,
        });
      }
    } catch (error) {
      degradedReason = `Semantic search unavailable: ${(error as Error).message}`;
    }
  } else {
    degradedReason = 'Semantic search is not configured; showing keyword matches only.';
  }

  const byId = new Map<string, SearchHit>();
  for (const hit of [...lexical, ...semanticHits]) byId.set(hit.id, byId.get(hit.id) ?? hit);

  const fused = reciprocalRankFusion([
    { source: 'lexical', ids: lexical.map((h) => h.id) },
    { source: 'semantic', ids: semanticHits.map((h) => h.id) },
  ]);

  const hits: FusedHit[] = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, input.limit ?? 25)
    .map(([id, meta]) => {
      const hit = byId.get(id)!;
      return {
        type: hit.type,
        id: hit.id,
        meetingId: hit.meeting_id,
        meetingTitle: hit.meeting_title,
        title: hit.title,
        snippet: hit.snippet.length > 400 ? `${hit.snippet.slice(0, 400)}…` : hit.snippet,
        startMs: hit.start_ms,
        occurredAt: hit.occurred_at ? new Date(hit.occurred_at).toISOString() : null,
        score: Number(meta.score.toFixed(6)),
        matchedBy: meta.sources,
      };
    });

  return { hits, semanticAvailable, degradedReason };
}
