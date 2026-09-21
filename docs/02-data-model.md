# 02 — Data Model (PostgreSQL)

All tables carry `workspace_id`, `created_at`, `updated_at`. All ids are UUID v7/v4. Soft delete via `deleted_at` where user-recoverable.

## Core

**workspaces** — `id, name, locale_default ('ar'|'en'), timezone, retention_days, settings jsonb`

**users** — `id, email (citext, unique), name, password_hash, locale, timezone, status, last_login_at`

**workspace_members** — `workspace_id, user_id, role ('owner'|'admin'|'member'|'viewer'), created_at` — PK `(workspace_id, user_id)`

**projects** — `id, workspace_id, name, client_name, status`

## Meetings

**meetings**
```
id, workspace_id, project_id?, title, description,
scheduled_at, started_at, ended_at, duration_ms,
language ('ar'|'en'|'mixed'), status ('draft'|'recording'|'uploaded'|'processing'|'ready'|'failed'),
failure_reason?, source ('live_recording'|'upload'|'integration'),
created_by, notes
```

**meeting_media** — `id, meeting_id, storage_key, mime_type, bytes, duration_ms, checksum_sha256, kind ('original'|'normalized'), created_at`

**meeting_attendees** — `id, meeting_id, person_id?, display_name, email?, role, source ('manual'|'calendar'|'diarization')`

**transcript_segments**
```
id, meeting_id, idx, start_ms, end_ms,
speaker_label,          -- "Speaker 1" as returned by the provider
person_id?,             -- resolved person after user renames
text, confidence?,
provider_id, model_version,
tsv tsvector,           -- generated column for full-text search
embedding vector(N)?    -- nullable; filled by the embed job
```
Indexes: `(meeting_id, idx)`, GIN on `tsv`, IVFFlat/HNSW on `embedding`, `(meeting_id, start_ms)`.

**transcript_versions** — `id, meeting_id, provider_id, model_version, created_at, stats jsonb` — re-running ASR creates a new version; segments reference it. Old versions are never silently overwritten.

## AI artifacts (all evidence-linked, all suggestion-first)

**summaries** — `id, meeting_id, kind ('tldr'|'executive'|'detailed'), content jsonb, model_id, model_version, prompt_version, generated_at, superseded_by?`

**decisions** — `id, workspace_id, meeting_id, text, owner_person_id?, decided_on (date), context, evidence_segment_ids uuid[], start_ms, confidence, status ('suggested'|'accepted'|'rejected'|'edited'), reviewed_by?, reviewed_at?`

**action_items** — `id, workspace_id, meeting_id, title, description, assignee_person_id?, due_at?, due_source_text?, priority, evidence_segment_ids uuid[], start_ms, confidence, status ('suggested'|'accepted'|'rejected'), task_id?`

**tasks** — `id, workspace_id, title, description, assignee_user_id?, assignee_person_id?, due_at, priority ('low'|'normal'|'high'|'urgent'), status ('TODO'|'IN_PROGRESS'|'DONE'|'CANCELLED'), source_type ('manual'|'meeting'|'email'|'ai'), source_meeting_id?, source_segment_id?, completed_at, created_by`

**chapters** — `id, meeting_id, title, start_ms, end_ms, segment_id_range int4range` — timeline markers.

## People

**people** — `id, workspace_id, display_name, email?, aliases text[], notes, created_by` — a person is workspace-scoped, not global.

**speaker_map** — `id, meeting_id, speaker_label, person_id, confirmed_by, confirmed_at` — how "Speaker 2" became "Mohamed", per meeting, always human-confirmed.

## Research

**research_requests** — `id, workspace_id, question, origin_meeting_id?, origin_segment_id?, status, requested_by`
**research_sources** — `id, request_id, url, title, publisher, retrieved_at, content_hash, snippet, storage_key?`
**research_reports** — `id, request_id, findings jsonb, report_md, model_id, model_version, generated_at` — every finding references `research_sources.id`. No source → not rendered.

## Chat / RAG

**conversations** — `id, workspace_id, user_id, title, created_at`
**messages** — `id, conversation_id, role ('user'|'assistant'|'system'), content, citations jsonb, model_id, tokens_in, tokens_out, created_at`
Citations: `[{ meetingId, segmentId, startMs, quote }]` — rendered as clickable jumps; an assistant message with factual claims and zero citations is flagged in QA.

## Memory

**memory_entries** — `id, workspace_id, scope ('workspace'|'user'|'project'), type ('preference'|'fact'|'project'|'person'|'topic'), key, value jsonb, source_type, source_id, confidence, created_by ('user'|'ai'), status ('active'|'archived'), last_used_at`
Every entry is explainable (source), editable and deletable by the user. Memory is retrieved with the same permission filter as documents.

## Jobs, integrations, governance

**jobs** — `id, workspace_id, type, payload jsonb, status ('queued'|'running'|'succeeded'|'failed'|'dead'), attempts, max_attempts, run_after, locked_by, locked_at, last_error, result jsonb, created_at, finished_at`
Worker claim: `SELECT ... WHERE status='queued' AND run_after <= now() ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT n`.

**provider_calls** — `id, workspace_id, job_id?, provider_kind, provider_id, model_version, latency_ms, tokens_in?, tokens_out?, audio_seconds?, cost_usd?, outcome, error_code?, created_at` — this is how cost and reliability become facts instead of guesses.

**integrations** — `id, workspace_id, kind ('google'|'microsoft'), scopes text[], status, connected_by, connected_at, external_account_email, token_ref` — `token_ref` points to the secret store. **Tokens are never stored in a model-readable table, never logged, never returned by any API response.**

**actions** — `id, workspace_id, type, payload jsonb, payload_digest, scope, requested_by, requested_via ('ui'|'ai'), status ('proposed'|'approved'|'rejected'|'executing'|'executed'|'failed'), approved_by?, approved_at?, idempotency_key unique, provider_response_id?, executed_at`

**audit_log** — `id, workspace_id, actor_type ('user'|'ai'|'system'), actor_id, action, target_type, target_id, payload_digest, result, reason, ip, user_agent, created_at, prev_hash, hash` — append-only (revoke UPDATE/DELETE from the app role; enforce with a trigger).

## Search

Hybrid retrieval:
1. **Lexical**: `tsvector` over transcript segments, summaries, tasks, decisions, notes. Arabic needs `simple` config + `unaccent`/normalization; do not assume the English stemmer works for Arabic — normalize (alef/ya/ta-marbuta, tatweel, diacritics) in a dedicated function that is unit-tested.
2. **Semantic**: pgvector over segment/summary embeddings.
3. Merge with Reciprocal Rank Fusion, then re-rank, then **apply permission filter again** before returning.

## Invariants (write tests for these)
1. No query returns rows from another workspace. Ever.
2. `decisions` / `action_items` with empty `evidence_segment_ids` cannot be inserted (DB check constraint).
3. `audit_log` rows cannot be updated or deleted by the application role.
4. An `actions` row cannot move to `executed` without `approved_by` when its type requires approval.
5. Deleting a meeting deletes/anonymizes its media, segments, embeddings and derived artifacts (right-to-erasure path), and writes an audit record.
