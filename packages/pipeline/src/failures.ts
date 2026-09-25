import { ProviderCapabilityError, ProviderNotConfiguredError } from '@alia/core';
import { MediaError } from './media.js';

/**
 * A pipeline step stopped for a reason we understand and wrote the words for.
 * Its message is safe to show a user. `permanent` means retrying cannot help —
 * the job is failed at once instead of being retried (and, for a paid provider,
 * paid for again).
 */
export class PipelineStepError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent = true,
  ) {
    super(message);
    this.name = 'PipelineStepError';
  }
}

/** Whether retrying the failed job could possibly change the outcome. */
export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof PipelineStepError) return error.permanent;
  if (error instanceof ProviderNotConfiguredError) return true;
  if (error instanceof ProviderCapabilityError) return true;
  if (error instanceof MediaError) return error.code !== 'TRANSCODE_FAILED';
  return false;
}

export interface MeetingFailure {
  code: string;
  reason: string;
}

const STAGE_FAILURE: Record<string, MeetingFailure> = {
  'media.normalize': {
    code: 'MEDIA_PROCESSING_FAILED',
    reason: 'The recording could not be prepared for transcription.',
  },
  'asr.transcribe': {
    code: 'TRANSCRIPTION_FAILED',
    reason: 'Transcription failed after several attempts. Try Re-transcribe; if it keeps failing, check the speech-to-text provider.',
  },
  'analysis.run': {
    code: 'ANALYSIS_FAILED',
    reason: 'The transcript is available, but AI analysis could not be completed. Try Re-run analysis.',
  },
};

const NOT_CONFIGURED: Record<string, MeetingFailure> = {
  asr: {
    code: 'TRANSCRIPTION_NOT_CONFIGURED',
    reason: 'Speech-to-text is not configured. Configure a provider, then use Re-transcribe.',
  },
  llm: {
    code: 'ANALYSIS_NOT_CONFIGURED',
    reason: 'AI analysis is not configured. The transcript is still available.',
  },
  storage: {
    code: 'STORAGE_NOT_CONFIGURED',
    reason: 'Media storage is not configured.',
  },
};

const MAX_REASON = 300;

/**
 * The code and user-facing reason recorded on a meeting whose pipeline failed.
 *
 * Only text we wrote reaches the user: fixed sentences, or the message of one
 * of our own typed errors, whose contract is that the message is safe to show.
 * A provider's response body, an exception message from a library, a stack
 * trace or a credential can never end up here — anything unrecognised falls
 * back to the stage's fixed sentence. The raw error stays in the job's
 * `last_error` and in the logs, neither of which any API returns.
 */
export function describePipelineFailure(
  jobType: string,
  error: unknown,
  options: { interrupted?: boolean } = {},
): MeetingFailure {
  const fallback = STAGE_FAILURE[jobType] ?? {
    code: 'PROCESSING_FAILED',
    reason: 'Processing failed.',
  };
  if (options.interrupted) {
    return {
      code: 'PROCESSING_INTERRUPTED',
      reason: 'Processing was interrupted repeatedly and has stopped. You can start it again from this page.',
    };
  }
  if (error instanceof PipelineStepError) return { code: error.code, reason: error.message.slice(0, MAX_REASON) };
  if (error instanceof ProviderNotConfiguredError) return NOT_CONFIGURED[error.providerKind] ?? fallback;
  if (error instanceof ProviderCapabilityError) {
    return { code: 'PROVIDER_CANNOT_PROCESS', reason: error.message.slice(0, MAX_REASON) };
  }
  if (error instanceof MediaError && error.code === 'MEDIA_INVALID') {
    return { code: 'MEDIA_INVALID', reason: 'The recording could not be read as audio or video.' };
  }
  return fallback;
}
