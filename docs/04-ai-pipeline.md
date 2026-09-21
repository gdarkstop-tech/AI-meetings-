# 04 — AI Pipeline

## 1. Stages

| # | Job | Input | Output | Failure behaviour |
|---|---|---|---|---|
| 1 | `media.normalize` | uploaded file | normalized audio (mono, 16 kHz, compressed), duration, checksum | meeting → `failed`, reason `MEDIA_INVALID`, retry allowed |
| 2 | `asr.transcribe` | normalized audio + language hint | segments with timestamps + speaker labels + raw response ref | retry ×3 backoff → `failed`, reason `ASR_FAILED` |
| 3 | `transcript.clean` | segments | punctuation/merge, filler handling, **original text preserved** | never destructive: cleaned text is a separate column/version |
| 4 | `transcript.embed` | segments | embeddings | partial failure allowed; search degrades to lexical, and says so |
| 5 | `analysis.summarize` | segments (windowed) | tldr / executive / detailed, each section → segment ranges | retry, then `failed` with reason |
| 6 | `analysis.extract` | segments | decisions, action items, chapters, all with evidence | items failing evidence validation are dropped + counted |
| 7 | `followup.suggest` | artifacts | proposed emails/tasks/events (proposals only) | optional stage; never auto-executes |

Each job row records: provider, model version, prompt version, latency, cost, token/audio usage, outcome.

## 2. Language handling

- `languageHint` is passed to ASR; for `mixed`, prefer a provider that supports code-switching, and record per-segment detected language when available.
- Arabic text normalization (for search and matching): strip tatweel and diacritics, unify alef forms (أ إ آ → ا), ya/alef-maqsura (ى → ي), ta-marbuta (ة → ه) **only in the search index**, never in the displayed transcript.
- Summaries and answers are produced in the user's selected output language, independent of the meeting language (`ar` meeting → `en` summary must work).
- RTL: the UI direction follows the UI locale; a transcript segment's direction follows the segment's detected language (`dir="auto"` per segment).

## 3. Chunking for long meetings

- Window transcripts by token budget with overlap; summarize map-reduce style: per-window notes → consolidated summary.
- Every consolidated claim must trace back to at least one window's segment ids (evidence propagates through the reduce step; a claim that loses evidence is dropped).
- A 3-hour meeting must work. Test with a real long file, not a 30-second sample.

## 4. Prompt management

- Prompts live in versioned files (`packages/core/prompts/<task>/<version>.ts`), not inline strings scattered in services.
- Every artifact stores `prompt_version` + `model_version`.
- Changing a prompt = new version + re-run on the golden set before release.

## 5. Evaluation (this is what separates a product from a demo)

Build a **golden set** early — 10–20 real-ish meetings (Arabic, English, mixed; short and long; noisy and clean) with hand-written expected decisions/actions.

Measured per release:
- **ASR:** WER per language, diarization error rate, per-provider cost per audio hour, latency per audio hour.
- **Extraction:** precision/recall of decisions and action items vs. the golden set; evidence-validity rate; drop rate.
- **RAG:** answer-with-citation rate, citation correctness (does the cited segment actually support the claim), refusal correctness on unanswerable questions.
- **Cost:** USD per meeting hour, end to end.

Provider selection for Arabic ASR is decided by **this benchmark**, not by vendor marketing. Record the results in `docs/benchmarks/` with date, provider, model version, and raw numbers.

## 6. RAG design (Ask AI)

1. Resolve the user's scope (workspace, accessible meetings, date filters) — deterministic.
2. Hybrid retrieval (lexical + vector) within scope only.
3. Re-rank, take top-k with their metadata (meeting title, date, speaker, timestamp).
4. Build the prompt: system rules + question + retrieved blocks labelled as untrusted data.
5. Model returns `{ answer, citations[], sufficient: boolean }` (schema-validated).
6. Deterministic post-check: every citation id must exist and be in scope; `sufficient: false` → render "not found in your meetings" + what was searched.
7. Persist question, retrieved ids, answer, citations, model version — so any answer can be reproduced and audited.

## 7. Research pipeline

1. Model produces a **query plan** (a list of searches), not an answer.
2. Deterministic code executes searches via the configured search provider, fetches pages, stores URL + fetch time + content hash + snippet.
3. Model synthesizes findings **only from the fetched, stored content**; each finding cites `research_sources.id`.
4. Post-check drops findings without valid sources; the report shows source list with retrieval timestamps.
5. If no search provider is configured: the feature is disabled in the UI and the API returns `NOT_CONFIGURED`. **No offline "from memory" research reports.**

## 8. Known limits to state honestly in the UI
- ASR quality varies with audio quality, dialect and overlap; confidence is shown where available.
- Speaker labels are guesses until a human confirms them.
- Relative dates ("next Tuesday") are interpreted relative to the meeting date and always displayed as an interpretation the user can correct.
- The assistant answers only from meetings the user is authorized to see.
