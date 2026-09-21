import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import type { TranscriptionProvider, TranscriptionResult, TranscriptSegmentDraft } from '../types.js';

/**
 * ElevenLabs Scribe speech-to-text.
 * API verified 2026-09-21: POST https://api.elevenlabs.io/v1/speech-to-text,
 * `xi-api-key` header, multipart fields model_id / file / diarize /
 * language_code / timestamps_granularity; response { language_code, text,
 * words[{ text, type, start, end, speaker_id }] }.
 */
const responseSchema = z.object({
  language_code: z.string().optional(),
  text: z.string().optional(),
  words: z
    .array(
      z.object({
        text: z.string(),
        type: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
        speaker_id: z.string().optional(),
      }),
    )
    .default([]),
});

export interface ElevenLabsConfig {
  apiKey: string;
  model?: string;
}

export class ElevenLabsTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'elevenlabs';
  readonly modelVersion: string;

  constructor(private readonly config: ElevenLabsConfig) {
    this.modelVersion = config.model ?? 'scribe_v2';
  }

  async transcribe(input: {
    filePath: string;
    mimeType: string;
    languageHint: 'ar' | 'en' | 'mixed';
    diarize: boolean;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set('model_id', this.modelVersion);
    form.set('diarize', String(input.diarize));
    form.set('timestamps_granularity', 'word');
    // For mixed Arabic/English speech we let the provider detect the language
    // rather than forcing one and losing the other half of the conversation.
    if (input.languageHint === 'ar') form.set('language_code', 'ara');
    if (input.languageHint === 'en') form.set('language_code', 'eng');
    form.set('file', await openAsBlob(input.filePath, { type: input.mimeType }), 'audio');

    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': this.config.apiKey },
      body: form,
      signal: input.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const parsed = responseSchema.parse(await res.json());
    const segments: TranscriptSegmentDraft[] = [];
    let current: TranscriptSegmentDraft | null = null;
    let lastEnd = 0;

    for (const word of parsed.words) {
      if (word.type === 'audio_event') continue;
      const start = Math.round((word.start ?? 0) * 1000);
      const end = Math.round((word.end ?? word.start ?? 0) * 1000);
      lastEnd = Math.max(lastEnd, end);
      const speaker = word.speaker_id ? `Speaker ${word.speaker_id.replace(/^speaker_?/i, '')}` : 'Speaker 1';
      const isSpacing = word.type === 'spacing';

      if (!current || (!isSpacing && (current.speaker !== speaker || start - current.endMs > 1500))) {
        if (isSpacing) continue;
        if (current) segments.push({ ...current, text: current.text.trim() });
        current = { startMs: start, endMs: end, speaker, text: word.text };
      } else {
        current.text += isSpacing ? word.text : ` ${word.text}`;
        current.endMs = Math.max(current.endMs, end);
      }
    }
    if (current) segments.push({ ...current, text: current.text.trim() });

    const audioSeconds = lastEnd / 1000;
    return {
      segments: segments.filter((s) => s.text.length > 0),
      providerId: this.id,
      modelVersion: this.modelVersion,
      detectedLanguage: parsed.language_code,
      usage: {
        audioSeconds,
        // Published Scribe rate, 2026-09-21: $0.22 per hour.
        costUsd: audioSeconds > 0 ? Number(((audioSeconds / 3600) * 0.22).toFixed(6)) : undefined,
      },
    };
  }
}
