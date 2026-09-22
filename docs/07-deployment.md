# 07 — Deployment and operations

The application is three processes and two stores:

| Process | What it does | Scale |
|---|---|---|
| **api** | HTTP API and (in production) the built web client | horizontal, stateless |
| **worker** | transcoding, transcription, analysis, embeddings, retention, erasure, approved external actions | at least one, always on |
| **postgres** | all relational data, full-text and vector search | managed or self-hosted, with backups |
| **object storage** | meeting media | S3-compatible (S3, R2, MinIO, Wasabi) |

**The worker is not optional.** Without it nothing is transcribed, analysed,
purged or executed; the queue simply grows. A deployment without an always-on
worker is not a deployment of this product.

---

## 1. Requirements

- Node 22+
- PostgreSQL 16+ with `pgvector`, `pg_trgm`, `unaccent`
- S3-compatible object storage and its four credentials (see §3.1)
- A stable public HTTPS origin (`PUBLIC_BASE_URL`) before OAuth is used
- `SECRETS_KEY` — 32 random bytes, base64 (`openssl rand -base64 32`)

## 2. First deploy

```bash
cp .env.example .env          # fill in DATABASE_URL, SECRETS_KEY, storage
npm ci
npm run db:migrate            # applies migrations, then verifies extensions
npm run build:web
npm run start:api             # serves the API and the client
npm run start:worker          # separate process
```

`npm run db:migrate` exits non-zero when a required extension is missing, so a
misconfigured database fails the deploy instead of failing at request time.

### Docker Compose (self-hosted)

```bash
cp .env.example .env          # POSTGRES_PASSWORD, SECRETS_KEY and the four S3_* values
docker compose up -d --build
docker compose logs -f worker
```

Compose runs migrations as a one-shot job, then starts `api` and `worker`.
Both containers run as the image's unprivileged user (uid 10001) and mount no
writable data volume — media lives in object storage, so there is no volume
ownership to fix and nothing has to run as root. Only Postgres has a volume.

If a required storage variable is missing, compose refuses to start and names
it, instead of bringing up containers that would fail on the first upload:

```
error while interpolating services.api.environment.S3_BUCKET:
required variable S3_BUCKET is missing a value: set S3_BUCKET in .env
```

`.env` is optional: the same variables can come from the platform's secret
store or the shell environment.

### Managed platforms

`fly.toml` and `render.yaml` in the repository root are working starting points.
Both define the api and the worker as separate processes, which is the part
people get wrong. Point `DATABASE_URL` at a managed Postgres with pgvector
(Neon, Supabase, RDS with the extension enabled).

## 3. Storage

### 3.1 Production: S3-compatible object storage

`STORAGE_PROVIDER=s3` plus four required variables — supply your own values,
there are no defaults:

| Variable | Required | Notes |
|---|---|---|
| `S3_BUCKET` | yes | bucket that will hold meeting media |
| `S3_REGION` | yes | e.g. the bucket's region; `auto` for Cloudflare R2 |
| `S3_ACCESS_KEY_ID` | yes | scoped to that bucket only |
| `S3_SECRET_ACCESS_KEY` | yes | keep it in the secret store, never in git |
| `S3_ENDPOINT` | no | leave unset for AWS S3; set it for R2, MinIO or another S3-compatible service. Path-style addressing turns on automatically when it is set |

The adapter uses only ordinary S3 operations — `PutObject`, `GetObject`
(including ranged reads for media seeking), `HeadObject`, `DeleteObject`,
`ListObjectsV2` and `DeleteObjects` — so any S3-compatible service works. The
credentials need exactly those permissions on one bucket, nothing more.

Recommended bucket settings: private (no public access), server-side
encryption, versioning if you want recovery, and a lifecycle rule that matches
the retention policy you configure in the app.

### 3.2 Development and tests: local filesystem

`STORAGE_PROVIDER=local` with `STORAGE_LOCAL_DIR` is a real implementation, not
a stub, and is what `npm run dev:api` / `dev:worker` and the test suite use. It
is **not** supported inside the containers: they run unprivileged and mount no
writable data volume by design.

## 4. Configuration and secrets

Every provider is optional and resolved from the environment. A provider that
is not configured reports `NOT_CONFIGURED` through `/api/v1/system/capabilities`
and the feature is visibly unavailable in the UI — it never degrades into
fabricated output.

Secrets live in the platform's secret store, never in the image or the repo.
OAuth tokens are encrypted with `SECRETS_KEY` before they reach the database and
are never logged or returned by any endpoint. Rotating `SECRETS_KEY` invalidates
stored tokens: users reconnect their accounts.

## 5. Health, readiness and monitoring

| Endpoint | Use |
|---|---|
| `GET /health` | liveness — the process is up |
| `GET /ready` | readiness — database reachable and required extensions installed |
| `GET /metrics` | Prometheus metrics (guard with `METRICS_TOKEN` if publicly reachable) |

Alert on:

- `alia_jobs{status="dead"} > 0` — work failed permanently; a human must look
- `alia_oldest_queued_job_seconds` climbing — the worker is down or stuck
- `alia_provider_calls_24h{outcome="failure"}` rising — provider or quota trouble
- `alia_provider_cost_usd_24h` above your budget line
- `/ready` non-200

Logs are structured JSON with a request id that propagates into jobs; secrets
are redacted by the logger and transcripts are never logged.

## 6. Backups and restore

```bash
DATABASE_URL=... npm run backup          # nightly, from cron
DATABASE_URL=... npm run restore:drill   # monthly: restore into a scratch DB
```

`restore:drill` restores the newest dump into a throwaway database and prints
row counts and installed extensions. A backup you have never restored is not a
backup. Media is backed up with the storage provider's own tooling (S3
versioning and lifecycle rules, or filesystem snapshots for the local adapter).

## 7. Data lifecycle in production

- Retention is per workspace (`retention_days`, `media_retention_days`). The
  worker sweeps hourly and queues erasure for anything past its window.
- Erasure removes storage objects, transcript segments, embeddings, summaries,
  decisions, action items and chapters, then writes a `deletion_records` row.
- `GET /api/v1/workspace/export` returns the workspace's data as JSON.
- The audit log is append-only and hash-chained; `UPDATE`/`DELETE` are refused
  by database triggers.

## 8. Scaling notes

- **api**: stateless; scale horizontally. In-process rate limiting is per
  instance — put a shared limiter at the edge, or accept `N × limit`.
- **worker**: add instances for throughput; `FOR UPDATE SKIP LOCKED` makes
  claiming safe. Long transcodes are CPU and memory heavy — give workers more
  than the API.
- **postgres**: `transcript_segments` is the large table. Watch the HNSW index
  and connection count before anything else.
- **uploads**: chunks are written to storage and assembled on completion, so
  request memory stays flat regardless of file size.
- **worker disk**: transcoding writes temporary files to `/tmp` inside the
  container. Give the host enough free space for the largest meeting you expect,
  plus its normalized copy.

## 9. Pre-production checklist

- [ ] `npm run verify` green, `npm run test:e2e` green against the deployment
- [ ] `/ready` returns 200 with all three extensions installed
- [ ] Worker running, `alia_oldest_queued_job_seconds` stays low under load
- [ ] `SECRETS_KEY` set and stored in the secret manager, not in the repo
- [ ] S3 bucket created, private, with credentials scoped to it; `docker compose
      config` resolves with no missing variables
- [ ] Backups scheduled **and** a restore drill completed
- [ ] Retention and consent policy set per workspace, reviewed by whoever owns
      the legal side
- [ ] ASR provider benchmarked on real Arabic audio (docs/04-ai-pipeline.md §5)
- [ ] Cost alerts configured against `alia_provider_cost_usd_24h`
- [ ] OAuth clients registered with the production redirect URIs; Google
      restricted-scope verification started if Gmail is in scope
