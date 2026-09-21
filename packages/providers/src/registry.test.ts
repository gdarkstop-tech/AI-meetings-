import { describe, expect, it } from 'vitest';
import { ProviderNotConfiguredError } from '@alia/core';
import { createProviderRegistry } from './index.js';

describe('provider registry', () => {
  it('throws ProviderNotConfiguredError instead of returning a stub when nothing is configured', () => {
    const registry = createProviderRegistry({});
    expect(() => registry.storage()).toThrow(ProviderNotConfiguredError);
    expect(() => registry.asr()).toThrow(ProviderNotConfiguredError);
    expect(() => registry.llm()).toThrow(ProviderNotConfiguredError);
    expect(() => registry.embeddings()).toThrow(ProviderNotConfiguredError);
    expect(() => registry.webSearch()).toThrow(ProviderNotConfiguredError);
    expect(() => registry.calendar('google')).toThrow(ProviderNotConfiguredError);
    expect(() => registry.email('gmail')).toThrow(ProviderNotConfiguredError);
  });

  it('reports NOT_CONFIGURED with HTTP 503 so the API never fakes success', () => {
    try {
      createProviderRegistry({}).asr();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ProviderNotConfiguredError).code).toBe('NOT_CONFIGURED');
      expect((err as ProviderNotConfiguredError).httpStatus).toBe(503);
    }
  });

  it('names the exact missing environment variables', () => {
    const statuses = createProviderRegistry({ ASR_PROVIDER: 'deepgram' }).statuses();
    const asr = statuses.find((s) => s.kind === 'asr');
    expect(asr?.configured).toBe(false);
    expect(asr?.requires).toContain('DEEPGRAM_API_KEY');
  });

  it('builds a real local storage provider when configured', async () => {
    const registry = createProviderRegistry({
      STORAGE_PROVIDER: 'local',
      STORAGE_LOCAL_DIR: '/tmp/alia-registry-test',
    });
    expect(registry.isConfigured('storage')).toBe(true);
    const storage = registry.storage();
    expect(storage.id).toBe('local');
    const written = await storage.put({
      key: 'probe/hello.txt',
      body: Buffer.from('real bytes'),
      contentType: 'text/plain',
    });
    expect(written.bytes).toBe(10);
    expect((await storage.getBuffer('probe/hello.txt')).toString()).toBe('real bytes');
    await storage.deletePrefix('probe');
    expect(await storage.head('probe/hello.txt')).toBeNull();
  });

  it('builds real ASR and LLM adapters from configuration without calling out', () => {
    const registry = createProviderRegistry({
      ASR_PROVIDER: 'elevenlabs',
      ELEVENLABS_API_KEY: 'test-key-not-used-in-this-test',
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key-not-used-in-this-test',
      LLM_MODEL: 'claude-opus-5',
    });
    expect(registry.asr().id).toBe('elevenlabs');
    expect(registry.asr().modelVersion).toBe('scribe_v2');
    expect(registry.llm().id).toBe('anthropic');
    expect(registry.llm().modelVersion).toBe('claude-opus-5');
    const statuses = registry.statuses();
    expect(statuses.find((s) => s.kind === 'asr')?.configured).toBe(true);
    expect(statuses.find((s) => s.kind === 'llm')?.configured).toBe(true);
    expect(statuses.find((s) => s.kind === 'storage')?.configured).toBe(false);
  });

  it('requires a public base URL before OAuth can be used', () => {
    const partial = createProviderRegistry({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    expect(() => partial.oauthConfig('google')).toThrow(ProviderNotConfiguredError);
    const full = createProviderRegistry({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      PUBLIC_BASE_URL: 'https://app.example.com',
    });
    expect(full.oauthConfig('google').redirectUri).toBe(
      'https://app.example.com/api/v1/integrations/google/callback',
    );
  });
});
