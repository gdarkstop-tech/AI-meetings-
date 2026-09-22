import type { Readable } from 'node:stream';
import type { ZodType } from 'zod';

/**
 * Provider contracts. Domain code depends on these interfaces only; vendor SDKs
 * may be imported nowhere else in the repository (ADR 0002, enforced by
 * scripts/check-boundaries.mjs).
 *
 * Every adapter is real. When an adapter has no credentials the registry throws
 * ProviderNotConfiguredError — it never returns a stub that invents data.
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
  providerId: string | null;
  configured: boolean;
  reason: string;
  /** Env vars that must be set for this provider to work. */
  requires: string[];
}

export interface StorageObject {
  key: string;
  bytes: number;
  contentType: string;
}

/** Byte range for partial reads, so media players can seek. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface StorageProvider {
  readonly id: string;
  put(input: { key: string; body: Buffer | Readable; contentType: string; bytes?: number }): Promise<StorageObject>;
  getStream(key: string, range?: ByteRange): Promise<Readable>;
  getBuffer(key: string): Promise<Buffer>;
  /** Copies the object to a local temp path so ffmpeg can work on a real file. */
  downloadToFile(key: string, destPath: string): Promise<{ path: string; bytes: number }>;
  putFromFile(input: { key: string; path: string; contentType: string }): Promise<StorageObject>;
  head(key: string): Promise<{ bytes: number } | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

export interface TranscriptSegmentDraft {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  /** Present only when the provider returns one. Never synthesized. */
  confidence?: number;
  language?: string;
}

export interface TranscriptionResult {
  segments: TranscriptSegmentDraft[];
  providerId: string;
  modelVersion: string;
  detectedLanguage?: string;
  usage: { audioSeconds: number; costUsd?: number };
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly modelVersion: string;
  transcribe(input: {
    filePath: string;
    mimeType: string;
    languageHint: 'ar' | 'en' | 'mixed';
    diarize: boolean;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult>;
}

export interface LLMJsonRequest<T> {
  system: string;
  /** Untrusted content (transcripts, emails, web pages) goes here, never in `system`. */
  userContent: string;
  schema: ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface LLMJsonResult<T> {
  value: T;
  modelVersion: string;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
}

export interface LLMProvider {
  readonly id: string;
  readonly modelVersion: string;
  completeJson<T>(request: LLMJsonRequest<T>): Promise<LLMJsonResult<T>>;
}

export interface EmbeddingsProvider {
  readonly id: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; usage: { inputTokens?: number } }>;
}

export interface CalendarEventDraft {
  title: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  attendees: string[];
  location?: string;
}

export interface CalendarEventSummary {
  externalId: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  attendees: string[];
  organizer?: string | null;
}

export interface CalendarProvider {
  readonly id: 'google' | 'microsoft';
  listEvents(input: { accessToken: string; from: string; to: string }): Promise<CalendarEventSummary[]>;
  createEvent(input: {
    accessToken: string;
    draft: CalendarEventDraft;
    idempotencyKey: string;
  }): Promise<{ externalId: string; htmlLink?: string }>;
  deleteEvent(input: { accessToken: string; externalId: string }): Promise<void>;
}

export interface EmailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface EmailSummary {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string | null;
}

export interface EmailProvider {
  readonly id: 'gmail' | 'microsoft';
  search(input: { accessToken: string; query: string; limit: number }): Promise<EmailSummary[]>;
  send(input: {
    accessToken: string;
    draft: EmailDraft;
    fromAddress: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;
}

export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  publisher?: string;
}

export interface WebSearchProvider {
  readonly id: string;
  search(input: { query: string; limit: number }): Promise<WebSearchResult[]>;
}
