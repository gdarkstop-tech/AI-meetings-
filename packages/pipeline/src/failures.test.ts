import { describe, expect, it } from 'vitest';
import { ProviderCapabilityError, ProviderNotConfiguredError } from '@alia/core';
import { describePipelineFailure, isPermanentFailure, PipelineStepError } from './failures.js';
import { MediaError } from './media.js';

describe('pipeline failure reasons shown to users', () => {
  const leaky = new Error(
    'Deepgram request failed (401): {"err_msg":"Invalid credentials sk-live-0123456789abcdef"} ' +
      'at transcribe (/app/node_modules/@alia/providers/src/asr/deepgram.ts:101:13)',
  );

  it('never passes an unrecognised error message through, only the stage sentence', () => {
    const failure = describePipelineFailure('asr.transcribe', leaky);
    expect(failure.code).toBe('TRANSCRIPTION_FAILED');
    for (const fragment of ['sk-live', '401', 'Invalid credentials', 'node_modules', 'deepgram.ts', 'Deepgram request failed']) {
      expect(failure.reason).not.toContain(fragment);
    }
  });

  it('explains an unconfigured provider in fixed words', () => {
    expect(describePipelineFailure('asr.transcribe', new ProviderNotConfiguredError('asr'))).toEqual({
      code: 'TRANSCRIPTION_NOT_CONFIGURED',
      reason: 'Speech-to-text is not configured. Configure a provider, then use Re-transcribe.',
    });
    expect(describePipelineFailure('analysis.run', new ProviderNotConfiguredError('llm')).code).toBe('ANALYSIS_NOT_CONFIGURED');
  });

  it('uses the message of our own typed errors, which we wrote', () => {
    const quota = new PipelineStepError('AUDIO_QUOTA_EXCEEDED', 'This workspace has used its monthly audio allowance.');
    expect(describePipelineFailure('asr.transcribe', quota)).toEqual({
      code: 'AUDIO_QUOTA_EXCEEDED',
      reason: 'This workspace has used its monthly audio allowance.',
    });
    const language = new ProviderCapabilityError('asr', 'Deepgram cannot transcribe mixed Arabic/English audio.');
    expect(describePipelineFailure('asr.transcribe', language)).toEqual({
      code: 'PROVIDER_CANNOT_PROCESS',
      reason: 'Deepgram cannot transcribe mixed Arabic/English audio.',
    });
  });

  it('reports an interrupted job without any error detail', () => {
    expect(describePipelineFailure('asr.transcribe', leaky, { interrupted: true }).code).toBe('PROCESSING_INTERRUPTED');
  });

  it('does not show ffmpeg output for an unreadable recording', () => {
    const failure = describePipelineFailure('media.normalize', new MediaError('Invalid data found when processing input /tmp/x', 'MEDIA_INVALID'));
    expect(failure).toEqual({ code: 'MEDIA_INVALID', reason: 'The recording could not be read as audio or video.' });
  });
});

describe('which failures are worth retrying', () => {
  it('does not retry what cannot change, especially paid calls', () => {
    expect(isPermanentFailure(new ProviderNotConfiguredError('asr'))).toBe(true);
    expect(isPermanentFailure(new ProviderCapabilityError('asr', 'unsupported'))).toBe(true);
    expect(isPermanentFailure(new PipelineStepError('NO_SPEECH_DETECTED', 'No speech.'))).toBe(true);
    expect(isPermanentFailure(new MediaError('bad file', 'MEDIA_INVALID'))).toBe(true);
  });

  it('retries what may be transient', () => {
    expect(isPermanentFailure(new Error('socket hang up'))).toBe(false);
    expect(isPermanentFailure(new MediaError('ffmpeg crashed', 'TRANSCODE_FAILED'))).toBe(false);
    expect(isPermanentFailure(new PipelineStepError('X', 'transient', false))).toBe(false);
  });
});
