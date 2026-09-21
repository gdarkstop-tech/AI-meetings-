import { z } from 'zod';
import type { EmailDraft, EmailProvider, EmailSummary } from '../types.js';

/**
 * Microsoft Graph mail.
 *
 * Send is a two-step create-draft-then-send so that a real provider message id
 * exists as proof of the action; `/me/sendMail` returns 202 with no id.
 */
const listSchema = z.object({
  value: z
    .array(
      z.object({
        id: z.string(),
        conversationId: z.string().optional(),
        subject: z.string().optional(),
        bodyPreview: z.string().optional(),
        receivedDateTime: z.string().optional(),
        from: z.object({ emailAddress: z.object({ address: z.string().optional() }).optional() }).optional(),
      }),
    )
    .default([]),
});
const draftSchema = z.object({ id: z.string() });

const BASE = 'https://graph.microsoft.com/v1.0';

export class MicrosoftEmailProvider implements EmailProvider {
  readonly id = 'microsoft' as const;

  async search(input: { accessToken: string; query: string; limit: number }): Promise<EmailSummary[]> {
    const params = new URLSearchParams({
      $search: `"${input.query.replace(/"/g, '')}"`,
      $top: String(Math.min(input.limit, 25)),
    });
    const res = await fetch(`${BASE}/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${input.accessToken}`, ConsistencyLevel: 'eventual' },
    });
    if (!res.ok) throw new Error(`Microsoft mail search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const parsed = listSchema.parse(await res.json());
    return parsed.value.map((m) => ({
      id: m.id,
      threadId: m.conversationId,
      from: m.from?.emailAddress?.address ?? '',
      subject: m.subject ?? '(no subject)',
      snippet: m.bodyPreview ?? '',
      receivedAt: m.receivedDateTime ?? null,
    }));
  }

  async send(input: {
    accessToken: string;
    draft: EmailDraft;
    fromAddress: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }> {
    const created = await fetch(`${BASE}/me/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'client-request-id': input.idempotencyKey,
      },
      body: JSON.stringify({
        subject: input.draft.subject,
        body: { contentType: 'Text', content: input.draft.body },
        toRecipients: input.draft.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: (input.draft.cc ?? []).map((address) => ({ emailAddress: { address } })),
      }),
    });
    if (!created.ok) {
      throw new Error(`Microsoft draft creation failed (${created.status}): ${(await created.text()).slice(0, 200)}`);
    }
    const draft = draftSchema.parse(await created.json());

    const sent = await fetch(`${BASE}/me/messages/${draft.id}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Length': '0' },
    });
    if (!sent.ok) throw new Error(`Microsoft send failed (${sent.status}): ${(await sent.text()).slice(0, 200)}`);
    return { messageId: draft.id };
  }
}
