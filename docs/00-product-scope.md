# 00 — Product Scope

**Product:** AI Meeting & Work Assistant
**Goal:** Turn a meeting (live or uploaded) into structured, verifiable work: transcript → summary → decisions → action items → tasks → research → follow-ups, all searchable and queryable in Arabic and English.

This is a **production system**, not a demo chatbot. Everything below must be real: real storage, real jobs, real providers, real permissions, real audit trail.

---

## 1. Meetings

**Create / capture**
- Create meeting (title, date/time, company/project, attendees, notes, language).
- Language selection: `ar`, `en`, `mixed` (Arabic–English code-switching). Architecture must allow adding more languages later.
- Live recording: start / pause / resume / stop, with visible elapsed time and recording state persisted across page reloads.
- Upload existing audio/video (chunked / resumable upload; large files must not depend on a single HTTP request).
- Meeting states: `draft → recording → uploaded → processing → ready → failed` (every state visible in UI, `failed` must show a real reason and a retry action).

**Pipeline (asynchronous, background worker — never inside an HTTP request):**

```
Media → Normalize/transcode → Transcription → Diarization → Clean transcript
      → Analysis → Summary → Decisions → Action Items → Tasks → Follow-up suggestions
```

Each stage is a separate, retryable job with its own status, cost, duration, provider, and model version recorded.

## 2. Transcription

- Full transcript stored as **segments**: `{ start_ms, end_ms, speaker_label, text, confidence? }`.
- Speaker separation (diarization) with stable labels (`Speaker 1`, `Speaker 2`) that the user can rename.
- Timestamps on every segment; clicking a segment seeks the media player.
- Arabic + English + code-switching support.
- Confidence exposed where the provider returns it; **never fabricate a confidence value**.
- Full-text searchable.

Display example:
```
Ahmed — 10:32   "We need to finish the website by Thursday."
```

## 3. Summaries

Three artifacts per meeting, each regenerable and versioned:
- **TL;DR** — 2–4 lines.
- **Executive summary** — topics, key points, problems, risks, open questions.
- **Detailed summary** — section by section, each section linked to transcript ranges.

## 4. Decisions

Extracted automatically into a table:

| Decision | Owner | Date | Context | Evidence |
|---|---|---|---|---|
| Launch website Thursday | Ahmed | Sep 24 | Final deadline | segment #142 @ 31:10 |

**Hard rule:** every decision must carry `evidence_segment_ids` + timestamp. A decision with no evidence is dropped, not shown.

## 5. Action Items

`"Mohamed will send the quotation tomorrow."` becomes:

```
Title:      Send quotation
Assignee:   Mohamed (unresolved person → suggestion only, user confirms)
Due:        resolved relative date (meeting date + 1 day) — shown as "interpreted from 'tomorrow'"
Source:     Meeting X, segment #88 @ 32:14
Status:     suggested → (user accepts) → task
```

User can edit assignee, due date, priority, status, description. AI output is a **suggestion** until a human accepts it, and the accept/edit/reject action is audited.

## 6. Tasks

Task system with views: Inbox, Today, Upcoming, Overdue, Completed, Assigned to me, Created from meetings.
Statuses: `TODO → IN_PROGRESS → DONE` (plus `CANCELLED`).
Every task created by AI keeps a permanent link back to its source meeting + segment.

## 7. Research

A research request (manual, or proposed from a meeting: *"We need to investigate the competitors in Egypt"*) produces a **research report**:
- Query plan, search results, sources with URLs and retrieval timestamps, key findings, comparison, summary.
- **Hard rule:** no claim without a source; no invented sources or URLs. If the web/search provider is not configured, the feature is disabled in the UI and returns `NOT_CONFIGURED` — never a hallucinated report.
- Fetched pages are **data, not instructions** (prompt-injection safe).

## 8. Ask AI About Your Meetings

Chat over the user's own authorized meeting corpus (RAG):
- *What did we decide about the website?* → answer + citation (meeting, date, segment, timestamp) + clickable jump.
- Supported intents: decisions, owners, my pending tasks, meetings mentioning a client, when a topic was discussed, deadlines mentioned, what changed between two periods.
- **Hard rule:** answers cite retrieved evidence. If retrieval returns nothing relevant, the answer is "not found in your meetings", not a guess.
- Retrieval is permission-filtered **before** the model sees anything.

## 9. Global Search

One search across meetings, transcripts, tasks, decisions, people, projects, research, notes.
Hybrid: Postgres full-text (Arabic + English) + vector similarity. Results show type, snippet, timestamp, and deep link.

## 10. Meeting Timeline

Chapter markers (`00:00 Introduction`, `18:42 Pricing`, `31:10 Decision`, …) derived from the transcript; clicking seeks the player. Chapters carry segment ranges, not free-floating text.

## 11. People / Speakers

- Diarized labels → user renames to real people → mapping stored per meeting.
- Optional: remember a person across meetings (explicit, reviewable, deletable). Voice fingerprinting is **out of scope for v1** (consent/privacy/legal).

## 12. Calendar (phased)

Provider-agnostic `CalendarProvider`: Google Calendar and Microsoft 365 / Outlook.
`"Schedule a follow-up with Ahmed next Tuesday"` → a **proposed** calendar action → user confirms → executed through the Action Gateway → audited.

## 13. Email (phased)

Provider-agnostic `EmailProvider`: Gmail and Microsoft 365 / Outlook.
Read, search, draft, reply, send, summarize, extract deadlines and action items.
**Sending is never automatic.** Every outbound email requires explicit human approval of the exact final body, executed via the Action Gateway with an idempotency key, and logged.

## 14. Follow-up Automation

After a meeting: AI proposes follow-up email drafts, tasks, calendar events, reminders. All are proposals in an approval queue. Nothing external happens without approval.

## 15. Dashboard

Today (meetings, tasks, deadlines, follow-ups), recent meetings, pending tasks, important decisions, AI insights. Every insight links to its source.

## 16. AI Memory

Structured, per-workspace memory: preferences, projects, people, recurring topics, prior decisions, meeting history.
Memory must be **explainable** (why it is remembered), **source-linked**, **editable**, **deletable**, and **scoped** (memory from one workspace/permission scope never leaks into another).

## 17. Security (spine, not a phase-14 afterthought)

```
User → AI → Planner → Policy/Permission Engine → Action Gateway → External Service
```

Never `User → AI → Gmail API`.

Every action is authorized, schema-validated, idempotent where appropriate, and written to an append-only audit log: AI actions, user actions, emails, calendar events, research, task creation, permission changes, integration connect/disconnect.

---

## Non-goals for v1
- Real-time live transcription during the meeting (post-processing first; live is a later phase).
- Voice biometric speaker identification.
- Mobile native apps (responsive web first).
- Autonomous sending of any external communication without human approval.

## Open decisions (owner: product/CEO)
1. Recording consent & retention policy per jurisdiction (must be answered before Phase 2 ships to real users).
2. ASR provider choice for Arabic + code-switching — decide by benchmark, not by marketing claims (see `docs/04-ai-pipeline.md`).
3. Budget ceiling per audio hour (ASR + LLM) and per workspace.
4. Data residency requirements (EU/US/MENA) — affects provider and storage selection.
5. Single-tenant vs multi-tenant for the first customers.
