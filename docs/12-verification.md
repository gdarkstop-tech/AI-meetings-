# 12 — Verification & Anti-Fake Protocol

The single biggest failure mode of agent-built apps is a beautiful UI over an empty backend.
This file is how you prevent that. **You verify; the agent does not grade its own homework.**

## 1. Red flags — reject the phase immediately

- A PROOF section with no actual command output, or output that looks summarized/retyped.
- Any `mock`, `sample`, `dummy`, `fake`, `TODO: replace with real` in a shipped (non-test) path.
- A feature that "works" while its provider API key is not configured.
- Transcripts/summaries that appear instantly for a 90-minute file (nothing real is that fast).
- Data that survives no restart, or disappears after redeploy (means it was in memory/disk).
- Identical wording across different meetings' summaries (a hardcoded template).
- `catch {}` blocks that swallow errors and return success.
- Tests that only assert against fakes while the agent claims end-to-end success.
- Claimed integration with no provider response id (`messageId`, event id) stored anywhere.

## 2. Checks you run yourself, per phase

**Every phase**
```bash
npm run verify                 # typecheck + lint + tests, must pass
git diff --stat HEAD~1         # did it change what it said it changed?
grep -rniE "mock|dummy|sample data|hardcoded|simulate|fake" --include=*.ts --include=*.tsx \
  apps packages | grep -v __tests__ | grep -v __fakes__
grep -rniE "sk-|api[_-]?key\s*=\s*['\"]|password\s*=\s*['\"]" apps packages | grep -v ".env.example"
```

**Phase 1** — register a user, log in, switch to Arabic (layout must flip), restart the app and
confirm you are still logged in and data persists. Run the cross-workspace isolation test and the
audit-immutability test and read their output.
```sql
select table_name from information_schema.tables where table_schema='public';
-- try to tamper: this must FAIL
update audit_log set action='x' where id = (select id from audit_log limit 1);
```

**Phase 2** — upload a 200MB+ file, kill the browser tab mid-upload, resume it. Then:
```sql
select id, title, status, duration_ms from meetings order by created_at desc limit 5;
select storage_key, bytes, checksum_sha256 from meeting_media order by created_at desc limit 5;
```
Confirm the object exists in the bucket and the checksum matches the local file.

**Phase 3** — upload a real Arabic meeting. While it processes:
```sql
select id, type, status, attempts, last_error from jobs order by created_at desc limit 10;
select count(*), min(start_ms), max(end_ms) from transcript_segments where meeting_id='...';
select provider_id, model_version, latency_ms, audio_seconds, cost_usd from provider_calls
  order by created_at desc limit 5;
```
Then: stop the worker, upload another file — the job must sit in `queued` (proving the worker is
what does the work). Restart the worker; it must pick it up.

**Phase 4** — open three different meetings and compare summaries; they must be genuinely different.
Click five random timestamps — each must land on audio that actually says that. Then:
```sql
select count(*) from decisions where cardinality(evidence_segment_ids)=0;  -- must be 0
select status, count(*) from action_items group by status;                 -- 'suggested' first
```
Ask for the eval script output (precision/recall/drop count) and read the real numbers.

**Phase 6** — search an Arabic phrase written three ways (with/without hamza and diacritics); all
must find the same segment. Ask for the `EXPLAIN ANALYZE` of the main query.

**Phase 7** — ask a question about something never discussed: it must answer "not found", not
improvise. Click every citation. Run the prompt-injection test meeting.

**Phase 9** — try to make the AI execute an action without approval (it must be impossible); replay
the same idempotency key twice (one execution); edit an approved payload (must require re-approval).

**Phases 10–11** — verify in the real test calendar/inbox, then check:
```sql
select type, status, idempotency_key, provider_response_id, approved_by from actions
  order by created_at desc limit 10;
select actor_type, action, result from audit_log order by created_at desc limit 20;
```
Also: revoke the OAuth grant from the provider's side — the app must show a clear reconnect state,
not a silent failure or a fake success.

**Phase 13** — open three source links from a research report; they must exist and support the
claim. Remove the search API key; the feature must go unavailable, not imaginary.

**Phase 15** — restore a backup into a scratch DB; delete a meeting and verify the storage object,
segments and embeddings are gone; exceed a quota and read the error.

## 3. The "unplug" test (run it at every phase)

Break one thing on purpose and watch the behaviour:

| Unplug | Correct behaviour |
|---|---|
| Wrong/removed ASR key | meeting `failed`, reason visible, retry offered — never a transcript |
| Worker stopped | jobs stay `queued`, UI shows processing + stale-worker warning |
| Database read-only | clear error with correlation id, no silent data loss |
| Search API key removed | research disabled in UI, `NOT_CONFIGURED` from API |
| OAuth revoked | reconnect prompt, no fake sends |
| LLM rate-limited | honest error + retry, never a template summary |

If any of these produces output that looks successful, the system is faking. Reject the phase.

## 4. Phase acceptance record

Keep this table in the repo and fill it as you go — it is your project memory.

| Phase | Date | Verified by | Result | Notes / outstanding |
|---|---|---|---|---|
| 0 | | | | |
| 1 | | | | |
| 2 | | | | |
| … | | | | |

## 5. Wording to use when rejecting a phase

```
Rejected. Your PROOF section does not contain real output for: <list>.
Do not continue to the next phase. Re-run the feature against real infrastructure and paste the
actual command output, SQL rows and provider response ids. If something cannot work because a key,
decision or platform capability is missing, say so explicitly in NOT DONE — that answer is
acceptable, a fabricated success is not.
```
