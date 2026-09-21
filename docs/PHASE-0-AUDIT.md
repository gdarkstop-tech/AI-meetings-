# PHASE 0 — AUDIT

**Date:** 2026-09-21
**Executed by:** Claude Code (remote sandbox session), following Section A of `docs/10-master-prompt-replit.md`
**Adaptation:** the master prompt targets the Replit Agent. This audit was executed against the actual
environment available: a Claude Code **remote sandbox container**, not Replit. Everything below that
concerns Replit itself is therefore marked `NOT VERIFIED` — it must be re-verified on the chosen host.

**Status vocabulary used throughout:** `VERIFIED` (I ran it and show the output) · `NOT VERIFIED`
(plausible but untested here) · `NOT CONFIGURED` (exists as a concept, no credentials/config present) ·
`NOT AVAILABLE` (checked, absent) · `BLOCKED` (cannot proceed without a decision or credential).

---

## 1. REPOSITORY AUDIT — `VERIFIED`

```
$ find . -path ./.git -prune -o -type f -print | sort
./README.md
./docs/00-product-scope.md      ./docs/01-architecture.md    ./docs/02-data-model.md
./docs/03-security.md           ./docs/04-ai-pipeline.md     ./docs/05-integrations.md
./docs/06-replit-notes.md       ./docs/10-master-prompt-replit.md
./docs/11-phase-prompts.md      ./docs/12-verification.md
./docs/adr/0001-stack-and-platform.md  ./docs/adr/0002-provider-abstraction.md
./docs/adr/0003-action-gateway.md

$ git log --oneline --all
11b4ebf docs: add product scope, architecture and phased Replit build prompts
b0d6806 Initial commit
```

| Item | Status |
|---|---|
| Application source code | `NOT AVAILABLE` — zero lines. 14 files, all Markdown specification. |
| `package.json`, `tsconfig.json`, lockfile | `NOT AVAILABLE` |
| `.replit`, `replit.nix`, `Dockerfile`, `docker-compose.yml` | `NOT AVAILABLE` |
| `.env`, `.env.example` | `NOT AVAILABLE` |
| `CLAUDE.md` / agent config | `NOT AVAILABLE` |
| CI (`.github/workflows`) | `NOT AVAILABLE` locally; GitHub API reports `{"total_count":0}` workflows — `VERIFIED` |
| Database | `NOT AVAILABLE` — no schema, no migrations, no connection string |
| Git remote | `VERIFIED` — `https://github.com/gdarkstop-tech/AI-meetings-`, branches `main` + `claude/peaceful-rubin-3dwoiq`; push from this session works |
| Template scaffolding left over | none — this is a clean greenfield |

**Conclusion:** there is nothing to migrate, refactor or rescue. Phase 1 starts from an empty
codebase against a written specification. That is the best possible starting position, and it also
means **no capability of this product currently exists.**

---

## 2. PLATFORM AUDIT — what this environment actually is

**Critical finding: this environment is a BUILD environment, not a RUNTIME environment.**
It is an ephemeral sandbox container (`CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE=cloud_default`,
`IS_SANDBOX=yes`, container id `container_01N47XRdh9YMc7pLGf9kuqRW--claude_code_remote--00d2be`).
It is reclaimed after inactivity; only what is committed and pushed survives. **No production
decision has been made about where the application will actually run.** That decision is `BLOCKED`
on you and is required before Phase 3.

### 2.1 Hardware and OS — `VERIFIED`
```
Ubuntu 24.04.4 LTS · Linux 6.18.44 x86_64 · 4 vCPU · 15 GiB RAM · 252 GB disk (30 GB available)
```
Sufficient for development and for transcoding tests. Says nothing about production capacity.

### 2.2 Runtimes — `VERIFIED`
| Present | Absent |
|---|---|
| node v22.22.2, npm 10.9.7, pnpm, yarn, bun | deno `NOT AVAILABLE` |
| python 3.11.15, pip3, go, rustc, java | ffmpeg / ffprobe / sox `NOT AVAILABLE` (see 2.4) |
| psql 16.13 **and** PostgreSQL 16 server binaries in `/usr/lib/postgresql/16/bin` | running Postgres service `NOT AVAILABLE` (port 5432 refused) |
| redis-cli **and** `/usr/bin/redis-server` | running Redis `NOT AVAILABLE` (port 6379 refused) |
| docker CLI | docker **daemon** `NOT AVAILABLE` — `dial unix /var/run/docker.sock: no such file or directory` |
| git, curl, jq, openssl 3.0.13 | |
| Playwright browsers at `/opt/pw-browsers` (chromium, chromium-1194, headless shell) — E2E testing is feasible | |

### 2.3 Database feasibility — `VERIFIED` (with one important gap)

A real PostgreSQL 16 instance was started and queried in this container:
```
initdb: OK
pg_ctl start: OK
 PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu

CREATE EXTENSION   -- pg_trgm   OK
CREATE EXTENSION   -- unaccent  OK
ERROR:  extension "vector" is not available
DETAIL:  Could not open extension control file ".../extension/vector.control": No such file or directory
```

- `pg_trgm`, `unaccent` — `VERIFIED` available.
- `pgvector` — `NOT AVAILABLE` in this container. apt candidate `postgresql-16-pgvector 0.6.0-1`
  exists and `archive.ubuntu.com` returns 200, so installation is plausible but `NOT VERIFIED`.
- Neon (managed) supports pgvector: fetched from `https://neon.com/docs/extensions/pgvector`
  on 2026-09-21 — *"pgvector is available on every Neon plan with no add-on or paid tier required."*
  Treated as vendor documentation, `NOT VERIFIED` by execution against our own database.

**Arabic search behaviour — `VERIFIED`, and it confirms a design requirement:**
```sql
select to_tsvector('simple','نحتاج إنهاء الموقع يوم الخميس');
→ 'إنهاء':2 'الخميس':5 'الموقع':3 'نحتاج':1 'يوم':4      -- tokenization works

select similarity('الموقع','الموقـع');   -- same word, one with tatweel
→ 0.5                                     -- they do NOT match well
```
Postgres tokenizes Arabic acceptably with the `simple` configuration, but does **no** Arabic
normalization. The custom normalization function specified in `docs/04-ai-pipeline.md`
(tatweel, diacritics, alef/ya/ta-marbuta forms) is not optional — this measurement proves it.

### 2.4 Media processing — `VERIFIED` obtainable
ffmpeg is not preinstalled, but a working static binary installs from npm in ~5 s:
```
$ npm install ffmpeg-static@5.3.0 → added 20 packages in 5s
$ $(node -e "console.log(require('ffmpeg-static'))") -version
ffmpeg version 7.0.2-static  https://johnvansickle.com/ffmpeg/
```
Transcoding is therefore feasible without a system package. Licensing of the chosen ffmpeg build
for commercial distribution is `NOT VERIFIED` and must be checked before production.

### 2.5 Network egress — `VERIFIED`
All traffic leaves through the session's agent proxy (`bundleCoversEveryHost: true`). Measured
status codes (401/403/404 mean *host reachable, not authenticated* — which is the expected result
without keys):

| Endpoint | Code |
|---|---|
| `registry.npmjs.org` | 200 |
| `api.anthropic.com/v1/models` | 401 |
| `api.openai.com/v1/models` | 401 |
| `api.deepgram.com/v1/projects` | 401 |
| `api.assemblyai.com/v2/transcript` | 401 |
| `api.elevenlabs.io/v1/models` | 404 (host reachable) |
| `www.googleapis.com/discovery/v1/apis` | 200 |
| `graph.microsoft.com/v1.0/` | 200 |
| `console.neon.tech/api/v2/projects` | 401 |
| `api.github.com` | 200 |
| `archive.ubuntu.com` | 200 |

### 2.6 Inbound network — `NOT AVAILABLE`
No listening services, no documented public ingress for this container. Local binding works
(`node http.createServer` on `127.0.0.1:3999` → 200 `VERIFIED`), but there is **no public HTTPS URL**.

Consequences, and they are significant:
- OAuth redirect URIs (Google / Microsoft) cannot be tested from this environment — `BLOCKED` until a host with a stable public HTTPS URL exists.
- Inbound webhooks cannot be received here.
- Phases 10–11 cannot be completed from this environment alone.

### 2.7 Always-on worker — `NOT AVAILABLE here`, `NOT VERIFIED` on any host
Nothing in this container survives session end, so the background worker required by the
architecture (`docs/01-architecture.md` §2) cannot live here. Whether Replit (or any alternative)
provides a suitable always-on process is `NOT VERIFIED` — no Replit account or project was
available to this session to test against.

### 2.8 Secrets and credentials present — `VERIFIED` (names only; no values were read or printed)

**All application provider credentials are `NOT CONFIGURED`:**
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`,
`ELEVENLABS_API_KEY`, `ASSEMBLYAI_API_KEY`, `AZURE_SPEECH_KEY`, `S3_BUCKET`, `GOOGLE_CLIENT_ID`,
`MICROSOFT_CLIENT_ID`, `TAVILY_API_KEY`, `BRAVE_API_KEY`, `DATABASE_URL`, `PGHOST/PGUSER/PGPASSWORD`.

Two sets of credentials **do** exist in the sandbox environment and must not be confused with
application credentials:
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — belong to the agent sandbox infrastructure.
  They were **not** used and **must never** be used by this application. Whether they grant any S3
  access is `NOT VERIFIED` and deliberately untested.
- `GH_TOKEN` / `GITHUB_TOKEN` — this session's GitHub access, scoped to this repository.

### 2.9 Managed services reachable through connected Claude connectors — `VERIFIED`, with a caveat

This Claude session has connectors for Neon, ElevenLabs, Google Calendar, Slack, Notion, Linear,
GitHub, HubSpot, Asana, monday.com, n8n, Expo, GitBook and Inkbox.

**These are connectors on your Claude account. They are NOT application credentials and the product
cannot use them.** The application will need its own API keys and its own OAuth clients. Treating a
Claude connector as proof that the app "has an integration" would be exactly the kind of fake
capability the master prompt forbids.

One managed database account is real and visible (read-only listing):
```json
{ "name": "Sanad", "id": "cool-mountain-82476840", "pg_version": 16,
  "region_id": "aws-us-east-2", "autoscaling": "0.25–2 CU",
  "branch_logical_size_limit": 512 (MB), "org_id": "org-lucky-credit-24055641",
  "effective_project_permission": "ADMIN" }
```
So: a Neon organization exists and is usable, running Postgres 16 — but **no project exists for
this product**, and the visible project belongs to a different application (`Sanad`). Nothing was
created, modified or queried. The 512 MB branch logical size limit indicates a Free-plan project;
transcripts plus embeddings will exceed that quickly (see §5).

---

## 3. STACK CONFIRMATION

The stack proposed in `docs/adr/0001-stack-and-platform.md` is **confirmed**, with two changes and
one open decision.

| Component | Verdict | Evidence / reason |
|---|---|---|
| TypeScript (strict) | Confirmed | Node 22 present |
| React + Vite | Confirmed | no constraint found against it |
| Node + Express | Confirmed | Node 22.22.2 verified |
| PostgreSQL 16 | Confirmed | server verified running locally; Neon offers PG 16 |
| `pg_trgm`, `unaccent` | Confirmed | `CREATE EXTENSION` succeeded |
| `pgvector` | **Confirmed with a condition** | not present locally; must be installed (apt) or provided by Neon. Phase 1 must prove `CREATE EXTENSION vector` succeeds on the real dev database before any embedding work is planned |
| Drizzle migrations | Confirmed | file-based migrations, reviewable in git |
| DB-backed job queue + separate worker | Confirmed **in design**, `BLOCKED` in practice | requires an always-on process on a host that does not yet exist |
| Object storage | **`NOT CONFIGURED` — decision required** | no bucket, no credentials. Candidates: Cloudflare R2, AWS S3, Replit Object Storage. Verify egress pricing before choosing (no pricing verified here) |
| Zod validation | Confirmed | |
| Vitest + Playwright | Confirmed | Chromium present at `/opt/pw-browsers` |
| **Change 1: ffmpeg via `ffmpeg-static`** | New | system ffmpeg absent; npm binary verified working |
| **Change 2: no Redis, no Docker in dev** | New | no daemon available; the DB-backed queue design already avoids Redis, which this environment now validates as the right call |

---

## 4. PROPOSED STRUCTURE (to be created in Phase 1)

```
/apps/web          React + Vite client (i18n, RTL/LTR)
/apps/api          Express HTTP API
/apps/worker       background job runner
/packages/core     domain types, Zod schemas, pure logic — ZERO I/O imports (lint-enforced)
/packages/db       Drizzle schema, migrations, repositories (the only place SQL lives)
/packages/providers  llm/ asr/ embeddings/ storage/ email/ calendar/ search/ (+ __fakes__)
/packages/policy   permissions, policy engine, action definitions
/docs              specification (already present)
```
Boundary rules: `core` imports nothing with I/O; `apps/*` never import provider SDKs directly;
`packages/db` is the only module issuing SQL; `packages/providers/**/__fakes__` cannot load when
`NODE_ENV=production` (guarded and asserted by a test).

---

## 5. COST MODEL

All prices below were **fetched live on 2026-09-21** from the vendors' own pages. URLs are given so
you can re-check. Figures are quoted as published; nothing is invented. Anything I could not fetch
is marked `NOT VERIFIED`.

### 5.1 Speech-to-text — published prices per audio hour

| Provider / model | Published price | Per audio hour | Source |
|---|---|---|---|
| Deepgram Nova-3 monolingual | $0.0043/min | **$0.258** | deepgram.com/pricing |
| Deepgram Nova-3 multilingual | $0.0052/min | **$0.312** | deepgram.com/pricing |
| Deepgram Whisper Large | $0.0048/min | **$0.288** | deepgram.com/pricing |
| ElevenLabs Scribe (v2) | $0.22/hour | **$0.22** | elevenlabs.io/pricing/api |
| AssemblyAI Universal-2 + diarization | $0.15/hr + $0.02/hr | **$0.17** | assemblyai.com/pricing |
| AssemblyAI Universal-3.5 Pro + diarization | $0.21/hr + $0.02/hr | **$0.23** | assemblyai.com/pricing |
| OpenAI gpt-4o-mini-transcribe | $0.003/min | **$0.18** | developers.openai.com/api/docs/pricing |
| OpenAI gpt-4o-transcribe | $0.006/min | **$0.36** | developers.openai.com/api/docs/pricing |

Deepgram states diarization is **included** for pre-recorded audio. AssemblyAI charges it as an
add-on (figures above already include it).

**Arabic and Arabic-English code-switching quality for every provider above: `NOT VERIFIED`.**
Price is not quality. The provider choice must be made by the benchmark defined in
`docs/04-ai-pipeline.md` §5, run on real recordings of your own meetings, in Phase 3.

### 5.2 LLM analysis — published token prices

Claude (platform.claude.com/docs/en/about-claude/pricing, fetched 2026-09-21):
Haiku 4.5 **$1 / $5** per MTok (in/out) · Sonnet 5 **$2 / $10** · Opus 5 **$5 / $25**.
Batch API = 50 % discount; cache reads = 0.1× base input.

OpenAI (developers.openai.com/api/docs/pricing, fetched 2026-09-21): gpt-4o-mini **$0.15 / $0.60**,
gpt-4o **$2.50 / $10**, gpt-5.6-luna **$0.20 / $1.20**, gpt-5.6-terra **$2.00 / $12.00**.

### 5.3 Estimated cost per meeting hour — `ESTIMATE, assumptions stated`

Assumptions (each is an estimate, **not** a measurement):
- 1 hour of speech ≈ 9,000–10,000 words ≈ **~15k tokens** in English.
- Arabic consumes materially more tokens per word; assume **1.5–2×** → up to ~30k tokens. `NOT VERIFIED`.
- The analysis pipeline reads the transcript roughly **3×** (windowed summarization, reduce step,
  extraction) → ~45k–90k input tokens, producing ~5k–8k output tokens.

| Configuration | ASR | LLM analysis | **Total / audio hour** |
|---|---|---|---|
| ElevenLabs Scribe + Claude Haiku 4.5 | $0.22 | ~$0.09–0.13 | **~$0.31–0.35** |
| AssemblyAI U-2 + Claude Sonnet 5 | $0.17 | ~$0.18–0.26 | **~$0.35–0.43** |
| Deepgram Nova-3 multilingual + Claude Sonnet 5 | $0.31 | ~$0.18–0.26 | **~$0.49–0.57** |
| Deepgram Nova-3 multilingual + Claude Opus 5 | $0.31 | ~$0.45–0.65 | **~$0.76–0.96** |

At **200 meeting-hours/month**, AI cost lands roughly between **$62 and $115/month** for the
pipeline — excluding Ask-AI chat usage, embeddings, research, storage and egress, none of which are
modelled here. Embedding prices were **not fetched** → `NOT VERIFIED`.

### 5.4 Infrastructure — partially verified

Neon (neon.com/pricing, fetched 2026-09-21): Free **$0** (0.5 GB storage per project, 100 CU-hours
per project) · Launch and Scale are usage-based: storage **$0.35/GB-month**, compute
**$0.106/CU-hour** (Launch) or **$0.222/CU-hour** (Scale), storage unlimited on paid plans.

The existing `Sanad` project's 512 MB limit confirms Free-plan sizing. Transcripts are small, but
**embeddings are not**: at 1536 dimensions × 4 bytes ≈ 6 KB per vector plus index overhead, a few
thousand hours of meetings will pass 0.5 GB. Budget for a paid Neon plan from the first real users.

Object storage, hosting and egress costs: `NOT VERIFIED` — no host chosen, no bucket provisioned.
Audio is the dominant storage driver (1 hour of 16 kHz mono Opus ≈ 15–30 MB; original uploads are
far larger).

---

## 6. OPEN QUESTIONS — decisions I need from you

| # | Question | My recommendation |
|---|---|---|
| 1 | **Where does this run in production?** Replit Reserved VM, Fly.io, Render, Railway, or a VPS? | Needed before Phase 3. Any host is fine if it gives (a) an always-on worker process, (b) a stable public HTTPS URL for OAuth, (c) persistent object storage. If you want to stay on Replit, we verify its worker/deployment story first, on the actual account. |
| 2 | **Database:** new Neon project (paid plan) vs Postgres on the app host? | New **Neon** project on a paid plan — branching gives cheap per-developer and per-test databases, and pgvector is documented as available on every plan. Do not reuse the `Sanad` project. |
| 3 | **Object storage provider?** | Decide in Phase 2. Compare Cloudflare R2 vs S3 on egress cost for audio playback — playback egress, not storage, will dominate. |
| 4 | **ASR provider for Arabic** | Do not decide now. Phase 3 ships behind `TranscriptionProvider` and benchmarks at least Deepgram Nova-3 multilingual, ElevenLabs Scribe and one OpenAI model on your own recordings. |
| 5 | **Default LLM** | Claude Sonnet 5 for extraction quality, Haiku 4.5 for cheap/bulk stages, configurable per task. Revisit after the golden-set eval. |
| 6 | **Recording consent and retention policy** — which jurisdictions, what retention, who may listen back? | Blocking for real use. Needs a written answer before Phase 2 ships to anyone outside the team. |
| 7 | **Single-tenant or multi-tenant** for the first customers? | Build multi-tenant from day one (`workspace_id` everywhere) even if you deploy single-tenant — retrofitting tenancy is far more expensive. |
| 8 | **Data residency** (EU/US/MENA)? | Affects Neon region, storage region and provider choice. The existing Neon org is `aws-us-east-2`. |
| 9 | **Who are the first 5 real users**, and what audio will the golden set be built from? | Needed for Phase 3–4 evaluation; without real Arabic meeting audio the quality numbers are meaningless. |
| 10 | **Budget ceiling** per month for AI spend? | Sets the quota defaults in Phase 15 and the default model tier. |
| 11 | **Google/Microsoft OAuth**: who owns the Google Cloud and Azure app registrations, and is anyone prepared for the Google restricted-scope verification process for Gmail scopes? | Start it early if email is wanted; the review timeline and cost are `NOT VERIFIED` and can be measured in weeks. |

---

## 7. WHAT I DID NOT DO (deliberately)

- No application code, no `package.json`, no scaffolding, no UI.
- No database created on Neon, no query run against the existing `Sanad` project.
- No provider API keys requested, created or used; no paid API call made.
- No use of the sandbox's AWS credentials.
- No mock or placeholder implementation of anything.
