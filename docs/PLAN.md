# PLAN — after Phase 0

**Date:** 2026-09-21 · **State:** Phase 0 complete. Phase 1 **not started** and will not start
without your approval.

---

## 1. What Phase 0 changed about the plan

| Finding | Change to the plan |
|---|---|
| Repository is empty; the spec is sound | No rework needed — Phase 1 builds the foundation as specified |
| This environment is a build sandbox with no ingress and no persistence | The host decision moves **forward**, to before Phase 3 |
| `pgvector` absent locally, documented as available on Neon | Phase 1 gains a hard gate: prove `CREATE EXTENSION vector` on the real dev database |
| Arabic tatweel breaks trigram matching (measured 0.5 similarity) | Arabic normalization is promoted from a Phase 6 detail to a Phase 1 utility in `packages/core`, unit-tested from the start |
| No Docker daemon, no Redis | Confirms the DB-backed queue choice; no docker-compose dev environment — dev uses a local Postgres or a Neon branch |
| ffmpeg absent but `ffmpeg-static` verified working | Media normalization uses the npm binary; licensing to be checked before production |
| No provider credentials at all | Phases 1–2 are fully doable now; Phase 3 onwards is credential-gated |

The 15-phase order in `docs/11-phase-prompts.md` is otherwise unchanged. The Action Gateway
(Phase 9) still ships before any external integration.

---

## 2. Decisions required from you before work continues

| ID | Decision | Needed before | Recommendation |
|---|---|---|---|
| D1 | Production host (must provide an always-on worker, a stable public HTTPS URL, and persistent object storage) | **Phase 3** | Pick one and let us verify it with a throwaway deployment first. If Replit: verify Reserved VM / background worker on your actual account before we build on it |
| D2 | Database: new dedicated Neon project on a paid plan | **Phase 1** | Yes — do not reuse the existing `Sanad` project; Free-plan 0.5 GB will not hold embeddings |
| D3 | Object storage provider | **Phase 2** | Compare Cloudflare R2 vs S3 on *egress* (playback dominates) |
| D4 | First LLM provider account + key | **Phase 4** | Anthropic; Sonnet 5 default, Haiku 4.5 for bulk stages |
| D5 | ASR accounts for the benchmark (≥2 of: Deepgram, ElevenLabs, AssemblyAI, OpenAI) | **Phase 3** | Fund small trial credit on three; decide by measured WER on your audio |
| D6 | Consent + retention policy (written) | before Phase 2 reaches real users | Draft it now; it also sets `retention_days` defaults |
| D7 | 5–10 real meeting recordings (Arabic, English, mixed; incl. one ≥90 min) for the golden set | **Phase 3** | Without this, all quality claims in Phases 3–4 are unverifiable |
| D8 | Data residency requirement | **Phase 1** (region choice) | If MENA/EU residency is required, say so before the Neon project is created |
| D9 | Monthly AI budget ceiling | Phase 15 (quotas), useful earlier | Sets default quotas and model tiers |

Phase 1 can begin with **D2 and D8** answered. Everything else can follow.

---

## 3. Phase 1 — concrete deliverables

**Goal:** a foundation that is boring, secure, testable and provably multi-tenant. No meeting
features, no AI.

1. **Monorepo and toolchain** — `/apps/{web,api,worker}`, `/packages/{core,db,providers,policy}`;
   TypeScript strict; shared eslint/prettier; `npm run verify` = typecheck + lint + test + migration
   check; a lint rule or test that fails if `packages/core` imports anything with I/O.
2. **Database** — Drizzle schema and migrations for `workspaces`, `users`, `workspace_members`,
   `jobs`, `audit_log`; extensions `pg_trgm`, `unaccent`, **`vector` (gate: must succeed on the real
   dev DB, output shown)**; seed script for a dev workspace.
3. **Auth** — email + password via a vetted library, argon2/bcrypt hashing, httpOnly + Secure +
   SameSite cookies, CSRF protection on state-changing routes, rate-limited login, session
   revocation.
4. **Tenancy and RBAC** — `workspace_id` on every row; roles owner/admin/member/viewer; scope
   enforced in the repository layer; **negative test**: a user in workspace A gets 403/empty on every
   API for workspace B's data.
5. **Audit log** — `audit.write()`, hash chain (`prev_hash`/`hash`), DB-level immutability for the
   application role; **test**: `UPDATE`/`DELETE` on `audit_log` fails.
6. **Web shell** — login, workspace switcher, empty dashboard, i18n with zero hardcoded strings,
   real RTL/LTR flip, locale-aware dates, Arabic-capable font.
7. **Arabic normalization utility** in `packages/core` — tatweel, diacritics, alef/ya/ta-marbuta —
   with unit tests including the case measured in Phase 0 (`الموقع` vs `الموقـع`).
8. **Observability** — structured JSON logs with request id; secret-redaction middleware **plus a
   test asserting a known secret value never appears in log output**; `/health`, `/ready`; central
   error handler returning a correlation id and never a stack trace.
9. **CI** — GitHub Actions workflow running `npm run verify` on push and PR (the repository
   currently has zero workflows), plus dependency audit and a secret-pattern scan.

### Phase 1 Definition of Done
- `npm run verify` passes, output shown.
- Register → log in → switch language → layout flips; data survives a process restart.
- `\dx` on the dev database shows `pg_trgm`, `unaccent`, `vector`.
- Cross-workspace isolation test passes (shown).
- Audit immutability test passes (shown).
- Secret-redaction test passes (shown).
- CI is green on the branch, with a link to the run.
- `docs/12-verification.md` Phase 1 checks all pass, recorded in the phase acceptance table.

**Explicitly not in Phase 1:** meetings, uploads, recording, transcription, AI, search, integrations.

---

## 4. Provisional sequencing after Phase 1

| Phase | Gate |
|---|---|
| 2 — Meetings core, upload, recording, storage | D3 (storage provider) |
| 3 — Queue, worker, ASR + benchmark | **D1 (host), D5 (ASR accounts), D7 (audio)** |
| 4 — Analysis with evidence validation + golden-set eval | D4 (LLM key), D7 |
| 5 — Tasks | — |
| 6 — Hybrid search + timeline | D2 paid plan (embedding storage) |
| 7 — Ask AI (RAG) with citations + injection test | — |
| 8 — People and speakers | — |
| 9 — Action Gateway, policy, approvals (dry-run only) | — |
| 10 — Calendar | D1 (public HTTPS for OAuth), Google/Azure app registrations |
| 11 — Email | D1, Google restricted-scope verification started |
| 12 — Follow-ups and briefings | — |
| 13 — Research | search provider key |
| 14 — Memory | — |
| 15 — Hardening, quotas, retention, backups, security review | D6, D9 |

Phases 10–11 **cannot** be completed from this Claude Code sandbox: there is no public ingress for
OAuth callbacks. They require the host chosen in D1.

---

## 5. Working agreement for the phases ahead

- One phase per instruction; no phase starts before the previous one is approved.
- Every phase ends with: WHAT I BUILT / HOW IT WORKS / PROOF / NOT DONE / WHAT I NEED / NEXT PHASE PLAN.
- PROOF means real command output, real SQL rows, real provider response ids — never a summary or a claim.
- Unimplemented or unconfigured features fail loudly (`NOT_IMPLEMENTED` / `NOT_CONFIGURED`) and stay behind a flag.
- Everything is committed and pushed to `claude/peaceful-rubin-3dwoiq`; the build container is disposable.
- You run the checks in `docs/12-verification.md` yourself and record the result in the acceptance table.

---

## 6. Recommended next step

Answer **D2** (dedicated Neon project, paid plan) and **D8** (data residency), then approve Phase 1.
Answer **D1** (production host) in parallel — it is the only decision that can stall Phase 3, and it
is the single biggest open risk in the register.
