# ADR 0003 — Action Gateway and suggestion-first AI

**Status:** Accepted
**Date:** 2026-09-21

## Context
The system will draft emails, schedule meetings and create work items from speech that may be
misheard, ambiguous, or deliberately manipulated (prompt injection through a transcript, an email
or a fetched web page). An LLM cannot be the thing that decides whether an action is allowed.

## Decision
1. All AI-produced artifacts enter the database as `suggested` and require a human transition to
   become real, which is audited.
2. All external side effects flow through a single Action Gateway:
   `propose → deterministic policy evaluation → human approval (default for external effects) →
   idempotent execution → append-only audit record with the provider's response id`.
3. The policy engine is deterministic TypeScript plus database rules. The model may only propose.
4. The approved payload is hashed; execution verifies the hash, so what is executed is exactly what
   was approved.

## Consequences
- Slower "magic" — the assistant proposes rather than acts. This is the intended trade-off.
- One choke point to audit, rate-limit, test and reason about.
- Integrations are cheap to add safely once the gateway exists, which is why it ships before them.
