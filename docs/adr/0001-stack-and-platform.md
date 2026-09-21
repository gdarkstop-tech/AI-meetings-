# ADR 0001 — Stack and platform

**Status:** Proposed (confirm in Phase 0)
**Date:** 2026-09-21

## Context
Greenfield build, first implementation target is Replit. The team is small; the product must be
production-grade, bilingual (ar/en), and portable to any Node host later.

## Decision
TypeScript everywhere; React + Vite client; Node + Express API; PostgreSQL with `pgvector` and
`pg_trgm`; versioned migrations (Drizzle); a database-backed job queue drained by a separate worker
process; object storage for media; Zod validation at all boundaries; Vitest + Playwright.

## Rationale
- One language and shared types lower the cost of change for a small team.
- Postgres covers relational data, full-text and vector search — no Redis/Elastic/vector-DB to
  operate on day one.
- A DB-backed queue survives restarts, is inspectable with SQL, and needs no extra infrastructure.
- Nothing in this list is Replit-specific, so the app stays portable.

## Consequences
- A separate always-on worker deployment is mandatory; the platform must support it (verified in
  Phase 0).
- Vector search performance must be revisited when transcript volume grows (index type, dimensions).
- If real-time live transcription is added later, a streaming path will be needed alongside the
  queue.
