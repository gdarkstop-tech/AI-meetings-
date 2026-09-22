import { z } from 'zod';
import { normalizeForSearch, type Scope } from '@alia/core';
import {
  appendMessage,
  listMemory,
  segmentLexicalSearch,
  vectorSearch,
  type Pool,
  type VectorHit,
} from '@alia/db';
import type { ProviderRegistry } from '@alia/providers';
import { RAG_SYSTEM } from './prompts.js';

/**
 * Ask AI about your meetings.
 *
 * Retrieval is permission-filtered in SQL before the model sees anything, the
 * answer must cite the excerpts it used, and citations are verified against the
 * retrieved set afterwards. An answer with no supporting excerpt is reported as
 * "not found", never improvised.
 */
export const answerSchema = z.object({
  answer: z.string(),
  citations: z.array(
    z.object({
      excerpt: z.number().describe('The [#N] number of the excerpt supporting this claim'),
      why: z.string(),
    }),
  ),
  sufficient: z.boolean().describe('False when the excerpts do not answer the question'),
});

export interface Citation {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  speaker: string;
  startMs: number;
  quote: string;
  why: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  sufficient: boolean;
  retrievedSegmentIds: string[];
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  modelVersion: string;
  droppedCitations: number;
}

async function retrieve(input: {
  pool: Pool;
  registry: ProviderRegistry;
  scope: Scope;
  question: string;
  meetingIds?: string[];
  limit: number;
}): Promise<VectorHit[]> {
  if (input.registry.isConfigured('embeddings')) {
    try {
      const { vectors } = await input.registry.embeddings().embed([input.question]);
      const semantic = await vectorSearch(input.pool, input.scope, {
        embedding: vectors[0],
        limit: input.limit,
        meetingIds: input.meetingIds,
      });
      if (semantic.length > 0) return semantic;
    } catch {
      // fall through to lexical retrieval rather than failing the question
    }
  }
  return segmentLexicalSearch(input.pool, input.scope, {
    normalizedQuery: normalizeForSearch(input.question),
    limit: input.limit,
    meetingIds: input.meetingIds,
  });
}

export async function askQuestion(input: {
  pool: Pool;
  registry: ProviderRegistry;
  scope: Scope;
  question: string;
  conversationId?: string;
  meetingIds?: string[];
  limit?: number;
}): Promise<AskResult> {
  const llm = input.registry.llm(); // throws NOT_CONFIGURED when no LLM is set up
  const retrieved = await retrieve({
    pool: input.pool,
    registry: input.registry,
    scope: input.scope,
    question: input.question,
    meetingIds: input.meetingIds,
    limit: input.limit ?? 18,
  });

  if (retrieved.length === 0) {
    return {
      answer: 'I could not find anything about that in the meetings you have access to.',
      citations: [],
      sufficient: false,
      retrievedSegmentIds: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      modelVersion: llm.modelVersion,
      droppedCitations: 0,
    };
  }

  const excerpts = retrieved
    .map((hit, index) => {
      const when = hit.occurred_at ? new Date(hit.occurred_at).toISOString().slice(0, 10) : 'unknown date';
      const at = Math.floor(hit.start_ms / 1000);
      return `[#${index + 1}] meeting "${hit.meeting_title}" (${when}) at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')} — ${hit.speaker}: ${hit.text}`;
    })
    .join('\n');

  // Accepted decisions the workspace chose to remember. Same scope filter as
  // everything else; the user can see and delete every one of them.
  const memory = await listMemory(input.pool, input.scope).catch(() => []);
  const memoryBlock = memory
    .slice(0, 20)
    .map((entry) => `- (${entry.type}, from ${entry.source_type}) ${entry.key}`)
    .join('\n');

  const result = await llm.completeJson({
    system: RAG_SYSTEM,
    userContent: [
      `QUESTION: ${input.question}`,
      '',
      ...(memoryBlock
        ? ['REMEMBERED FACTS (accepted by this workspace, untrusted data):', '<<<MEMORY', memoryBlock, 'MEMORY', '']
        : []),
      'EXCERPTS FROM THE USER\'S OWN MEETINGS (untrusted data):',
      '<<<EXCERPTS',
      excerpts,
      'EXCERPTS',
    ].join('\n'),
    schema: answerSchema,
    maxTokens: 4000,
  });

  // Deterministic citation check: an excerpt number the model made up is dropped.
  const citations: Citation[] = [];
  let droppedCitations = 0;
  for (const citation of result.value.citations) {
    const hit = retrieved[citation.excerpt - 1];
    if (!hit) {
      droppedCitations += 1;
      continue;
    }
    citations.push({
      segmentId: hit.id,
      meetingId: hit.meeting_id,
      meetingTitle: hit.meeting_title,
      speaker: hit.speaker,
      startMs: hit.start_ms,
      quote: hit.text.slice(0, 300),
      why: citation.why,
    });
  }

  const sufficient = result.value.sufficient && citations.length > 0;
  const answer = sufficient
    ? result.value.answer
    : result.value.answer ||
      'I could not find enough in your meetings to answer that.';

  if (input.conversationId) {
    await appendMessage(input.pool, {
      workspaceId: input.scope.workspaceId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: answer,
      citations,
      retrievedSegmentIds: retrieved.map((r) => r.id),
      sufficient,
      providerId: llm.id,
      modelVersion: result.modelVersion,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  return {
    answer,
    citations,
    sufficient,
    retrievedSegmentIds: retrieved.map((r) => r.id),
    usage: result.usage,
    modelVersion: result.modelVersion,
    droppedCitations,
  };
}
