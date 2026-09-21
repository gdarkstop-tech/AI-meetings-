import { z } from 'zod';
import type { CalendarEventSummary, CalendarProvider } from '../types.js';

/** Microsoft Graph calendar (Microsoft 365 / Outlook). */
const eventSchema = z.object({
  id: z.string(),
  subject: z.string().optional(),
  webLink: z.string().optional(),
  start: z.object({ dateTime: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional() }).optional(),
  attendees: z
    .array(z.object({ emailAddress: z.object({ address: z.string().optional() }).optional() }))
    .optional(),
  organizer: z.object({ emailAddress: z.object({ address: z.string().optional() }).optional() }).optional(),
});
const listSchema = z.object({ value: z.array(eventSchema).default([]) });

const BASE = 'https://graph.microsoft.com/v1.0';

export class MicrosoftCalendarProvider implements CalendarProvider {
  readonly id = 'microsoft' as const;

  async listEvents(input: { accessToken: string; from: string; to: string }): Promise<CalendarEventSummary[]> {
    const params = new URLSearchParams({
      startDateTime: input.from,
      endDateTime: input.to,
      $orderby: 'start/dateTime',
      $top: '50',
    });
    const res = await fetch(`${BASE}/me/calendarView?${params}`, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (!res.ok) throw new Error(`Microsoft calendar list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const parsed = listSchema.parse(await res.json());
    return parsed.value.map((e) => ({
      externalId: e.id,
      title: e.subject ?? '(no title)',
      startsAt: e.start?.dateTime ?? null,
      endsAt: e.end?.dateTime ?? null,
      attendees: (e.attendees ?? [])
        .map((a) => a.emailAddress?.address)
        .filter((x): x is string => Boolean(x)),
      organizer: e.organizer?.emailAddress?.address ?? null,
    }));
  }

  async createEvent(input: {
    accessToken: string;
    draft: {
      title: string;
      description?: string;
      startsAt: string;
      endsAt: string;
      timeZone: string;
      attendees: string[];
      location?: string;
    };
    idempotencyKey: string;
  }): Promise<{ externalId: string; htmlLink?: string }> {
    const res = await fetch(`${BASE}/me/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        // Graph honours this header for safe retries of the same create.
        'client-request-id': input.idempotencyKey,
      },
      body: JSON.stringify({
        subject: input.draft.title,
        body: { contentType: 'Text', content: input.draft.description ?? '' },
        start: { dateTime: input.draft.startsAt, timeZone: input.draft.timeZone },
        end: { dateTime: input.draft.endsAt, timeZone: input.draft.timeZone },
        location: input.draft.location ? { displayName: input.draft.location } : undefined,
        attendees: input.draft.attendees.map((address) => ({
          emailAddress: { address },
          type: 'required',
        })),
      }),
    });
    if (!res.ok) throw new Error(`Microsoft calendar insert failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const parsed = eventSchema.parse(await res.json());
    return { externalId: parsed.id, htmlLink: parsed.webLink };
  }

  async deleteEvent(input: { accessToken: string; externalId: string }): Promise<void> {
    const res = await fetch(`${BASE}/me/events/${encodeURIComponent(input.externalId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Microsoft calendar delete failed (${res.status})`);
  }
}
