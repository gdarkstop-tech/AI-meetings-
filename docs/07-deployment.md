# 07 — Deployment and operations

The application is three processes and two stores:

| Process | What it does | Scale |
|---|---|---|
| **api** | HTTP API and (in production) the built web client | horizontal, stateless |
| **worker** | transcoding, transcription, analysis, embeddings, retention, erasure, approved external actions | at least one, always on |
| **postgres** | all relational data, full-text and vector search | managed or self-hosted, with backups |
| **object storage** | meeting media | S3-compatible or a mounted volume |

**The worker is not optional.** Without it nothing is transcribed, analysed,
purged or executed; the queue simply grows. A deployment without an always-on
worker is not a deployment of this product.

---

## 1. Requirements

- Node 22+
- PostgreSQL 16+ with `pgvector`, `pg_trgm`, `unaccent`
- A writable object store (S3/R2/MinIO) or a persistent volume
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
cp .env.example .env          # also set POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs -f worker
```

Compose runs migrations as a one-shot job, then starts `api` and `worker`
against the same media volume.

### Managed platforms

`fly.toml` and `render.yaml` in the repository root are working starting points.
Both define the api and the worker as separate processes, which is the part
people get wrong. Point `DATABASE_URL` at a managed Postgres with pgvector
(Neon, Supabase, RDS with the extension enabled).

## 3. Configuration and secrets

Every provider is optional and resolved from the environment. A provider that
is not configured reports `NOT_CONFIGURED` through `/api/v1/system/capabilities`
and the feature is visibly unavailable in the UI — it never degrades into
fabricated output.

Secrets live in the platform's secret store, never in the image or the repo.
OAuth tokens are encrypted with `SECRETS_KEY` before they reach the database and
are never logged or returned by any endpoint. Rotating `SECRETS_KEY` invalidates
stored tokens: users reconnect their accounts.

## 4. Health, readiness and monitoring

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

## 5. Backups and restore

```bash
DATABASE_URL=... npm run backup          # nightly, from cron
DATABASE_URL=... npm run restore:drill   # monthly: restore into a scratch DB
```

`restore:drill` restores the newest dump into a throwaway database and prints
row counts and installed extensions. A backup you have never restored is not a
backup. Media is backed up with the storage provider's own tooling (S3
versioning and lifecycle rules, or filesystem snapshots for the local adapter).

## 6. Data lifecycle in production

- Retention is per workspace (`retention_days`, `media_retention_days`). The
  worker sweeps hourly and queues erasure for anything past its window.
- Erasure removes storage objects, transcript segments, embeddings, summaries,
  decisions, action items and chapters, then writes a `deletion_records` row.
- `GET /api/v1/workspace/export` returns the workspace's data as JSON.
- The audit log is append-only and hash-chained; `UPDATE`/`DELETE` are refused
  by database triggers.

## 7. Scaling notes

- **api**: stateless; scale horizontally. In-process rate limiting is per
  instance — put a shared limiter at the edge, or accept `N × limit`.
- **worker**: add instances for throughput; `FOR UPDATE SKIP LOCKED` makes
  claiming safe. Long transcodes are CPU and memory heavy — give workers more
  than the API.
- **postgres**: `transcript_segments` is the large table. Watch the HNSW index
  and connection count before anything else.
- **uploads**: chunks are written to storage and assembled on completion, so
  request memory stays flat regardless of file size.

## 8. Pre-production checklist

- [ ] `npm run verify` green, `npm run test:e2e` green against the deployment
- [ ] `/ready` returns 200 with all three extensions installed
- [ ] Worker running, `alia_oldest_queued_job_seconds` stays low under load
- [ ] `SECRETS_KEY` set and stored in the secret manager, not in the repo
- [ ] Backups scheduled **and** a restore drill completed
- [ ] Retention and consent policy set per workspace, reviewed by whoever owns
      the legal side
- [ ] ASR provider benchmarked on real Arabic audio (docs/04-ai-pipeline.md §5)
- [ ] Cost alerts configured against `alia_provider_cost_usd_24h`
- [ ] OAuth clients registered with the production redirect URIs; Google
      restricted-scope verification started if Gmail is in scope
