# ADR 0005 — Honest capability reporting

**Status:** Accepted
**Date:** 2026-09-21

## Context
The master prompt forbids fake successes. The risk is not malice but convenience: a
"temporary" stub that returns plausible data survives into a demo and then into a decision.

## Decision
1. Every external capability resolves through `packages/providers`. With no configuration,
   the resolver **throws `ProviderNotConfiguredError`** (code `NOT_CONFIGURED`, HTTP 503).
   There is no stub, no default provider and no silent fallback.
2. `GET /api/v1/system/capabilities` reports, per provider and per feature, one of
   `available` / `not_configured` / `not_implemented`, with the phase that will deliver it.
3. The web client renders that report directly, so the UI cannot show a feature as working
   when the backend has no way to perform it.
4. Test fakes may exist only under `__fakes__` directories and may never be reachable from
   a production code path.

## Consequences
- A demo of an unfinished feature is impossible without changing code that a reviewer sees.
- Users and reviewers always know what is real.
- Provider adapters must be added deliberately, phase by phase.
