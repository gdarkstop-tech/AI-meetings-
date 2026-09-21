import { z } from 'zod';
import type { EmbeddingsProvider } from '../types.js';

/**
 * OpenAI embeddings (text-embedding-3-small by default, 1536 dimensions to
 * match the `vector(1536)` column). A provider whose dimension count differs
 * is rejected at construction rather than silently corrupting the index.
 */
const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  usage: z.object({ prompt_tokens: z.number().optional() }).optional(),
});

export interface OpenAiEmbeddingsConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
}

export class OpenAiEmbeddingsProvider implements EmbeddingsProvider {
  readonly id = 'openai';
  readonly modelVersion: string;
  readonly dimensions: number;

  constructor(private readonly config: OpenAiEmbeddingsConfig) {
    this.modelVersion = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; usage: { inputTokens?: number } }> {
    if (texts.length === 0) return { vectors: [], usage: {} };
    const base = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.modelVersion, input: texts, dimensions: this.dimensions }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const parsed = responseSchema.parse(await res.json());
    const vectors = parsed.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: provider returned ${vector.length}, storage expects ${this.dimensions}.`,
        );
      }
    }
    return { vectors, usage: { inputTokens: parsed.usage?.prompt_tokens } };
  }
}
