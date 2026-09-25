import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderCapabilityError } from '@alia/core';
import { DeepgramTranscriptionProvider, deepgramLanguage } from './deepgram.js';

/**
 * These tests replace `fetch` only to inspect the request the adapter would
 * send to Deepgram. They verify our language mapping; they are not evidence
 * that Deepgram transcribes anything, and no real request is made.
 */
describe('Deepgram adapter language handling', () => {
  let dir: string;
  let audio: string;
  const provider = new DeepgramTranscriptionProvider({ apiKey: 'test-key-not-real' });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'alia-deepgram-'));
    audio = path.join(dir, 'audio.ogg');
    await writeFile(audio, Buffer.alloc(64, 1));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cannedResponse = () =>
    new Response(
      JSON.stringify({
        metadata: { duration: 2, models: ['nova-3'] },
        results: {
          utterances: [{ start: 0, end: 1.5, transcript: 'مرحبا', speaker: 0, confidence: 0.9 }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const captureRequest = () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return cannedResponse();
      }),
    );
    return calls;
  };

  it('sends an Arabic meeting as language=ar, never the multilingual mode that excludes Arabic', async () => {
    const calls = captureRequest();
    const result = await provider.transcribe({ filePath: audio, mimeType: 'audio/ogg', languageHint: 'ar', diarize: true });
    expect(calls).toHaveLength(1);
    const params = new URL(calls[0]).searchParams;
    expect(params.get('language')).toBe('ar');
    expect(params.get('diarize')).toBe('true');
    expect(result.segments[0]).toMatchObject({ text: 'مرحبا', speaker: 'Speaker 1', startMs: 0, endMs: 1500 });
  });

  it('sends an English meeting as language=en', async () => {
    const calls = captureRequest();
    await provider.transcribe({ filePath: audio, mimeType: 'audio/ogg', languageHint: 'en', diarize: true });
    expect(new URL(calls[0]).searchParams.get('language')).toBe('en');
  });

  it('refuses a mixed Arabic/English meeting before any request is made', async () => {
    const calls = captureRequest();
    await expect(
      provider.transcribe({ filePath: audio, mimeType: 'audio/ogg', languageHint: 'mixed', diarize: true }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(calls).toEqual([]);
  });

  it('never maps any language hint to `multi`', () => {
    expect(deepgramLanguage('ar')).toBe('ar');
    expect(deepgramLanguage('en')).toBe('en');
    expect(() => deepgramLanguage('mixed')).toThrow(/does not include Arabic/);
  });
});
