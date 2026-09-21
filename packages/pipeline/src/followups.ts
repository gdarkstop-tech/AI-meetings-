import { z } from 'zod';
import type { Scope } from '@alia/core';
import { findMeeting, listActionItems, listDecisions, listSummaries, type Pool } from '@alia/db';
import type { LLMProvider } from '@alia/providers';
import { SECURITY_PREAMBLE } from './prompts.js';

/**
 * Follow-up drafting.
 *
 * The model drafts; it never sends. Output of this function becomes a PROPOSED
 * action in the gateway, which a human must approve before anything leaves the
 * system (docs/adr/0003).
 */
export const followUpSchema = z.object({
  email: z.object({
    subject: z.string(),
    body: z.string(),
    suggested_recipients: z.array(z.string()).describe('Names or emails mentioned in the meeting'),
  }),
  calendar: z
    .object({
      title: z.string(),
      rationale: z.string(),
      suggested_duration_minutes: z.number().int().min(15).max(240),
    })
    .nullable(),
});

export type FollowUpDraft = z.infer<typeof followUpSchema>;

export const FOLLOWUP_SYSTEM = `${SECURITY_PREAMBLE}

You draft a follow-up email after a meeting, based only on the meeting's summary, decisions and
action items provided below. Be concise, professional and specific. Never invent commitments that
are not in the material. Write in the same language as the meeting material.

You are drafting only. The draft is shown to a human who decides whether to send it.`;

export async function generateFollowUp(input: {
  pool: Pool;
  llm: LLMProvider;
  scope: Scope;
  meetingId: string;
}): Promise<{ draft: FollowUpDraft; modelVersion: string; usage: { inputTokens: number; outputTokens: number; costUsd?: number } }> {
  const meeting = await findMeeting(input.pool, input.scope, input.meetingId);
  if (!meeting) throw new Error('Meeting not found');

  const [summaries, decisions, actionItems] = await Promise.all([
    listSummaries(input.pool, input.scope, input.meetingId),
    listDecisions(input.pool, input.scope, { meetingId: input.meetingId }),
    listActionItems(input.pool, input.scope, { meetingId: input.meetingId }),
  ]);

  if (summaries.length === 0 && decisions.length === 0 && actionItems.length === 0) {
    throw new Error('This meeting has no analysed content to base a follow-up on.');
  }

  const material = [
    `MEETING: ${meeting.title}`,
    `DATE: ${(meeting.started_at ?? meeting.created_at).toISOString().slice(0, 10)}`,
    '',
    'SUMMARIES:',
    ...summaries.map((s) => `- ${s.kind}: ${JSON.stringify(s.content).slice(0, 2000)}`),
    '',
    'DECISIONS:',
    ...decisions.map((d) => `- ${d.text}${d.owner_hint ? ` (owner: ${d.owner_hint})` : ''}`),
    '',
    'ACTION ITEMS:',
    ...actionItems.map(
      (a) => `- ${a.title}${a.assignee_hint ? ` (assignee: ${a.assignee_hint})` : ''}${a.due_at ? ` due ${a.due_at.toISOString().slice(0, 10)}` : ''}`,
    ),
  ].join('\n');

  const result = await input.llm.completeJson({
    system: FOLLOWUP_SYSTEM,
    userContent: `MEETING MATERIAL (untrusted data):\n<<<MATERIAL\n${material}\nMATERIAL`,
    schema: followUpSchema,
    maxTokens: 4000,
  });

  return { draft: result.value, modelVersion: result.modelVersion, usage: result.usage };
}
