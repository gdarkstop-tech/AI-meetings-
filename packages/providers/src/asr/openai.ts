import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import type { TranscriptionProvider, TranscriptionResult, TranscriptSegmentDraft } from '../types.js';

/**
 * OpenAI audio transcription.
 * API verified 2026-09-21: POST https://api.openai.com/v1/audio/transcriptions,
 * Bearer auth, multipart (file, model, response_format, timestamp_granularities[]).
 *
 * whisper-1 with verbose_json returns segments but NO speaker labels. This
 * adapter therefore reports a single speaker and records `diarization: false`
 * in the result — it does not invent speakers.
 */
const responseSchema = z.object({
  language: z.string().optional(),
  duration: z.number().optional(),
  text: z.string().optional(),
  segments: z
    .array(
      z.object({
        id: z.number().optional(),
        start: z.number(),
        end: z.number(),
        text: z.string(),
        no_speech_prob: z.number().optional(),
        avg_logprob: z.number().optional(),
      }),
    )
    .optional(),
});

export interface OpenAiAsrConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'openai';
  readonly modelVersion: string;

  constructor(private readonly config: OpenAiAsrConfig) {
    this.modelVersion = config.model ?? 'whisper-1';
  }

  async transcribe(input: {
    filePath: string;
    mimeType: string;
    languageHint: 'ar' | 'en' | 'mixed';
    diarize: boolean;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set('model', this.modelVersion);
    form.set('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (input.languageHint === 'ar') form.set('language', 'ar');
    if (input.languageHint === 'en') form.set('language', 'en');
    form.set('file', await openAsBlob(input.filePath, { type: input.mimeType }), 'audio.ogg');

    const base = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form,
      signal: input.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI transcription failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const parsed = responseSchema.parse(await res.json());
    const segments: TranscriptSegmentDraft[] = (parsed.segments ?? [])
      .filter((s) => s.text.trim().length > 0)
      .map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        speaker: 'Speaker 1',
        text: s.text.trim(),
        ...(parsed.language ? { language: parsed.language } : {}),
      }));

    const audioSeconds = parsed.duration ?? 0;
    return {
      segments,
      providerId: this.id,
      modelVersion: this.modelVersion,
      detectedLanguage: parsed.language,
      usage: {
        audioSeconds,
        // Published whisper-1 rate, 2026-09-21: $0.006 per minute.
        costUsd: audioSeconds > 0 ? Number(((audioSeconds / 60) * 0.006).toFixed(6)) : undefined,
      },
    };
  }
}
