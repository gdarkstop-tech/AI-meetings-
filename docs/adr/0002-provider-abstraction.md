# ADR 0002 — Provider abstraction

**Status:** Accepted
**Date:** 2026-09-21

## Context
Models and vendors change fast (ASR quality for Arabic, LLM price/quality, email/calendar APIs).
Hardcoding a vendor into domain code makes the product hostage to that vendor.

## Decision
Every external capability sits behind an interface in `packages/providers`: `LLMProvider`,
`TranscriptionProvider`, `EmbeddingProvider`, `StorageProvider`, `EmailProvider`,
`CalendarProvider`, `WebSearchProvider`. Vendor SDKs may only be imported inside their adapter.
Model ids, prompts and parameters live in versioned configuration. Every adapter ships a
deterministic fake for tests, guarded so it cannot load in production. Every call records provider
id, model version, latency, usage and cost in `provider_calls`.

## Consequences
- Switching providers is a config change plus one adapter, not a refactor.
- Provider comparison (cost/quality) becomes data, not opinion.
- Slight extra indirection; adapters must be kept thin and honest — no silent fallbacks between
  providers, because a silent fallback hides failure.
