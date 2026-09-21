# 06 — Replit Platform Notes

Practical constraints to design around (verify current behaviour in Phase 0 rather than trusting any of this blindly):

1. **The filesystem is not durable storage.** Uploaded audio must go to object storage (Replit Object Storage or S3-compatible). A file written to the repl's disk can disappear on redeploy.
2. **HTTP requests must stay short.** Transcription of a 90-minute meeting cannot happen inside a request. It must be a job picked up by a worker.
3. **Background work needs an always-on process.** A worker must run as a separate deployment (Reserved VM / background worker) or a scheduled job that drains the queue. A worker that only runs while a browser tab is open is not a system.
4. **Secrets** go in Replit Secrets, and are read from `process.env` inside adapters only. Never committed, never printed.
5. **Database:** use the managed Postgres (Neon-backed) and enable `pgvector` + `pg_trgm`. Keep migrations as files in git; never edit the schema by hand in a console without a migration.
6. **Concurrency:** one repl can serve limited traffic; the queue must tolerate a single worker with limited parallelism (`max_concurrent_jobs` in config).
7. **Timeouts and memory:** audio transcoding is memory-heavy; stream, don't buffer whole files; cap upload size and reject early with a clear error.
8. **Environments:** at minimum `development` and `production` with separate databases, separate buckets, separate OAuth clients and separate secrets. Never point development at production data.
9. **Cold starts / sleeping repls:** scheduled jobs (retention, token refresh, digests) need a real scheduler, not "whenever someone opens the app".
10. **Portability:** nothing Replit-specific may leak into domain code — only into `packages/providers` and config. The app must be movable to any Node host.
