/**
 * Provider contracts. Domain code depends on these interfaces only; vendor SDKs
 * may be imported nowhere else in the repository (enforced by
 * scripts/check-boundaries.mjs, ADR 0002).
 *
 * Phase 1 ships the contracts and the not-configured behaviour. Real adapters
 * arrive in the phases that need them (ASR: Phase 3, LLM: Phase 4,
 * embeddings: Phase 6, storage: Phase 2, email/calendar: Phases 10-11).
 */

export type ProviderKind =
  | 'storage'
  | 'llm'
  | 'asr'
  | 'embeddings'
  | 'email'
  | 'calendar'
  | 'search';

export interface ProviderStatus {
  kind: ProviderKind;
  /** Configured provider id, or null when the environment configures none. */
  providerId: string | null;
  configured: boolean;
  /** Human-readable reason shown in the UI when not configured. */
  reason: string;
  /** The phase that introduces the real adapter, for honest roadmap display. */
  plannedPhase: number;
}

export interface StorageProvider {
  readonly id: string;
  putObject(input: { key: string; body: Uint8Array; contentType: string }): Promise<{ key: string; bytes: number }>;
  getSignedUrl(input: { key: string; expiresInSeconds: number }): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  /** Only present when the provider actually returns one. Never synthesized. */
  confidence?: number;
}

export interface TranscriptionProvider {
  readonly id: string;
  transcribe(input: {
    mediaUri: string;
    languageHint: 'ar' | 'en' | 'mixed';
    diarize: boolean;
  }): Promise<{
    segments: TranscriptSegment[];
    providerId: string;
    modelVersion: string;
    usage: { audioSeconds: number; costUsd?: number };
  }>;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  readonly id: string;
  complete(input: {
    system: string;
    messages: LLMMessage[];
    maxTokens: number;
    temperature: number;
    /** JSON Schema the response must satisfy; validated by the caller. */
    jsonSchema?: unknown;
  }): Promise<{
    text: string;
    modelVersion: string;
    usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  }>;
}

export interface EmbeddingsProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; modelVersion: string }>;
}

export interface EmailProvider {
  readonly id: string;
  search(query: string): Promise<unknown[]>;
  createDraft(draft: unknown): Promise<{ draftId: string }>;
  send(draftId: string, idempotencyKey: string): Promise<{ messageId: string }>;
}

export interface CalendarProvider {
  readonly id: string;
  listEvents(range: { from: string; to: string }): Promise<unknown[]>;
  createEvent(draft: unknown, idempotencyKey: string): Promise<{ externalId: string }>;
}

export interface WebSearchProvider {
  readonly id: string;
  search(query: string): Promise<Array<{ url: string; title: string; snippet: string }>>;
}
