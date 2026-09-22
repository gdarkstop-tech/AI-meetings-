# AI Meeting & Work Assistant

Record or upload a meeting → transcript (speakers + timestamps) → summaries → decisions → action
items → tasks → search → an assistant that answers questions about past meetings → follow-up email
and calendar drafts that a human approves before anything leaves the system.

Arabic + English + mixed speech. RTL/LTR from the first screen. Built to the ALIA / EAIOS
principles: the LLM is never the security boundary, retrieved content is data (not instructions),
providers are replaceable, and every external side effect is approved and audited.

**Status: the product is built and verified end to end.** Meetings, resumable upload and browser
recording, ffmpeg normalization, speech-to-text, evidence-validated analysis, tasks, bilingual
hybrid search, Ask-AI with citations, the Action Gateway with human approval, calendar and email
integrations, research with provenance, consent/retention/erasure, and a deployable
API + worker + client.

Every external capability is a real adapter selected by configuration. Anything without
credentials reports `NOT_CONFIGURED` and is visibly unavailable — nothing is ever simulated.

---

## نظرة سريعة (بالعربي)

الفكرة: تطبيق يسجّل أو يستقبل تسجيل الاجتماع، ويحوّله إلى Transcript + Summary + Decisions +
Action Items + Tasks + Research، وبعدها تقدر تبحث وتسأل الـ AI عن أي اجتماع قديم، ويجهّز لك
Follow-up (إيميل / Calendar) لكن **لا يرسل أي شيء إلا بموافقتك**.

الملفات هنا ثلاث مجموعات:
1. **المواصفات** — الـ scope والـ architecture والـ data model والأمان (`docs/00` → `docs/06`).
2. **الـ Master Prompt لـ Replit** — تنسخه كأول رسالة للـ Replit Agent (`docs/10`).
3. **الـ Phase Prompts + طريقة التحقق** — مرحلة واحدة كل مرة، ولا تقبل مرحلة قبل ما تختبرها بنفسك
   (`docs/11`, `docs/12`).

القاعدة الأهم: **الـ Agent ممنوع يزوّر أي شيء.** أي ميزة غير منفّذة لازم تفشل بوضوح
(`NOT_IMPLEMENTED` / `NOT_CONFIGURED`) ولا تظهر نجاحاً وهمياً.

---

## Quickstart (development)

```bash
# 1. PostgreSQL 16 with pg_trgm, unaccent and pgvector must be reachable
cp .env.example .env          # set DATABASE_URL and TEST_DATABASE_URL

npm install
npm run db:migrate            # applies migrations, then verifies the extensions
npm run db:seed               # optional dev workspace, owner + member

npm run dev:api               # http://127.0.0.1:4000
npm run dev:web               # http://127.0.0.1:5173
npm run dev:worker            # drains the job queue (no handlers registered yet)

npm run verify                # typecheck + architecture boundaries + 62 tests
npm run test:e2e              # browser smoke test (needs api + web running)
```

Health and honesty endpoints: `GET /health`, `GET /ready` (database + extensions),
`GET /api/v1/system/capabilities` (what is real, what is not).

## Repository layout

```
apps/api            HTTP API: auth, meetings, uploads, insights, tasks, search,
                    ask-AI, actions, integrations, research, workspace governance
apps/worker         background worker: transcode, transcribe, embed, analyse,
                    research, retention sweep, erasure, approved external actions
apps/web            React + Vite client (ar/en, RTL/LTR)
packages/core       domain types, errors, Arabic/English normalization, evidence
                    validation, consent/retention rules, crypto — no I/O
packages/db         schema, SQL migrations, repositories (the only place SQL lives)
packages/pipeline   media, analysis, search, RAG, research, Action Gateway, jobs
packages/policy     deterministic RBAC and external-action policy
packages/providers  storage, ASR, LLM, embeddings, calendar, email, web search
packages/observability  structured logging with secret redaction
```

## How it works

```
record / upload → resumable chunked upload → object storage
   → ffmpeg normalize (mono 16 kHz) → speech-to-text (diarized, timestamped)
   → evidence-validated analysis (summaries, decisions, action items, chapters)
   → human accepts → tasks
   → hybrid Arabic/English search + Ask-AI with citations
   → follow-up drafts → policy → human approval → Action Gateway → email/calendar
```

Two rules hold throughout: the model proposes and deterministic code decides, and anything the
model cannot support with a transcript segment or a retrieved source is dropped and counted rather
than shown.

## Deployment

See [`docs/07-deployment.md`](docs/07-deployment.md). `docker compose up -d --build` runs Postgres
with pgvector, applies migrations, and starts the API and the always-on worker. `fly.toml` and
`render.yaml` are working starting points for managed platforms.

## Documents

| File | What it is |
|---|---|
| [`docs/00-product-scope.md`](docs/00-product-scope.md) | Full product scope, feature by feature, plus non-goals and open decisions |
| [`docs/01-architecture.md`](docs/01-architecture.md) | Runtime shape, stack, provider abstraction, AI output contract, Action Gateway |
| [`docs/02-data-model.md`](docs/02-data-model.md) | PostgreSQL schema, indexes, invariants |
| [`docs/03-security.md`](docs/03-security.md) | Threat model, authorization, action policy, secrets, privacy, injection defences |
| [`docs/04-ai-pipeline.md`](docs/04-ai-pipeline.md) | Job stages, language handling, prompts, evaluation, RAG and research design |
| [`docs/05-integrations.md`](docs/05-integrations.md) | Calendar, email and search provider interfaces, OAuth and execution rules |
| [`docs/06-replit-notes.md`](docs/06-replit-notes.md) | Platform constraints to design around |
| [`docs/10-master-prompt-replit.md`](docs/10-master-prompt-replit.md) | **The master prompt** — paste as the first message to the Replit Agent |
| [`docs/11-phase-prompts.md`](docs/11-phase-prompts.md) | Phase 1–15 prompts, one per message |
| [`docs/12-verification.md`](docs/12-verification.md) | How to verify each phase, red flags, the "unplug" test |
| [`docs/adr/`](docs/adr/) | Architecture decision records |

## How to run the build

1. Paste **Section A** of `docs/10-master-prompt-replit.md` as the first message to the Replit Agent.
2. The agent executes **Phase 0 only** (audit, risks, cost model, plan) and stops.
3. Review it, answer its open questions, then paste Phase 1 from `docs/11-phase-prompts.md`.
4. Before accepting any phase, run the checks in `docs/12-verification.md` yourself.
5. Record the result in the phase acceptance table. Never accept a partial phase.

## Build order (why it is this order)

Foundation → meetings → transcription → analysis → tasks → search → Ask AI → people →
**Action Gateway** → calendar → email → follow-ups → research → memory → hardening.

The Action Gateway (policy + approval + idempotency + audit) ships **before** any integration that
can affect the outside world. That ordering is the difference between an assistant and an incident.
