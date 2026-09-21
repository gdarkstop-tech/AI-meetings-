import { describe, expect, it } from 'vitest';
import { ProviderNotConfiguredError } from '@alia/core';
import {
  getCalendarProvider,
  getEmailProvider,
  getEmbeddingsProvider,
  getLLMProvider,
  getStorageProvider,
  getTranscriptionProvider,
  getWebSearchProvider,
  providerStatuses,
} from './index.js';

describe('provider registry (Phase 1: nothing configured, nothing faked)', () => {
  it('every resolver throws ProviderNotConfiguredError instead of returning a stub', () => {
    const resolvers = [
      getStorageProvider,
      getTranscriptionProvider,
      getLLMProvider,
      getEmbeddingsProvider,
      getEmailProvider,
      getCalendarProvider,
      getWebSearchProvider,
    ];
    for (const resolve of resolvers) {
      expect(() => resolve({})).toThrow(ProviderNotConfiguredError);
    }
  });

  it('reports NOT_CONFIGURED as the error code so the API surfaces 503, not a fake success', () => {
    try {
      getTranscriptionProvider({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotConfiguredError);
      expect((err as ProviderNotConfiguredError).code).toBe('NOT_CONFIGURED');
      expect((err as ProviderNotConfiguredError).httpStatus).toBe(503);
    }
  });

  it('status report is honest even when an env var names a provider', () => {
    const statuses = providerStatuses({ ASR_PROVIDER: 'deepgram' });
    const asr = statuses.find((s) => s.kind === 'asr');
    expect(asr?.providerId).toBe('deepgram');
    expect(asr?.configured).toBe(false);
    expect(asr?.reason).toMatch(/no adapter is implemented yet/i);
  });

  it('covers every provider kind with a planned phase', () => {
    const statuses = providerStatuses({});
    expect(statuses.map((s) => s.kind).sort()).toEqual(
      ['asr', 'calendar', 'email', 'embeddings', 'llm', 'search', 'storage'].sort(),
    );
    expect(statuses.every((s) => s.plannedPhase > 1)).toBe(true);
  });
});
