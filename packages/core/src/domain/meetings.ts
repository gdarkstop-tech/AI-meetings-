import { z } from 'zod';

export const MEETING_STATUSES = [
  'draft',
  'recording',
  'uploaded',
  'processing',
  'ready',
  'failed',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/**
 * Allowed transitions. Enforced in the repository layer so a meeting can never
 * jump from `failed` to `ready` without going through processing again.
 */
const TRANSITIONS: Record<MeetingStatus, MeetingStatus[]> = {
  draft: ['recording', 'uploaded', 'failed'],
  recording: ['uploaded', 'failed', 'draft'],
  uploaded: ['processing', 'failed'],
  processing: ['ready', 'failed'],
  ready: ['processing'],
  failed: ['uploaded', 'processing'],
};

export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const CONSENT_METHODS = ['verbal', 'written', 'implied_policy', 'not_required'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export const consentSchema = z.object({
  obtained: z.boolean(),
  method: z.enum(CONSENT_METHODS).optional(),
  note: z.string().max(2000).optional(),
});

/**
 * Consent gate. A workspace that requires consent cannot start a recording or
 * accept an upload until consent is recorded — enforced before any bytes are
 * stored, not after.
 */
export function consentSatisfied(input: {
  workspaceRequiresConsent: boolean;
  consentObtained: boolean;
  consentMethod?: ConsentMethod | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.workspaceRequiresConsent) return { ok: true };
  if (!input.consentObtained) {
    return { ok: false, reason: 'This workspace requires recording consent to be recorded before capture.' };
  }
  if (!input.consentMethod) {
    return { ok: false, reason: 'Consent method must be recorded (verbal, written, implied_policy or not_required).' };
  }
  return { ok: true };
}

/** Retention deadline for a meeting, derived from workspace policy. */
export function retentionExpiry(input: {
  createdAt: Date;
  retentionDays: number;
  mediaRetentionDays?: number | null;
}): { mediaExpiresAt: Date; recordExpiresAt: Date } {
  const day = 86_400_000;
  const mediaDays = input.mediaRetentionDays ?? input.retentionDays;
  return {
    mediaExpiresAt: new Date(input.createdAt.getTime() + mediaDays * day),
    recordExpiresAt: new Date(input.createdAt.getTime() + input.retentionDays * day),
  };
}
