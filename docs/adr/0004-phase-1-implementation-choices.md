# ADR 0004 — Phase 1 implementation choices (and two deviations from ADR 0001)

**Status:** Accepted
**Date:** 2026-09-21
**Context:** Phase 1 builds the foundation. Two choices differ from ADR 0001 and are
recorded here rather than made silently.

## Decision 1 — `pg` with hand-written SQL migrations instead of Drizzle (deviation)

Repositories in `packages/db` issue parameterized SQL through `pg`; migrations are
numbered `.sql` files applied by `packages/db/src/migrate.ts`, which records a SHA-256
checksum per migration and refuses to run if an applied migration's content changed.

*Why:* fewer moving parts for a five-table foundation, no code generation step, and the
invariant that matters — **all SQL lives in `packages/db`** — is enforced mechanically by
`scripts/check-boundaries.mjs` rather than by an ORM. Every query is explicit and reviewable.

*Cost:* no generated types from the schema; row shapes are declared by hand in the
repository layer and validated at the API boundary with Zod.

*Revisit when:* the schema passes ~15 tables or relational query complexity grows
(realistically at Phase 4–6). Migrating to Drizzle later is contained because nothing
outside `packages/db` issues SQL.

## Decision 2 — scrypt (Node core) instead of argon2id (deviation)

Passwords use `node:crypto` scrypt with N=16384, r=8, p=1, 64-byte key, 16-byte random
salt, stored as `scrypt$N$r$p$salt$hash`.

*Why:* memory-hard, part of the Node runtime, no native build step (the build environment
has no Docker daemon and prebuilt native modules are an added supply-chain surface).

*Cost:* argon2id is the stronger modern default.

*Migration path:* the stored format is versioned and `needsRehash()` already exists, so
users can be transparently upgraded on their next successful login once an argon2
implementation is chosen.

## Decision 3 — architectural boundary checks instead of ESLint (for now)

`npm run lint:boundaries` enforces the invariants that actually protect the architecture:
`packages/core` and `packages/policy` import no I/O; vendor SDKs appear only in
`packages/providers`; SQL appears only in `packages/db`; no credential-shaped literals in
source. Stylistic linting (ESLint + Prettier) is deferred to Phase 2 and is listed as NOT
DONE, not claimed.

## Decision 4 — in-process rate limiting, configurable

`apps/api/src/middleware/rateLimit.ts` is a fixed-window limiter in process memory, with
limits supplied by configuration. It protects a single instance only; a shared store is
required once the app runs on more than one process. That depends on the production host
decision (PLAN.md, D1) and is recorded as a known limitation.

## Decision 5 — server-side sessions, not stateless JWTs

Sessions are database rows; the cookie carries a random 32-byte token and the database
stores only its SHA-256. This makes revocation real (`revoked_at`) and keeps the CSRF
token server-side for double-submit validation. It costs one indexed lookup per request.
