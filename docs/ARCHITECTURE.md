# Architecture

```
browser ──► Next.js (web, :3000) ──rewrite /api/*──► Express API (:4000) ──► PostgreSQL
                                                         │
                                                         ├─ in-process job worker (Postgres-backed queue)
                                                         └─ Anthropic API (Claude)
```

Two repositories: `ai-cv-builder-api` (this one, also owns `docker-compose.yml`) and
`ai-cv-builder-front`. `docker compose up` here builds the frontend from the sibling
directory `../ai-cv-builder-front` (override with `WEB_CONTEXT`).

## Backend modules (`src/`)

| Module | Responsibility |
|---|---|
| `config/` | zod-validated env (`PORT`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `LLM_PROVIDER=anthropic\|fake`, `WORKER_ENABLED`, `WORKER_CONCURRENCY`, `COOKIE_SECURE`, `LOG_LEVEL`) |
| `db/` | TypeORM `DataSource`, entities, committed migrations (run on startup) |
| `http/` | Express app factory, middleware (request id, pino-http, helmet, CSRF header check, auth, rate limits, zod validation, error handler) |
| `modules/auth/` | signup/login/logout/me, scrypt password hashing, session tokens |
| `modules/cvs/` | CV CRUD, ownership-scoped repository, DTO mapping, PATCH merge rules |
| `modules/ingestion/` | upload validation (magic bytes, size, pages), PDF text extraction (`unpdf`), text normalisation |
| `modules/jobs/` | Postgres job queue: enqueue, claim (`FOR UPDATE SKIP LOCKED`), lease + heartbeat, retry with backoff, stale-lease recovery, graceful shutdown |
| `modules/generation/` | prompts, LLM output schemas, `generateCv` and `applyAnswer` handlers |
| `modules/grounding/` | deterministic verifier: evidence quotes, numbers, contact data, skills, entity names |
| `modules/llm/` | `LlmClient` interface; `AnthropicLlmClient` (structured outputs) and `FakeLlmClient` (tests / keyless demo) |
| `modules/pdf/` | A4 PDF rendering with `@react-pdf/renderer` and an embedded font (selectable text, Latin + Cyrillic) |

## Data model

- `users(id, email unique, password_hash, created_at)`
- `sessions(id, user_id → users ON DELETE CASCADE, token_hash unique, expires_at, created_at)`
- `cvs(id, user_id → users CASCADE, title, target_role, source_type, source_filename,
  source_text, source_pdf bytea NULL, status, stage, error_code, error_message,
  content jsonb NULL, review jsonb NULL, version int, created_at, updated_at)`
  - `source_pdf` is only kept for scanned PDFs until Claude has transcribed them, then nulled.
- `cv_questions(id, cv_id → cvs CASCADE, section, item_id NULL, question, answer NULL,
  status, error NULL, position, created_at, updated_at)`
- `jobs(id, type 'generate_cv'|'apply_answer', cv_id → cvs CASCADE, question_id NULL,
  status 'queued'|'running'|'succeeded'|'failed', attempts, max_attempts, run_at,
  locked_by NULL, locked_until NULL, last_error NULL, created_at, updated_at, finished_at NULL)`
  - partial index on `(run_at) WHERE status IN ('queued','running')`.

## Generation flow

1. `POST /api/cvs` validates input synchronously (bad PDFs fail fast with 4xx), extracts the
   text layer, inserts the CV (`status=generating, stage=queued`) and a `generate_cv` job in
   **one transaction**, returns `202`.
2. The worker claims the job (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`), sets a
   2-minute lease and extends it with a heartbeat while running.
3. `extracting` (scanned PDFs only): Claude transcribes the PDF document verbatim.
4. `drafting`: one Claude call with structured output (zod schema) produces the draft with
   per-bullet evidence quotes, relevance scores per experience item and open questions.
5. `verifying`: the deterministic grounding verifier (below) post-processes the draft.
6. Content, review, questions, `status=ready`, `stage=done` and the job's `succeeded` status
   are written in one transaction, guarded by `locked_by = <this worker>` so a worker whose
   lease expired cannot overwrite a newer attempt.
7. Errors: transient (429, 5xx/overloaded, network, timeouts) → re-queued with exponential
   backoff, up to 3 attempts; permanent (refusal, invalid output after one repair attempt,
   missing key, unreadable source) → `status=failed` with an error code; user can retry.
8. Crash safety: a job whose lease expired is re-claimed by any worker; nothing lives only in
   memory, so restarting the API or reloading the page never loses work.

## Answer flow

`POST …/questions/:id/answer` stores the answer, marks the question `applying` and enqueues an
`apply_answer` job. The job asks Claude to rewrite **only the targeted section/item** using
the source text plus all answers so far, re-runs the verifier on that part (answers are added
to the evidence corpus), and writes it with `UPDATE … WHERE version = <read version>`.
While a CV is `busy` the editor is read-only (`409 CV_BUSY`), which removes the race between
manual edits and AI rewrites.

## Keeping the AI from inventing facts

1. **Prompt contract**: the source is wrapped in `<source_document>` tags and declared
   untrusted data; Claude may rephrase/reorder/condense only, must not add employers, titles,
   dates, numbers, technologies or achievements, and must turn every gap into a question.
2. **Evidence**: every bullet and the summary must cite verbatim quotes from the source.
3. **Deterministic verification** (no LLM involved), against `source text + user answers`:
   - each evidence quote must occur in the corpus (normalised whitespace/case/punctuation);
     otherwise the bullet is flagged;
   - every number/percentage/year in generated text must occur in the corpus, otherwise flagged;
   - email, phone and URLs must occur in the corpus verbatim, otherwise removed (so are a
     name or location whose words are not in the corpus: contact fields have no flag target);
   - each skill must occur in the corpus (token match), otherwise removed;
   - company, job title, institution must occur in the corpus (fuzzy token match), otherwise flagged;
   - seniority words in titles ("Senior", "Lead") and ownership verbs in bullets/summary
     ("led", "managed", ...) must be backed by the same word family in the corpus, otherwise flagged.
4. **Ordering** is done by our code from Claude's `relevance` score, not by trusting the order
   of the array.
5. **Human in the loop**: flags and removed items are shown in the editor with the reason and the
   supporting quote, the user decides.
6. **LLM output is untrusted input**: parsed with zod (lengths, counts), stripped of control
   characters, rendered as text only (React escaping; react-pdf has no HTML).

## PDF export

`GET /api/cvs/:id/pdf` renders the stored content with `@react-pdf/renderer` in the API process
(no headless browser): a single-column A4 template, real text in the embedded Inter font
(`assets/fonts`, Latin + Cyrillic + Greek), so the PDF is selectable and ATS-readable. Empty
fields, entries and sections are not printed; only http(s)/mailto links become clickable.
Fonts are registered per document: fontkit caches glyphs per loaded font, and sharing one
instance corrupted glyphs in PDFs rendered after a Cyrillic one. A typical CV renders in
~50 ms; the largest one the content limits allow (~50 pages) takes a few seconds of CPU, but
react-pdf yields to the event loop as it goes (longest stall measured: ~40 ms), so other
requests and job heartbeats keep flowing. Exports are rate-limited per user (30 / 10 min).

## Security notes

- Passwords: `crypto.scrypt` (N=16384, r=8, p=1, 16-byte salt), constant-time compare, dummy
  hash on unknown email to equalise timing.
- Sessions: 32 random bytes, SHA-256 stored, 30-day expiry, deleted on logout.
- Ownership: every CV query is scoped by `user_id`; foreign CVs return 404.
- Upload: memory storage with hard limits, magic-byte check, page limit, parse timeout.
- helmet, `x-powered-by` off, JSON body limit 1 MB, rate limits on auth, creation, answers and
  PDF export.
- Logs: cookies, credentials, the API key and SQL parameters are redacted; CV content is never
  logged (only ids, counts, token usage and durations).
- Docker: the API runs as the unprivileged `node` user on read-only application files; Postgres
  is not published to the host; the only secret (`ANTHROPIC_API_KEY`) comes from the
  environment and never enters the image.
