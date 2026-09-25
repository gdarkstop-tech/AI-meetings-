import type { PoolClient, Queryable } from '../client.js';
import { enqueueJob, type JobRow } from './jobs.js';
import { transitionMeetingStatus, type MeetingStatus } from './meetings.js';

/**
 * The stages that decide a meeting's outcome. While any of them is queued or
 * running for a meeting, starting its pipeline again is refused: that would pay
 * for a second transcription and race the first for the meeting's status.
 *
 * `transcript.embed` is deliberately absent. It only enriches search, never
 * decides whether the meeting succeeded, and must not block a retry.
 */
export const MEETING_PIPELINE_JOB_TYPES = ['media.normalize', 'asr.transcribe', 'analysis.run'] as const;
export type MeetingPipelineJobType = (typeof MEETING_PIPELINE_JOB_TYPES)[number];

export function isMeetingPipelineJob(job: Pick<JobRow, 'type' | 'payload'>): boolean {
  return (
    (MEETING_PIPELINE_JOB_TYPES as readonly string[]).includes(job.type) && typeof job.payload.meetingId === 'string'
  );
}

export interface ActivePipelineJob {
  type: string;
  status: 'queued' | 'running';
}

/** The meeting's queued or running pipeline job, if there is one. */
export async function findActivePipelineJob(db: Queryable, meetingId: string): Promise<ActivePipelineJob | null> {
  const { rows } = await db.query<ActivePipelineJob>(
    `SELECT type, status FROM jobs
      WHERE payload->>'meetingId' = $1
        AND type = ANY($2)
        AND status IN ('queued', 'running')
      ORDER BY created_at
      LIMIT 1`,
    [meetingId, [...MEETING_PIPELINE_JOB_TYPES]],
  );
  return rows[0] ?? null;
}

/**
 * Lock one meeting's row for the rest of the transaction.
 *
 * Every decision about a meeting's pipeline — start it, or declare it failed —
 * takes this lock first and then looks at the meeting's jobs, so decisions for
 * one meeting are serialized and cannot interleave: two "reprocess" requests
 * cannot both see an idle meeting, and a job dying cannot mark a meeting failed
 * while a retry for it is being queued.
 */
export async function lockMeetingForPipeline(
  client: PoolClient,
  meetingId: string,
): Promise<{ status: MeetingStatus } | null> {
  const { rows } = await client.query<{ status: MeetingStatus }>(
    'SELECT status FROM meetings WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [meetingId],
  );
  return rows[0] ?? null;
}

export type StartPipelineOutcome =
  | { started: JobRow }
  | { conflict: ActivePipelineJob }
  | { notFound: true };

/**
 * Queue the first step of a meeting's pipeline, unless a pipeline job for the
 * meeting is already queued or running. Must be called inside a transaction;
 * the lock it takes is held until the caller commits.
 */
export async function startMeetingPipeline(
  client: PoolClient,
  input: { workspaceId: string; meetingId: string; type: MeetingPipelineJobType; maxAttempts?: number },
): Promise<StartPipelineOutcome> {
  const meeting = await lockMeetingForPipeline(client, input.meetingId);
  if (!meeting) return { notFound: true };
  const active = await findActivePipelineJob(client, input.meetingId);
  if (active) return { conflict: active };
  const started = await enqueueJob(client, {
    workspaceId: input.workspaceId,
    type: input.type,
    payload: { meetingId: input.meetingId },
    maxAttempts: input.maxAttempts,
  });
  return { started };
}

/**
 * Mark a meeting failed because its pipeline cannot go on — unless newer work
 * for it is already queued or running (a retry, or a reprocess the user started
 * meanwhile), in which case the meeting's status belongs to that work and is
 * left alone. Returns whether the meeting was marked failed.
 *
 * `failureReason` is shown to users as-is. Callers must pass a fixed,
 * human-written sentence, never provider output or an exception message.
 * Must be called inside a transaction.
 */
export async function failMeetingPipeline(
  client: PoolClient,
  input: { meetingId: string; failureCode: string; failureReason: string },
): Promise<boolean> {
  const meeting = await lockMeetingForPipeline(client, input.meetingId);
  if (!meeting) return false;
  if (await findActivePipelineJob(client, input.meetingId)) return false;
  const updated = await transitionMeetingStatus(client, input.meetingId, ['uploaded', 'processing'], 'failed', {
    failureCode: input.failureCode,
    failureReason: input.failureReason,
  });
  return updated !== null;
}
