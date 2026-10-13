# Architecture

```
browser ──► Next.js (web, :3000) ──rewrite /api/*──► Express API (:4000) ──► PostgreSQL
                                                         │
                                                         ├─ in-process job worker (Postgres-backed queue)
                                                         ├─ PDF text extraction in a worker thread
                                                         ├─ PDF rendering in a long-lived worker thread
                                                         └─ Anthropic API (Claude, streamed)
```

Two repositories: `ai-cv-builder-api` (this one, also owns `docker-compose.yml`) and
`ai-cv-builder-front`. `docker compose up` here builds the frontend from the sibling
directory `../ai-cv-builder-front` (override with `WEB_CONTEXT`).

## Backend modules (`src/`)

| Module | Responsibility |
|---|---|
| `config/` | zod-validated environment (see the README's configuration table); errors name variables but never echo values |
| `db/` | TypeORM `DataSource`, entities, hand-written migrations (run on startup under an advisory lock), `runSql` helper |
| `http/` | app factory, middleware (request id + pino-http, helmet, no-store, CSRF header check, auth, rate limits, zod validation, error handler) |
| `lifecycle.ts` | graceful shutdown: HTTP drain and worker hand-back in parallel, then the pool |
| `modules/auth/` | signup/login/logout/me, scrypt password hashing, session tokens and cookies |
| `modules/cvs/` | content schema and limits, ownership-scoped repository, DTO mapping, PATCH merge rules, flag/evidence pruning, user-confirmed facts, source view |
| `modules/ingestion/` | multipart upload, magic-byte check, PDF text extraction in a worker thread, source normalisation, per-user and deployment-wide capacity |
| `modules/jobs/` | Postgres job queue: enqueue, fair claim (`FOR UPDATE SKIP LOCKED`), per-claim lease + heartbeat, attempt deadline, retry with backoff, stale-lease recovery, shutdown hand-back |
| `modules/llm/` | `LlmClient` port; `AnthropicLlmClient` (streamed structured outputs) and `FakeLlmClient` (keyless demo, tests) |
| `modules/generation/` | prompts, LLM output schemas, draft sanitiser, `generate_cv` and `apply_answer` handlers, section rewrites, answer facts, retry/answer routes |
| `modules/grounding/` | deterministic verifier: corpus, normalisation, numbers, checks |
| `modules/pdf/` | A4 export with `@react-pdf/renderer` and an embedded font, rendered in a worker thread |

## Data model

- `users(id, email unique, password_hash, created_at)`; email is stored trimmed + lowercased
  (CHECK constraint), so uniqueness is case-insensitive.
- `sessions(id, user_id → users CASCADE, token_hash unique, expires_at, created_at)`
- `cvs(id, user_id → users CASCADE, title, target_role, source_type, source_filename,
  source_text, source_pdf bytea NULL, source_transcribed, status, stage, error_code,
  error_message, content jsonb NULL, review jsonb NULL, user_facts jsonb, version,
  created_at, updated_at)`
  - `source_pdf` is kept only for scanned PDFs until Claude has transcribed them, then nulled
    and `source_transcribed` set, so a retry never pays for the transcription twice.
  - `user_facts`: text the user typed or confirmed in the editor (never returned by the API).
  - `version` is a plain column, not TypeORM's `@VersionColumn`, which would also bump on
    stage updates and make the editor's version stale for no reason.
- `cv_questions(id, cv_id → cvs CASCADE, section, item_id NULL, question, answer NULL,
  status, error NULL, error_message NULL, position, created_at, updated_at)`
- `jobs(id, type 'generate_cv'|'apply_answer', cv_id → cvs CASCADE, question_id NULL,
  status 'queued'|'running'|'succeeded'|'failed', attempts, max_attempts, run_at,
  locked_by NULL, locked_until NULL, last_error NULL, created_at, updated_at, finished_at NULL)`
  - partial index on `(run_at) WHERE status IN ('queued','running')` for the claim query;
  - partial **unique** index on `(cv_id) WHERE status IN ('queued','running')`: at most one
    live job per CV. This is what makes `busy` race-free: two concurrent requests that try to
    enqueue work for the same CV cannot both succeed; the loser's unique violation becomes
    `409 CV_BUSY` after its transaction rolled back.

Entities declare every column type explicitly because decorator metadata is not emitted
(tsx and vitest use esbuild, which cannot emit it), so dev, test and prod behave the same.

## Generation flow

1. `POST /api/cvs` validates the upload and reads the source during the request, so a bad
   file fails with a 4xx at once. PDF text extraction runs in a `worker_threads` worker with a
   256 MB heap limit and a 10 s deadline (`terminate()`): pdf.js decompresses content streams
   without a size cap, and in-process a 180 KB "flate bomb" blocked the event loop for
   seconds. At most two extractions run at once.
2. In one transaction: the per-user cap (3 CVs generating; the user row is locked so two
   parallel uploads cannot both pass), the deployment-wide cap (100 live jobs), the CV row
   (`status=generating, stage=queued`) and its `generate_cv` job. Answer `202`.
3. A worker loop claims the job: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`
   over due queued jobs and running jobs whose lease expired, preferring users with fewer
   live jobs so one user's backlog cannot starve the others. The claim increments `attempts`
   and writes a lock token that is unique per claim, so a stale attempt of the same process
   cannot write once its job was reclaimed. A heartbeat extends the 2-minute lease every 30 s;
   if it finds the lease gone, the attempt is aborted.
4. `extracting` (scanned PDFs only): Claude transcribes the PDF document verbatim.
5. `drafting`: one Claude call with a structured-output schema returns the draft with
   evidence quotes per bullet and for the summary, a relevance score per experience entry
   (entries listed most recent first) and up to 8 questions.
6. `verifying`: the draft is sanitised (untrusted output: control and invisible characters
   stripped, lengths clamped at a word boundary with "…", our own ids, unsafe links dropped,
   experience sorted by relevance in bands of 10 so near-equal scores keep the model's
   chronological order) and checked by the deterministic verifier (below). The model now and
   then returns no questions at all, so structural gaps it did not ask about (missing or
   removed email, no phone or link, an entry without dates or bullets, no education or skills)
   are added as template questions in the source language (`gap-questions.ts`).
7. Content, review, questions, `status=ready`, `stage=done` and the job's `succeeded` status
   are written in **one transaction** whose first statement locks the job row and checks the
   lease.
8. Errors: transient ones (429, 5xx/overloaded, connection errors, an error event mid-stream,
   output that is not valid JSON or does not match the schema, a lost optimistic-lock race,
   an attempt past its 15-minute deadline, unknown errors) are retried after 5 s and 30 s
   (±20 % jitter), 3 attempts in total; then the CV fails with the last code. Permanent ones
   (refusal, unreadable source, missing or rejected key, a request the API rejects, output cut
   off at the token limit twice) fail the CV at once. The user can retry a failed CV.
9. Crash safety: nothing lives only in memory. A job whose lease expired is reclaimed by any
   worker; a job reclaimed after its last attempt fails as `INTERNAL` without calling Claude.
   On shutdown running jobs get 25 s, are then aborted and handed back without counting the
   attempt, while HTTP drains in parallel (open connections are cut after 10 s).

### Claude calls

- Structured outputs (`output_config.format` with a JSON schema from zod); forced tool use is
  rejected by this model family, and thinking is always on, so depth is set with `effort`.
- `messages.parse()` is not used: it parses before the caller can see `stop_reason`, so a
  refusal or a truncated answer would surface as a generic parse error. The raw message is
  checked first (`end_turn`/`stop_sequence` pass, `refusal` is `LLM_REFUSED`, `max_tokens` is
  retried once with twice the budget), then parsed with the same zod schema.
- Calls are streamed and read with `finalMessage()`. The SDK timeout then only covers the wait
  for response headers, the SDK retries once, and the worker's attempt deadline bounds the
  whole call; longer backoff belongs to the job queue, so timeouts are not multiplied.
- The system prompt and the first user block (target role + source document, identical for
  every call about one CV) carry cache breakpoints, so answer rewrites reuse the source.
- `fallbacks: "default"` (server-side refusal fallback, beta header) is on by default; only
  text after the last `fallback` block is used.

## Answer flow

`POST …/questions/:id/answer` stores the answer, marks the question `applying` and enqueues an
`apply_answer` job in one transaction (the live-job index rejects a concurrent second answer).
The job asks Claude to rewrite **only the targeted section or entry**, given the source, all
applied answers and the current section, and re-verifies only that part against a corpus of
source + answers + the user's confirmed facts:

- An answer is a fact as written. A bare "yes" (≤ 3 words, no negation) has no facts of its
  own, so it confirms the statement in its question, which then joins the corpus.
- What the user typed (changed fields, new bullets, added skills) and the targets of flags
  they dismissed are stored on PATCH (`cvs.user_facts`) and count as confirmed: a rewrite
  cannot remove an edited email or skill, and a dismissed flag does not come back.
- Ids stay stable (the entry keeps its id, unchanged bullets keep theirs, links and skill
  groups are matched by URL and name), so flags and evidence elsewhere stay valid. A contact
  field the model returned empty keeps its current value; a summary the model left out keeps
  its earlier verification.
- The result is written with `UPDATE … WHERE version = <read version>`; a mismatch retries the
  job. While a CV is `busy` the editor is read-only (`409 CV_BUSY`), which removes the race
  between manual edits and AI rewrites; PATCH checks version and busy in one statement.
- A failed answer stores its code and a user-facing message on the question.

## Keeping the AI from inventing facts

1. **Prompt contract**: the source sits in `<source_document>` and is declared data, not
   instructions (our tag names are stripped from user text so it cannot close a tag). Claude
   may rephrase, reorder and condense, must not add employers, titles, dates, numbers,
   technologies or achievements, must base the headline on a title the candidate held, must
   not compute totals such as years of experience, and turns gaps into open, non-presupposing
   questions in the source language.
2. **Evidence**: every bullet and the summary cite short quotes from the source or answers.
3. **Deterministic verification** (no LLM) against the corpus (source, answers, confirmed
   facts). Everything is compared after normalisation (NFKC, case, quotes, dashes, invisible
   characters, icon glyphs); non-English words match across inflection ("Москва"/"Москве"),
   English words across plurals.

| Part | Checked | Outcome |
|---|---|---|
| bullets, summary | at least one quote of ≥ 2 words or ≥ 12 characters occurs on word boundaries (fragments around "..." in order) **and** shares a word with the claim | flag |
| bullets, summary, education details | every number occurs in the corpus; dates count by year (03.2019 → 2019), "10K" = "10,000", "eight" = "8", "doubled" = "2"; phone numbers, emails and links never ground a number | flag |
| bullets, summary, education details | named terms: capitalised words that do not start a sentence, acronyms, tokens mixing letters with digits or `+ # . /`, and every skill the model listed, must occur (aliases such as Postgres/PostgreSQL, K8s/Kubernetes accepted) | flag |
| bullets, summary | ownership verbs (led, managed, owned, drove, mentored, руководил, возглавил, …) need their word family in the corpus; "led to" is no support | flag |
| headline, job titles | ≥ 60 % of significant words in the corpus; no seniority word (Senior, Lead, Head, Старший, …) the corpus lacks | flag |
| company, institution, degree, location, education details | ≥ 60 % of significant words in the corpus | flag |
| degree | the degree level (bachelor/BSc, master/MSc, MBA, PhD, diploma, …) must match a level in the corpus | flag |
| entry dates | numbers in the corpus | flag |
| email, phone, links | exact match (phones by digits, links without scheme/www) | **removed** |
| name, location (contact) | every word of the name / most words of the location in the corpus | **removed** |
| skills | the term occurs as a whole phrase, in compact form ("NodeJS"/"Node.js") or as an alias | **removed** |

   **What it does not catch**: a claim built only from words of the source but in a new
   combination ("built X" when the source says someone else built X); facts moved from one
   entry to another (the corpus is the whole source); invented lowercase scope ("a
   distributed system") that is neither a number, a named term nor a listed skill; a number
   that occurs anywhere in the source (it is not tied to its original context); and, for
   scanned PDFs, mistakes in Claude's own transcription, which becomes the source of truth
   (`GET /api/cvs/:id/source` shows it, marked `transcribed`).
4. **Ordering** is done by our code from Claude's relevance scores, not by trusting the array
   order.
5. **Human in the loop**: flags and removed values are shown in the editor with the reason and
   the verified quote; the user edits or dismisses them. Evidence and flags of text the user
   rewrites are dropped, so nothing they wrote is shown as "found in your source".
6. **LLM output is untrusted input**: parsed with zod, sanitised and validated with the same
   schema as manual edits, rendered as text only (React escaping; react-pdf has no HTML).

## PDF export

`GET /api/cvs/:id/pdf` renders the stored content with `@react-pdf/renderer` (no headless
browser): a single-column A4 template, real text in the embedded Inter font
(`assets/fonts`, Latin + Cyrillic + Greek), so the PDF is selectable and ATS-readable. Empty
fields, entries and sections are not printed; only http(s)/mailto links become clickable and
bare domains get `https://`. Normal words are never hyphenated (the default hyphenator applies
English rules to every language and breaks names); only tokens over 30 characters are split.

Fonts are registered per document: fontkit caches glyph objects per loaded font, and subsetting
a Cyrillic document cached composite glyphs without their code points ("М" is drawn from Latin
"M"), so later documents got a wrong ToUnicode map and, in some viewers, invisible letters.
There is no page-number footer because react-pdf 4.9 crashes on `render`-prop text in
documents of about ten pages, which the content limits allow. Exports are rate-limited per
user.

Rendering runs in one long-lived worker thread (`PdfRenderer`). In the API thread react-pdf only
yields to timers: a 300-500 ms render (several seconds on a loaded host) held back every other
request, autosaves and progress polls included, which the browser tests surfaced. The worker
is started on the first export (loading react-pdf takes about a second), renders concurrently,
has a heap limit and a 20 s deadline per export; on a timeout or crash it is terminated, the
exports in it fail with `500` and the next export starts a new worker.

## Security notes

- Passwords: `crypto.scrypt` (N=16384, r=8, p=1, 16-byte salt) in a self-describing format, so
  parameters can be raised later; constant-time compare; a dummy hash for unknown emails so
  timing does not reveal which emails exist; stored parameters are bounded so a corrupted row
  cannot cause unbounded work. N is below OWASP's current 2^17 (see the README's limitations).
- Sessions: 32 random bytes, SHA-256 stored, 30-day expiry, replaced on re-login, deleted on
  logout.
- Ownership: every CV, question and job query is scoped by `user_id`; foreign CVs return 404.
  Background jobs only act on ids that were checked when the job was enqueued.
- CSRF: `X-Requested-With` required on every non-GET request, before body parsing; no CORS.
- Rate limits (see `docs/API.md`): the Next.js rewrite passes the client's `X-Forwarded-For`
  through unchanged, so `TRUST_PROXY` defaults to `false` and the per-IP limit is a coarse
  shared cap; failed logins and signups are additionally limited per email address, which no
  header can change. Generation budgets count accepted requests only; a deployment-wide cap
  on live jobs bounds Claude spend.
- Uploads: memory storage with hard limits enforced while streaming, magic-byte check, page
  and text-length limits, parsing isolated in a worker thread.
- Untrusted text (input and LLM output): control characters, bidi and other invisible format
  characters and the Unicode tag block are stripped.
- helmet, `x-powered-by` off, `Cache-Control: no-store`, JSON body limit 1 MB.
- Logs: cookies, credentials, the API key, the PDF download name, SQL parameters and Postgres
  error details (which contain row values) are redacted; CV content is never logged.
- Docker: the API runs as the unprivileged `node` user on read-only application files; Postgres
  is not published to the host and only gets `POSTGRES_*`; the API port is bound to 127.0.0.1;
  the only secret (`ANTHROPIC_API_KEY`) comes from `.env` and never enters an image.
