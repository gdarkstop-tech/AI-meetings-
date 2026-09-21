# 05 — Integrations (Calendar, Email, Search)

Integrations are the highest-risk part of the product: real credentials, real side effects on real people. They ship **after** the Action Gateway, policy engine and audit log exist and are tested.

## 1. Provider interfaces

```ts
export interface CalendarProvider {
  readonly id: 'google' | 'microsoft';
  listEvents(scope, range): Promise<CalendarEvent[]>;
  createEvent(scope, draft: EventDraft, idempotencyKey: string): Promise<{ externalId: string }>;
  updateEvent(scope, externalId, patch, idempotencyKey: string): Promise<void>;
  deleteEvent(scope, externalId, idempotencyKey: string): Promise<void>;
}

export interface EmailProvider {
  readonly id: 'gmail' | 'microsoft';
  search(scope, query, page): Promise<EmailSummary[]>;
  get(scope, messageId): Promise<EmailMessage>;
  createDraft(scope, draft: EmailDraft): Promise<{ draftId: string }>;
  send(scope, draftId: string, idempotencyKey: string): Promise<{ messageId: string }>;
}
```

Domain code never imports Google or Microsoft SDKs — only these interfaces.

## 2. OAuth & tokens

- Per-user, per-workspace connection with **incremental, minimum scopes**:
  - Calendar read → `calendar.readonly` / `Calendars.Read`
  - Calendar write → `calendar.events` / `Calendars.ReadWrite`
  - Email read → `gmail.readonly` / `Mail.Read`
  - Email send → `gmail.send` (or `gmail.compose` for drafts) / `Mail.Send`
- Ask for send scope only when the user enables sending.
- Tokens: encrypted at rest, referenced by `token_ref`, refreshed by the worker, revocable from the UI, revoked on disconnect, never logged or returned.
- Connection status, granted scopes and last sync are visible to the user.

## 3. Execution rules

- Every write goes through the Action Gateway: propose → policy → approval → execute → audit.
- Idempotency key per action; retries reuse the key so nothing is sent twice.
- Provider response ids (`messageId`, `externalId`) are stored — this is the proof an action really happened.
- Failures surface the provider error to the user in plain language; nothing is marked "sent" unless the provider confirmed it.

## 4. Email drafting

- Drafts are generated from meeting context with citations to the source meeting.
- The approval screen shows: To / Cc / Bcc, subject, full final body, attachments, sending account.
- Editing a draft after approval invalidates the approval (payload digest changes) and requires re-approval.
- A workspace-level switch can restrict sending to internal domains, or disable sending entirely.

## 5. Calendar actions

- `"Schedule a follow-up with Ahmed next Tuesday"` → proposal with resolved absolute datetime + timezone + attendees, shown for confirmation.
- Free/busy check before proposing, when the scope allows it.
- Recurring events and invites to external attendees always require approval.

## 6. Web search / research provider

- One `WebSearchProvider` interface; a configured API key is required.
- Fetched content is stored with URL, retrieval timestamp and hash; it is treated as untrusted data.
- Robots/ToS compliance and per-workspace rate limits are enforced in the adapter.

## 7. Staging & test accounts

- Integrations are developed against **dedicated test accounts**, never the CEO's live mailbox.
- A "dry-run" mode logs the exact request that *would* be sent, without sending — used for demos. Dry-run results are visibly labelled `DRY RUN` in the UI and in the audit log; they must never look like a real send.
