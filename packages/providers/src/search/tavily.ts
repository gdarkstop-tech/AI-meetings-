import { z } from 'zod';
import type { WebSearchProvider, WebSearchResult } from '../types.js';

/** Tavily web search, used by the research pipeline. Every result keeps its URL. */
const responseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string(),
        content: z.string().optional(),
      }),
    )
    .default([]),
});

export class TavilySearchProvider implements WebSearchProvider {
  readonly id = 'tavily';

  constructor(private readonly apiKey: string) {}

  async search(input: { query: string; limit: number }): Promise<WebSearchResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query: input.query,
        max_results: Math.min(input.limit, 10),
        include_answer: false,
      }),
    });
    if (!res.ok) throw new Error(`Tavily search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const parsed = responseSchema.parse(await res.json());
    return parsed.results.map((r) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: r.content ?? '',
      publisher: (() => {
        try {
          return new URL(r.url).hostname;
        } catch {
          return undefined;
        }
      })(),
    }));
  }
}
