import { z } from 'zod';
import type { EmailDraft, EmailProvider, EmailSummary } from '../types.js';

/** Gmail API. Sending requires the gmail.send scope and human approval upstream. */
const listSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string().optional() })).default([]),
});
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z
    .object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) })
    .optional(),
});
const sendSchema = z.object({ id: z.string(), threadId: z.string().optional() });

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word so Arabic subjects survive transport intact.
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildRfc822(input: { from: string; draft: EmailDraft }): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.draft.to.join(', ')}`,
    ...(input.draft.cc?.length ? [`Cc: ${input.draft.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.draft.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.draft.body, 'utf8').toString('base64'),
  ];
  return lines.join('\r\n');
}

export class GmailProvider implements EmailProvider {
  readonly id = 'gmail' as const;

  async search(input: { accessToken: string; query: string; limit: number }): Promise<EmailSummary[]> {
    const params = new URLSearchParams({ q: input.query, maxResults: String(Math.min(input.limit, 25)) });
    const listed = await fetch(`${BASE}/messages?${params}`, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (!listed.ok) throw new Error(`Gmail search failed (${listed.status}): ${(await listed.text()).slice(0, 200)}`);
    const { messages } = listSchema.parse(await listed.json());

    const results: EmailSummary[] = [];
    for (const ref of messages) {
      const res = await fetch(
        `${BASE}/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      );
      if (!res.ok) continue;
      const msg = messageSchema.parse(await res.json());
      const headers = new Map((msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
      results.push({
        id: msg.id,
        threadId: msg.threadId,
        from: headers.get('from') ?? '',
        subject: headers.get('subject') ?? '(no subject)',
        snippet: msg.snippet ?? '',
        receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
      });
    }
    return results;
  }

  async send(input: {
    accessToken: string;
    draft: EmailDraft;
    fromAddress: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }> {
    const raw = Buffer.from(buildRfc822({ from: input.fromAddress, draft: input.draft }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetch(`${BASE}/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const parsed = sendSchema.parse(await res.json());
    return { messageId: parsed.id };
  }
}
