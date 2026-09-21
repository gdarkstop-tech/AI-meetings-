import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CalendarEventSummary, CalendarProvider } from '../types.js';

/** Google Calendar API v3. Tokens come from the integrations vault, per call. */
const eventSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  htmlLink: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string().optional() })).optional(),
  organizer: z.object({ email: z.string().optional() }).optional(),
});

const listSchema = z.object({ items: z.array(eventSchema).default([]) });

const BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Deterministic event id derived from the action's idempotency key.
 * Google accepts client-supplied ids (base32hex), so a retried execution
 * updates the same event instead of creating a duplicate.
 */
function idempotentEventId(idempotencyKey: string): string {
  return `alia${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

async function call(path: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return res;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = 'google' as const;

  async listEvents(input: { accessToken: string; from: string; to: string }): Promise<CalendarEventSummary[]> {
    const params = new URLSearchParams({
      timeMin: input.from,
      timeMax: input.to,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const res = await call(`/calendars/primary/events?${params}`, input.accessToken);
    if (!res.ok) throw new Error(`Google Calendar list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const parsed = listSchema.parse(await res.json());
    return parsed.items.map((e) => ({
      externalId: e.id,
      title: e.summary ?? '(no title)',
      startsAt: e.start?.dateTime ?? e.start?.date ?? null,
      endsAt: e.end?.dateTime ?? e.end?.date ?? null,
      attendees: (e.attendees ?? []).map((a) => a.email).filter((x): x is string => Boolean(x)),
      organizer: e.organizer?.email ?? null,
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
    const body = {
      id: idempotentEventId(input.idempotencyKey),
      summary: input.draft.title,
      description: input.draft.description,
      location: input.draft.location,
      start: { dateTime: input.draft.startsAt, timeZone: input.draft.timeZone },
      end: { dateTime: input.draft.endsAt, timeZone: input.draft.timeZone },
      attendees: input.draft.attendees.map((email) => ({ email })),
    };
    const res = await call('/calendars/primary/events', input.accessToken, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      // The idempotent id already exists: the event was created by a previous
      // attempt. Return it rather than reporting a failure or duplicating.
      return { externalId: body.id };
    }
    if (!res.ok) throw new Error(`Google Calendar insert failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const parsed = eventSchema.parse(await res.json());
    return { externalId: parsed.id, htmlLink: parsed.htmlLink };
  }

  async deleteEvent(input: { accessToken: string; externalId: string }): Promise<void> {
    const res = await call(`/calendars/primary/events/${encodeURIComponent(input.externalId)}`, input.accessToken, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Google Calendar delete failed (${res.status})`);
    }
  }
}
