# 01 — Architecture

## 1. Principles (inherited from the ALIA / EAIOS architecture)

1. **The LLM is never the security boundary.** Permissions are enforced by deterministic code, in the data layer and the Action Gateway.
2. **Retrieved content is data, not instructions.** Transcripts, emails, web pages and documents are wrapped and never executed as prompts.
3. **Providers are replaceable.** Claude / GPT / Gemini, Whisper / Scribe / Deepgram, Gmail / Outlook — all behind interfaces. No provider SDK is imported outside its adapter.
4. **External side effects go through one gate.** One Action Gateway, one policy check, one audit log, one idempotency mechanism.
5. **Evidence over fluency.** Any extracted decision/action/answer carries source ids; unsupported output is dropped, not shown.
6. **Auditable by default.** Every state-changing operation writes an audit record.
7. **Bilingual by design.** `ar` / `en`, RTL/LTR, from the first screen.
8. **Simple and modular.** Boring, maintainable modules beat clever architecture.

## 2. Runtime shape

```
┌────────────────────────────────────────────────────────────────┐
│ Web client (React + Vite, RTL/LTR, i18n)                       │
└──────────────┬─────────────────────────────────────────────────┘
               │ HTTPS (session cookie / JWT)
┌──────────────▼─────────────────────────────────────────────────┐
│ API server (Node + TypeScript + Express)                       │
│  ├── auth & session                                            │
│  ├── RBAC + scope resolution (workspace/user)                  │
│  ├── domain services (meetings, tasks, search, chat, research) │
│  ├── repository layer  ← the ONLY place SQL lives              │
│  ├── Action Gateway (policy → execute → audit → idempotency)   │
│  └── audit logger (append-only)                                │
└──────┬─────────────────────────┬───────────────────────────────┘
       │ enqueue                 │ read/write
┌──────▼───────────────┐  ┌──────▼──────────────────────────────┐
│ Worker process       │  │ PostgreSQL (+ pgvector)             │
│ (jobs: transcode,    │  │  meetings, segments, summaries,     │
│  transcribe, analyze,│  │  decisions, action_items, tasks,    │
│  embed, research,    │  │  people, memory, jobs, audit_log,   │
│  followups)          │  │  integrations, approvals            │
└──────┬───────────────┘  └─────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│ Provider adapters (each isolated, each with a fake for tests)    │
│  LLMProvider │ TranscriptionProvider │ EmbeddingProvider         │
│  StorageProvider │ EmailProvider │ CalendarProvider │ WebSearch  │
└──────────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│ Object storage (audio/video, transcripts exports)                │
└──────────────────────────────────────────────────────────────────┘
```

## 3. Proposed stack (confirm in Phase 0, do not silently change later)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | one language, shared types between client and server |
| Frontend | React + Vite + TanStack Query + Tailwind | fast, works on Replit, easy RTL |
| Backend | Node + Express | simplest thing that runs reliably on Replit |
| DB | PostgreSQL + `pgvector` + `pg_trgm` | relational truth + vector search in one place, no extra infra |
| ORM/migrations | Drizzle (or Prisma) with **versioned migration files in git** | schema changes are reviewable, not magic |
| Jobs | DB-backed queue (`jobs` table + worker poll, `FOR UPDATE SKIP LOCKED`) | no Redis needed; survives restarts; observable in SQL |
| Storage | Object storage (Replit Object Storage / S3-compatible) | audio never lives on ephemeral disk |
| Validation | Zod at every boundary (HTTP in, LLM out, provider out) | untrusted input is validated, including model output |
| Auth | Email+password or OAuth via a real library, httpOnly cookies, CSRF protection | no hand-rolled crypto |
| Tests | Vitest (unit) + Supertest (API) + Playwright (critical flows) | proof, not claims |
| Logging | structured JSON logs with request id + correlation id, secrets redacted | debuggable in production |

**Monorepo layout**

```
/apps/web            React client
/apps/api            HTTP API
/apps/worker         background jobs
/packages/core       domain types, zod schemas, pure logic (no I/O)
/packages/db         schema, migrations, repositories
/packages/providers  llm/, asr/, embeddings/, storage/, email/, calendar/, search/
/packages/policy     permissions, policy engine, action definitions
/docs                this folder
```

Rule: `packages/core` has **zero** I/O imports. Domain logic must be testable without a network or a database.

## 4. Provider abstraction (mandatory)

```ts
export interface TranscriptionProvider {
  readonly id: string;                 // "elevenlabs-scribe", "whisper-1", ...
  transcribe(input: {
    mediaUri: string;
    languageHint: 'ar' | 'en' | 'mixed';
    diarize: boolean;
  }): Promise<{
    segments: Array<{ startMs: number; endMs: number; speaker: string; text: string; confidence?: number }>;
    providerId: string;
    modelVersion: string;
    rawRef: string;                    // pointer to stored raw response, for audit/debug
    usage: { audioSeconds: number; costUsd?: number };
  }>;
}

export interface LLMProvider {
  readonly id: string;
  complete<T>(input: {
    system: string;
    messages: Message[];
    schema: ZodSchema<T>;              // structured output, validated
    maxTokens: number;
    temperature: number;
  }): Promise<{ value: T; usage: TokenUsage; modelVersion: string }>;
}
```

- Model ids, temperatures and prompts live in **config**, not scattered in code.
- Every provider adapter ships with a deterministic fake used by tests — fakes live under `__fakes__` and must be impossible to load in production (guarded by `NODE_ENV` + explicit config, and asserted by a test).
- Switching provider = changing config, never editing domain code.

## 5. AI output contract (anti-hallucination)

Every extraction task returns JSON validated by a Zod schema where each item includes:

```ts
{
  ...fields,
  evidence: { segmentIds: string[], startMs: number, endMs: number },
  confidence: 'high' | 'medium' | 'low'
}
```

Post-validation (deterministic code, not the model):
1. Every `segmentId` must exist in that meeting. Unknown id → item dropped + logged.
2. Quoted text must actually appear in the referenced segments (normalized comparison). Mismatch → item dropped + logged.
3. Dropped items are counted and surfaced in the pipeline report; silent dropping is not allowed.
4. AI output enters the DB as `status = 'suggested'`. Human acceptance is a separate, audited transition.

## 6. Action Gateway

```
proposeAction(actorId, action) → policy.evaluate() → approval (if required)
                               → gateway.execute() → audit.write()
```

- Action = `{ type, payload, scope, idempotencyKey, requestedBy, requestedVia: 'ui' | 'ai' }`.
- The policy engine is deterministic TypeScript + DB rules. The model can *propose*; it can never *authorize*.
- Actions with external effects (email send, calendar write, file share) default to `requiresApproval: true`.
- The approved payload is hashed; execution re-verifies the hash so the executed content is exactly what was approved.
- Every execution writes: actor, action type, payload digest, policy decision + reason, provider response id, result, duration.

## 7. Multi-tenancy & data scoping

- Every domain row carries `workspace_id`.
- Scope filters are applied in the repository layer, not in controllers, and never assembled by the model.
- A repository method that can read across workspaces must not exist. Tests assert cross-workspace reads fail.

## 8. Audit log

Append-only table; no `UPDATE`, no `DELETE` (enforced by DB permissions/trigger). Each row: `id, workspace_id, actor_type (user|ai|system), actor_id, action, target_type, target_id, payload_digest, result, reason, ip, user_agent, created_at, prev_hash, hash`. The hash chain makes tampering detectable.

## 9. Observability & limits

- Request id propagated to jobs and provider calls.
- Per-workspace quotas: audio minutes/month, LLM tokens/day, research calls/day. Exceeding a quota returns a real error, never degraded fake output.
- Every provider call records latency, cost and outcome; a cost dashboard exists before integrations ship.

## 10. Failure policy

- No silent fallbacks. If ASR fails, the meeting is `failed` with a reason and a retry button.
- No partial success shown as success.
- Retries: exponential backoff, capped, idempotent, with a dead-letter state a human can inspect.
