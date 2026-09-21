import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import type { TranscriptionProvider, TranscriptionResult, TranscriptSegmentDraft } from '../types.js';

/**
 * Deepgram pre-recorded transcription.
 * API verified 2026-09-21: POST https://api.deepgram.com/v1/listen with
 * `Authorization: Token <key>`; raw audio bytes as the body; results at
 * results.channels[].alternatives[].words[] and results.utterances[].
 */
const wordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
  speaker: z.number().optional(),
  punctuated_word: z.string().optional(),
});

const responseSchema = z.object({
  metadata: z
    .object({ duration: z.number().optional(), models: z.array(z.string()).optional() })
    .partial()
    .optional(),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z.array(
            z.object({
              transcript: z.string().optional(),
              words: z.array(wordSchema).optional(),
            }),
          ),
          detected_language: z.string().optional(),
        }),
      )
      .optional(),
    utterances: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          transcript: z.string(),
          confidence: z.number().optional(),
          speaker: z.number().optional(),
          languages: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  }),
});

export interface DeepgramConfig {
  apiKey: string;
  model?: string;
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'deepgram';
  readonly modelVersion: string;

  constructor(private readonly config: DeepgramConfig) {
    this.modelVersion = config.model ?? 'nova-3';
  }

  async transcribe(input: {
    filePath: string;
    mimeType: string;
    languageHint: 'ar' | 'en' | 'mixed';
    diarize: boolean;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    // nova-3 handles Arabic and code-switching through `language=multi`.
    const language = input.languageHint === 'en' ? 'en' : 'multi';
    const params = new URLSearchParams({
      model: this.modelVersion,
      language,
      punctuate: 'true',
      smart_format: 'true',
      diarize: String(input.diarize),
      utterances: 'true',
    });

    const blob = await openAsBlob(input.filePath, { type: input.mimeType });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.config.apiKey}`,
        'Content-Type': input.mimeType,
      },
      body: blob,
      signal: input.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Deepgram request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const parsed = responseSchema.parse(await res.json());
    const segments: TranscriptSegmentDraft[] = [];

    if (parsed.results.utterances?.length) {
      for (const utterance of parsed.results.utterances) {
        if (!utterance.transcript.trim()) continue;
        segments.push({
          startMs: Math.round(utterance.start * 1000),
          endMs: Math.round(utterance.end * 1000),
          speaker: utterance.speaker === undefined ? 'Speaker 1' : `Speaker ${utterance.speaker + 1}`,
          text: utterance.transcript.trim(),
          ...(utterance.confidence === undefined ? {} : { confidence: utterance.confidence }),
          ...(utterance.languages?.[0] ? { language: utterance.languages[0] } : {}),
        });
      }
    } else {
      // Fall back to grouping words by speaker when utterances are absent.
      const words = parsed.results.channels?.[0]?.alternatives?.[0]?.words ?? [];
      let current: TranscriptSegmentDraft | null = null;
      for (const word of words) {
        const speaker = word.speaker === undefined ? 'Speaker 1' : `Speaker ${word.speaker + 1}`;
        const text = word.punctuated_word ?? word.word;
        if (!current || current.speaker !== speaker || word.start * 1000 - current.endMs > 1500) {
          if (current) segments.push(current);
          current = {
            startMs: Math.round(word.start * 1000),
            endMs: Math.round(word.end * 1000),
            speaker,
            text,
          };
        } else {
          current.text += ` ${text}`;
          current.endMs = Math.round(word.end * 1000);
        }
      }
      if (current) segments.push(current);
    }

    const audioSeconds = parsed.metadata?.duration ?? 0;
    return {
      segments,
      providerId: this.id,
      modelVersion: parsed.metadata?.models?.[0] ?? this.modelVersion,
      detectedLanguage: parsed.results.channels?.[0]?.detected_language,
      usage: {
        audioSeconds,
        // Published pay-as-you-go rate for nova-3 multilingual, 2026-09-21.
        costUsd: audioSeconds > 0 ? Number(((audioSeconds / 60) * 0.0052).toFixed(6)) : undefined,
      },
    };
  }
}
