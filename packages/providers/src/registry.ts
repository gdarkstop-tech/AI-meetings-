import { ProviderNotConfiguredError } from '@alia/core';
import type {
  CalendarProvider,
  EmailProvider,
  EmbeddingsProvider,
  LLMProvider,
  ProviderKind,
  ProviderStatus,
  StorageProvider,
  TranscriptionProvider,
  WebSearchProvider,
} from './types.js';

/** Env var that selects each provider, and the phase that implements it. */
const PROVIDER_ENV: Record<ProviderKind, { env: string; phase: number; purpose: string }> = {
  storage: { env: 'STORAGE_PROVIDER', phase: 2, purpose: 'meeting media storage' },
  asr: { env: 'ASR_PROVIDER', phase: 3, purpose: 'speech-to-text' },
  llm: { env: 'LLM_PROVIDER', phase: 4, purpose: 'summaries and extraction' },
  embeddings: { env: 'EMBEDDINGS_PROVIDER', phase: 6, purpose: 'semantic search' },
  calendar: { env: 'CALENDAR_PROVIDER', phase: 10, purpose: 'calendar integration' },
  email: { env: 'EMAIL_PROVIDER', phase: 11, purpose: 'email integration' },
  search: { env: 'WEB_SEARCH_PROVIDER', phase: 13, purpose: 'research' },
};

export type Env = Record<string, string | undefined>;

function configuredId(kind: ProviderKind, env: Env): string | null {
  const value = env[PROVIDER_ENV[kind].env];
  return value && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Honest capability report. A provider with no configuration is reported as
 * `configured: false` and every call throws ProviderNotConfiguredError.
 * There are no fallbacks, no stub results and no mock data.
 */
export function providerStatuses(env: Env = process.env): ProviderStatus[] {
  return (Object.keys(PROVIDER_ENV) as ProviderKind[]).map((kind) => {
    const id = configuredId(kind, env);
    const meta = PROVIDER_ENV[kind];
    return {
      kind,
      providerId: id,
      configured: false, // No real adapter exists yet in Phase 1 — see reason.
      reason: id
        ? `"${id}" is selected but no adapter is implemented yet (planned for phase ${meta.phase}).`
        : `No ${kind} provider configured (${meta.env} unset). Required for ${meta.purpose} in phase ${meta.phase}.`,
      plannedPhase: meta.phase,
    };
  });
}

function unconfigured(kind: ProviderKind): never {
  throw new ProviderNotConfiguredError(kind);
}

/**
 * Resolvers. Each throws until its phase ships a real adapter. Callers must not
 * catch this error and substitute placeholder data.
 */
export function getStorageProvider(_env: Env = process.env): StorageProvider {
  return unconfigured('storage');
}
export function getTranscriptionProvider(_env: Env = process.env): TranscriptionProvider {
  return unconfigured('asr');
}
export function getLLMProvider(_env: Env = process.env): LLMProvider {
  return unconfigured('llm');
}
export function getEmbeddingsProvider(_env: Env = process.env): EmbeddingsProvider {
  return unconfigured('embeddings');
}
export function getEmailProvider(_env: Env = process.env): EmailProvider {
  return unconfigured('email');
}
export function getCalendarProvider(_env: Env = process.env): CalendarProvider {
  return unconfigured('calendar');
}
export function getWebSearchProvider(_env: Env = process.env): WebSearchProvider {
  return unconfigured('search');
}
