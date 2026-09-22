import path from 'node:path';
import { normalizeForSearch } from '@alia/core';
import {
  addMeetingMedia,
  audioMinutesThisMonth,
  createTranscriptVersion,
  currentTranscriptVersion,
  enqueueJob,
  findMeetingUnscoped,
  findMedia,
  insertActionItems,
  insertDecisions,
  insertSegments,
  listMeetingMedia,
  listSegmentsForPipeline,
  markMediaPurged,
  meetingsPastRetention,
  purgeMeetingContent,
  recordDeletion,
  recordProviderCall,
  replaceChapters,
  replaceSummary,
  segmentsMissingEmbeddings,
  storeEmbeddings,
  transitionMeetingStatus,
  withTransaction,
  workspaceSettings,
  writeAudit,
  type JobRow,
} from '@alia/db';
import { analyzeTranscript } from './analysis.js';
import { executeAction } from './gateway.js';
import { runResearch } from './research.js';
import { normalizeToSpeechAudio, withTempDir } from './media.js';
import type { PipelineContext } from './context.js';

export type JobHandler = (ctx: PipelineContext, job: JobRow) => Promise<Record<string, unknown>>;

const scopeless = (workspaceId: string) => ({ workspaceId, userId: '00000000-0000-0000-0000-000000000000', role: 'owner' as const });

/** 1. Normalize uploaded media to mono 16 kHz speech audio with real ffmpeg. */
export const mediaNormalize: JobHandler = async (ctx, job) => {
  const meetingId = String(job.payload.meetingId);
  const meeting = await findMeetingUnscoped(ctx.pool, meetingId);
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

  const original = await findMedia(ctx.pool, scopeless(meeting.workspace_id), meetingId, 'original');
  if (!original) throw new Error('No original media to normalize');

  const storage = ctx.registry.storage();
  const result = await withTempDir(async (dir) => {
    const source = path.join(dir, 'source');
    await storage.downloadToFile(original.storage_key, source);
    const normalized = await normalizeToSpeechAudio(source, dir);
    const key = `${meeting.workspace_id}/meetings/${meetingId}/normalized.${normalized.mimeType === 'audio/ogg' ? 'ogg' : 'mp3'}`;
    await storage.putFromFile({ key, path: normalized.path, contentType: normalized.mimeType });
    await addMeetingMedia(ctx.pool, {
      workspaceId: meeting.workspace_id,
      meetingId,
      kind: 'normalized',
      storageKey: key,
      mimeType: normalized.mimeType,
      bytes: normalized.bytes,
      durationMs: normalized.durationMs,
      checksum: normalized.checksum,
    });
    return normalized;
  });

  await transitionMeetingStatus(ctx.pool, meetingId, ['uploaded', 'processing', 'failed'], 'processing', {
    durationMs: result.durationMs,
  });
  await enqueueJob(ctx.pool, {
    workspaceId: meeting.workspace_id,
    type: 'asr.transcribe',
    payload: { meetingId },
    maxAttempts: 3,
  });
  return { durationMs: result.durationMs, bytes: result.bytes, codec: result.codec };
};

/** 2. Transcribe with the configured ASR provider. No provider, no transcript. */
export const asrTranscribe: JobHandler = async (ctx, job) => {
  const meetingId = String(job.payload.meetingId);
  const meeting = await findMeetingUnscoped(ctx.pool, meetingId);
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

  // Resolve the provider first: with none configured this throws
  // ProviderNotConfiguredError immediately instead of doing pointless work.
  const provider = ctx.registry.asr();

  const settings = await workspaceSettings(ctx.pool, meeting.workspace_id);
  const usedMinutes = await audioMinutesThisMonth(ctx.pool, meeting.workspace_id);
  if (settings && usedMinutes >= settings.monthly_audio_minutes_quota) {
    throw new Error(
      `Workspace audio quota exhausted (${Math.round(usedMinutes)} of ${settings.monthly_audio_minutes_quota} minutes this month).`,
    );
  }

  const media =
    (await findMedia(ctx.pool, scopeless(meeting.workspace_id), meetingId, 'normalized')) ??
    (await findMedia(ctx.pool, scopeless(meeting.workspace_id), meetingId, 'original'));
  if (!media) throw new Error('No media available to transcribe');

  const storage = ctx.registry.storage();
  const started = Date.now();

  try {
    const result = await withTempDir(async (dir) => {
      const local = path.join(dir, 'audio');
      await storage.downloadToFile(media.storage_key, local);
      return provider.transcribe({
        filePath: local,
        mimeType: media.mime_type,
        languageHint: meeting.language,
        diarize: true,
      });
    });

    if (result.segments.length === 0) {
      throw new Error('The transcription provider returned no speech segments.');
    }

    const versionId = await withTransaction(ctx.pool, async (client) => {
      const version = await createTranscriptVersion(client, {
        workspaceId: meeting.workspace_id,
        meetingId,
        providerId: result.providerId,
        modelVersion: result.modelVersion,
        languageHint: meeting.language,
        stats: {
          detectedLanguage: result.detectedLanguage ?? null,
          audioSeconds: result.usage.audioSeconds,
          diarizedSpeakers: new Set(result.segments.map((s) => s.speaker)).size,
        },
      });
      await insertSegments(client, {
        workspaceId: meeting.workspace_id,
        meetingId,
        versionId: version.id,
        segments: result.segments.map((segment, idx) => ({
          idx,
          startMs: segment.startMs,
          endMs: segment.endMs,
          speaker: segment.speaker,
          text: segment.text,
          textNormalized: normalizeForSearch(segment.text),
          confidence: segment.confidence ?? null,
          language: segment.language ?? null,
        })),
      });
      await writeAudit(client, {
        workspaceId: meeting.workspace_id,
        actorType: 'system',
        actorId: null,
        action: 'transcript.created',
        targetType: 'meeting',
        targetId: meetingId,
        payload: { provider: result.providerId, segments: result.segments.length },
        result: 'success',
      });
      return version.id;
    });

    await recordProviderCall(ctx.pool, {
      workspaceId: meeting.workspace_id,
      jobId: job.id,
      meetingId,
      providerKind: 'asr',
      providerId: result.providerId,
      modelVersion: result.modelVersion,
      operation: 'transcribe',
      latencyMs: Date.now() - started,
      audioSeconds: result.usage.audioSeconds,
      costUsd: result.usage.costUsd ?? null,
      outcome: 'success',
    });

    if (ctx.registry.isConfigured('embeddings')) {
      await enqueueJob(ctx.pool, {
        workspaceId: meeting.workspace_id,
        type: 'transcript.embed',
        payload: { meetingId, versionId },
      });
    }
    if (settings?.ai_enabled && ctx.registry.isConfigured('llm')) {
      await enqueueJob(ctx.pool, {
        workspaceId: meeting.workspace_id,
        type: 'analysis.run',
        payload: { meetingId },
        maxAttempts: 2,
      });
    } else {
      await transitionMeetingStatus(ctx.pool, meetingId, ['processing'], 'ready');
    }
    return { segments: result.segments.length, provider: result.providerId, versionId };
  } catch (error) {
    await recordProviderCall(ctx.pool, {
      workspaceId: meeting.workspace_id,
      jobId: job.id,
      meetingId,
      providerKind: 'asr',
      providerId: provider.id,
      operation: 'transcribe',
      latencyMs: Date.now() - started,
      outcome: 'failure',
      errorCode: (error as Error).message.slice(0, 80),
    });
    throw error;
  }
};

/** 3. Embed segments for semantic search. Partial failure degrades search, not truth. */
export const transcriptEmbed: JobHandler = async (ctx, job) => {
  const versionId = String(job.payload.versionId);
  const meetingId = String(job.payload.meetingId);
  const meeting = await findMeetingUnscoped(ctx.pool, meetingId);
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

  const provider = ctx.registry.embeddings();
  let embedded = 0;
  for (let batch = 0; batch < 50; batch += 1) {
    const pending = await segmentsMissingEmbeddings(ctx.pool, versionId, 96);
    if (pending.length === 0) break;
    const started = Date.now();
    const { vectors, usage } = await provider.embed(pending.map((p) => p.text));
    await storeEmbeddings(
      ctx.pool,
      pending.map((segment, i) => ({ id: segment.id, vector: vectors[i] })),
    );
    embedded += pending.length;
    await recordProviderCall(ctx.pool, {
      workspaceId: meeting.workspace_id,
      jobId: job.id,
      meetingId,
      providerKind: 'embeddings',
      providerId: provider.id,
      modelVersion: provider.modelVersion,
      operation: 'embed',
      latencyMs: Date.now() - started,
      inputTokens: usage.inputTokens ?? null,
      outcome: 'success',
    });
  }
  return { embedded };
};

/** 4. Summaries, decisions, action items and chapters — all evidence-validated. */
export const analysisRun: JobHandler = async (ctx, job) => {
  const meetingId = String(job.payload.meetingId);
  const meeting = await findMeetingUnscoped(ctx.pool, meetingId);
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

  const version = await currentTranscriptVersion(ctx.pool, meetingId);
  if (!version) throw new Error('No transcript to analyse');
  const segments = await listSegmentsForPipeline(ctx.pool, version.id);
  if (segments.length === 0) throw new Error('Transcript has no segments');

  const llm = ctx.registry.llm();
  const started = Date.now();
  const settings = await workspaceSettings(ctx.pool, meeting.workspace_id);
  const outputLanguage = meeting.language === 'ar' ? 'ar' : 'en';

  try {
    const outcome = await analyzeTranscript({
      llm,
      segments: segments.map((s) => ({
        id: s.id,
        idx: s.idx,
        startMs: s.start_ms,
        endMs: s.end_ms,
        speaker: s.speaker_label,
        text: s.text,
      })),
      meetingTitle: meeting.title,
      meetingDate: meeting.started_at ?? meeting.created_at,
      outputLanguage,
    });

    await withTransaction(ctx.pool, async (client) => {
      const common = {
        workspaceId: meeting.workspace_id,
        meetingId,
        providerId: llm.id,
        modelVersion: outcome.report.modelVersion,
        promptVersion: outcome.report.promptVersion,
      };
      await replaceSummary(client, {
        ...common,
        kind: 'tldr',
        content: { text: outcome.summaries.tldr },
        outputLanguage,
      });
      await replaceSummary(client, {
        ...common,
        kind: 'executive',
        content: outcome.summaries.executive,
        outputLanguage,
      });
      await replaceSummary(client, {
        ...common,
        kind: 'detailed',
        content: outcome.summaries.detailed,
        outputLanguage,
      });
      await insertDecisions(client, { ...common, items: outcome.decisions });
      await insertActionItems(client, { ...common, items: outcome.actionItems });
      await replaceChapters(client, {
        workspaceId: meeting.workspace_id,
        meetingId,
        chapters: outcome.chapters,
      });
      await writeAudit(client, {
        workspaceId: meeting.workspace_id,
        actorType: 'ai',
        actorId: null,
        action: 'analysis.completed',
        targetType: 'meeting',
        targetId: meetingId,
        payload: {
          decisions: outcome.decisions.length,
          actionItems: outcome.actionItems.length,
          dropped: outcome.report.dropped.length,
          model: outcome.report.modelVersion,
          promptVersion: outcome.report.promptVersion,
        },
        result: 'success',
        reason:
          outcome.report.suspiciousContent.length > 0
            ? `Transcript contained ${outcome.report.suspiciousContent.length} instruction-like passage(s); reported, not executed.`
            : null,
      });
    });

    await recordProviderCall(ctx.pool, {
      workspaceId: meeting.workspace_id,
      jobId: job.id,
      meetingId,
      providerKind: 'llm',
      providerId: llm.id,
      modelVersion: outcome.report.modelVersion,
      operation: 'analysis',
      latencyMs: Date.now() - started,
      inputTokens: outcome.report.usage.inputTokens,
      outputTokens: outcome.report.usage.outputTokens,
      costUsd: outcome.report.usage.costUsd,
      outcome: 'success',
    });

    await transitionMeetingStatus(ctx.pool, meetingId, ['processing', 'ready'], 'ready');
    if (settings) {
      ctx.log.info('analysis_done', {
        meetingId,
        decisions: outcome.decisions.length,
        actionItems: outcome.actionItems.length,
        droppedItems: outcome.report.dropped.length,
      });
    }
    return {
      decisions: outcome.decisions.length,
      actionItems: outcome.actionItems.length,
      chapters: outcome.chapters.length,
      droppedItems: outcome.report.dropped.length,
      suspiciousContent: outcome.report.suspiciousContent.length,
      costUsd: outcome.report.usage.costUsd,
    };
  } catch (error) {
    await recordProviderCall(ctx.pool, {
      workspaceId: meeting.workspace_id,
      jobId: job.id,
      meetingId,
      providerKind: 'llm',
      providerId: llm.id,
      operation: 'analysis',
      latencyMs: Date.now() - started,
      outcome: 'failure',
      errorCode: (error as Error).message.slice(0, 80),
    });
    throw error;
  }
};

/** 5. Retention sweep: find meetings past their policy window and queue erasure. */
export const retentionSweep: JobHandler = async (ctx) => {
  const candidates = await meetingsPastRetention(ctx.pool, 100);
  for (const candidate of candidates) {
    await enqueueJob(ctx.pool, {
      workspaceId: candidate.workspace_id,
      type: 'meeting.purge',
      payload: { meetingId: candidate.id, reason: 'retention_policy' },
    });
  }
  return { queued: candidates.length };
};

/** 6. Irreversible erasure: storage objects, segments, embeddings, AI artifacts. */
export const meetingPurge: JobHandler = async (ctx, job) => {
  const meetingId = String(job.payload.meetingId);
  const reason = (job.payload.reason as 'user_request' | 'retention_policy' | 'workspace_deletion') ?? 'retention_policy';
  const meeting = await findMeetingUnscoped(ctx.pool, meetingId);
  if (!meeting) return { purged: false, reason: 'meeting already gone' };

  const media = await listMeetingMedia(ctx.pool, meetingId);
  let objectsDeleted = 0;
  if (ctx.registry.isConfigured('storage')) {
    const storage = ctx.registry.storage();
    for (const item of media) {
      await storage.delete(item.storage_key).catch((err) => {
        ctx.log.warn('storage_delete_failed', { key: item.storage_key, error: String(err) });
      });
      objectsDeleted += 1;
    }
    await storage
      .deletePrefix(`${meeting.workspace_id}/meetings/${meetingId}`)
      .catch(() => undefined);
  }

  const counts = await purgeMeetingContent(ctx.pool, meetingId);
  await markMediaPurged(ctx.pool, meetingId);
  await recordDeletion(ctx.pool, {
    workspaceId: meeting.workspace_id,
    targetType: 'meeting',
    targetId: meetingId,
    reason,
    requestedBy: (job.payload.requestedBy as string) ?? null,
    artifacts: { ...counts, storageObjects: objectsDeleted },
  });
  await withTransaction(ctx.pool, (client) =>
    writeAudit(client, {
      workspaceId: meeting.workspace_id,
      actorType: 'system',
      actorId: null,
      action: 'meeting.purge',
      targetType: 'meeting',
      targetId: meetingId,
      payload: counts,
      result: 'success',
      reason,
    }),
  );
  return { purged: true, ...counts, storageObjects: objectsDeleted };
};

/** 7. Execute an approved external action through the Action Gateway. */
export const actionExecute: JobHandler = async (ctx, job) => {
  const actionId = String(job.payload.actionId);
  const result = await executeAction(ctx, actionId);
  if (result.status === 'failed') throw new Error(result.error ?? 'Action execution failed');
  return { providerResponseId: result.providerResponseId ?? null };
};

/** 8. Research: plan queries, fetch real pages, cite what was retrieved. */
export const researchRun: JobHandler = async (ctx, job) => {
  const requestId = String(job.payload.requestId);
  const outcome = await runResearch(ctx, requestId);
  return { ...outcome };
};

export const HANDLERS: Record<string, JobHandler> = {
  'media.normalize': mediaNormalize,
  'asr.transcribe': asrTranscribe,
  'transcript.embed': transcriptEmbed,
  'analysis.run': analysisRun,
  'retention.sweep': retentionSweep,
  'meeting.purge': meetingPurge,
  'action.execute': actionExecute,
  'research.run': researchRun,
};
