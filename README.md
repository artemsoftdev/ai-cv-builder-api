# ai-cv-builder-api

REST API for AI CV Builder: upload a CV (PDF or text) and a target role, get a structured CV
draft from Claude, see which claims could not be backed by your source (they are flagged, or
removed for contact data and skills), answer the questions it asks, edit by hand and export an
A4 PDF.

Express 5, TypeScript, TypeORM + PostgreSQL 17, zod, pino, Anthropic SDK, react-pdf.
The frontend lives in [ai-cv-builder-front](https://github.com/artemsoftdev/ai-cv-builder-front).

- REST contract: [docs/API.md](docs/API.md)
- Design (modules, data model, job queue, grounding, security): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Run everything with Docker

Requirements: Docker with Compose v2, and both repositories cloned side by side (this repo's
`docker-compose.yml` builds the frontend from `../ai-cv-builder-front`).

```bash
git clone https://github.com/artemsoftdev/ai-cv-builder-api.git
git clone https://github.com/artemsoftdev/ai-cv-builder-front.git
cd ai-cv-builder-api

cp .env.example .env            # put your key in ANTHROPIC_API_KEY (the only secret)
docker compose up --build
```

Open <http://localhost:3000>. The API is also published on <http://localhost:4000/api/health>
(loopback only).

All configuration lives in `.env`: the API reads it via `env_file`, Postgres gets only the
`POSTGRES_*` values and the web image only `API_INTERNAL_URL`; nothing is hardcoded in
`docker-compose.yml`.

- No key? Set `LLM_PROVIDER=fake` in `.env` for a demo in which CVs are drafted by simple
  heuristics instead of Claude (everything else is real).
- Frontend checked out elsewhere: set `WEB_CONTEXT=/path/to/ai-cv-builder-front` in `.env`.
- An `.env` created before `TRUST_PROXY` defaulted to `false` should be updated (see
  [Configuration](#configuration)).
- `docker compose down` stops the stack; `docker compose down -v` also deletes the database.

| Service | Port          | Notes                                                                    |
| ------- | ------------- | ------------------------------------------------------------------------ |
| `web`   | 3000          | Next.js; proxies `/api/*` to the API, so the browser talks to one origin |
| `api`   | `PORT` (4000) | runs migrations on start, then serves HTTP and the background job worker |
| `db`    | -             | `postgres:17-alpine`, volume `db-data`, not published to the host        |

## Local development

Requirements: Node 24, npm, a PostgreSQL 17 database, Docker (for the integration and e2e
tests).

```bash
# Any Postgres works; for example a throwaway one on port 5433:
docker run -d --name cvbuilder-pg -p 5433:5432 \
  -e POSTGRES_USER=cvbuilder -e POSTGRES_PASSWORD=cvbuilder -e POSTGRES_DB=cvbuilder \
  postgres:17-alpine

cp .env.example .env
# .env targets the compose network; point the API at the database above instead:
echo 'DATABASE_URL=postgres://cvbuilder:cvbuilder@localhost:5433/cvbuilder' > .env.local
npm ci
npm run dev            # http://localhost:4000/api/health
```

Migrations run automatically on startup, before the port opens. Invalid configuration fails
fast with a list of the offending variables (values are never printed).

Check the real Claude integration without a database (reads the key from `.env`):

```bash
npm run smoke:llm                                        # built-in sample source
npm run smoke:llm -- cv.pdf "Senior Backend Engineer" "I led a team of 4 engineers"
```

## Tests

```bash
npm run typecheck
npm run lint
npm run format:check
npm test                    # all three projects
npm run test:unit           # pure logic and PDF rendering, no Docker needed
npm run test:integration    # one module at a time against a throwaway Postgres
npm run test:e2e            # user journeys through HTTP with the worker loop running
```

| Project     | Where                               | What it covers                                                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `src/**/*.test.ts` next to the code | verifier, corpus, numbers, sanitiser, prompts, section rewrites, PATCH rules, user facts, answer facts, Claude client and error mapping (SDK mocked), PDF text extraction (including a decompression bomb), PDF rendering, config, logger redaction, shutdown sequence                                               |
| integration | `test/integration`                  | each module against real Postgres (testcontainers): auth, CVs, ingestion and generation, PDF export, and the job queue (leases, retries, fairness, deadlines, shutdown, deadlock-free deletes). The worker is driven deterministically with `runOnce()` / `drain()`                                                  |
| e2e         | `test/e2e`                          | journeys through the real app with the worker loop **running**, polling like the frontend: text → verified CV → edit → stale save → answer while busy → dismiss → PDF read back with unpdf → second device → delete; PDF, Cyrillic and scanned sources; LLM failures and retries; isolation, CSRF and sessions; 429s |

Both Postgres projects start their own throwaway `postgres:17-alpine` container on a random
host port, apply the real migrations once and truncate the tables before every test. Claude
is replaced by `FakeLlmClient`, whose methods can be overridden per test (a draft with
invented facts, a `TransientError`, a call that waits until the test lets it finish).
Shared code lives in `test/fixtures` (sample content, database rows, PDF files),
`test/helpers` (app, worker, e2e harness, PDF inspection) and `test/setup`.

## Configuration

| Variable                                              | Default           | Meaning                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | - (required)      | `postgres://` URL; in compose it must match the `POSTGRES_*` values                                                                                                                               |
| `PORT`                                                | `4000`            | HTTP port (compose publishes it on 127.0.0.1)                                                                                                                                                     |
| `ANTHROPIC_API_KEY`                                   | -                 | the only secret; without it generation jobs fail with `LLM_NOT_CONFIGURED` and `/api/health` reports `missing_key`                                                                                |
| `ANTHROPIC_MODEL`                                     | `claude-opus-5-5` | model id                                                                                                                                                                                          |
| `ANTHROPIC_EFFORT`                                    | `medium`          | `low` / `medium` / `high` / `xhigh` / `max`                                                                                                                                                       |
| `ANTHROPIC_FALLBACKS`                                 | `true`            | server-side refusal fallback (beta header)                                                                                                                                                        |
| `LLM_PROVIDER`                                        | `anthropic`       | `fake`: heuristic drafts, for a keyless demo                                                                                                                                                      |
| `FAKE_LLM_DELAY_MS`                                   | `1500`            | fake provider only: delay per step, to watch progress in the UI                                                                                                                                   |
| `WORKER_ENABLED`                                      | `true`            | run the job worker in this process                                                                                                                                                                |
| `WORKER_CONCURRENCY`                                  | `2`               | jobs processed in parallel                                                                                                                                                                        |
| `COOKIE_SECURE`                                       | `false`           | `Secure` session cookie; set `true` behind HTTPS                                                                                                                                                  |
| `TRUST_PROXY`                                         | `false`           | Express `trust proxy`. Keep `false` behind the Next.js rewrite, which passes the client's `X-Forwarded-For` through unchanged; set it to your edge proxy only if that proxy overwrites the header |
| `LOG_LEVEL`                                           | `info`            | pino level                                                                                                                                                                                        |
| `NODE_ENV`                                            | `development`     | `production` in the Docker image                                                                                                                                                                  |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | - (compose)       | passed to the `db` container only                                                                                                                                                                 |
| `WEB_CONTEXT`                                         | - (compose)       | build context of the frontend, `../ai-cv-builder-front`                                                                                                                                           |
| `API_INTERNAL_URL`                                    | - (compose)       | where the web container reaches the API, `http://api:4000` (port = `PORT`)                                                                                                                        |

## How it works (short)

- **Generation is a job, not a request.** `POST /api/cvs` validates the upload, extracts the
  PDF text in a worker thread, stores the CV and a job in one transaction and answers `202`. A
  worker inside the API process claims jobs from Postgres (`FOR UPDATE SKIP LOCKED`, per-claim
  leases and heartbeats, retries with backoff, an attempt deadline). Nothing lives only in
  memory: a page reload or an API restart loses no work, and the frontend keeps polling
  `GET /api/cvs/:id`.
- **Claude rephrases; code checks.** The draft cites evidence quotes. A deterministic verifier
  checks quotes, numbers, named terms, titles, degrees, ownership verbs, contact data and
  skills against the source, the user's answers and what the user typed; it flags or removes
  what it cannot find. Gaps become questions whose answers rewrite only the affected section.
  The exact rules, and what they miss, are in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#keeping-the-ai-from-inventing-facts).
- **PDF export** renders real, selectable text in an embedded font (Inter, Latin + Cyrillic)
  with react-pdf; see `src/modules/pdf`.

## Layout

```
src/
  config/         zod-validated environment
  db/             entities, hand-written migrations, data source, startup helpers
  http/           app factory, route composition, error model, middleware
  lifecycle.ts    graceful shutdown
  modules/auth/       scrypt passwords, session tokens/cookies, auth routes
  modules/cvs/        content schema + limits, ownership-scoped repository, PATCH rules, user facts
  modules/ingestion/  POST /api/cvs: upload, PDF text extraction (worker thread), capacity checks
  modules/jobs/       Postgres job queue (claim, lease, heartbeat, retry) and the worker
  modules/llm/        LlmClient port: Claude (streamed structured outputs) and a fake
  modules/generation/ prompts, LLM output schemas, sanitiser, job handlers, retry/answer routes
  modules/grounding/  deterministic verifier
  modules/pdf/        GET /api/cvs/:id/pdf: react-pdf template, fonts, download headers
  modules/health/     GET /api/health
  shared/             text sanitisation for untrusted strings
assets/fonts/     Inter TTFs embedded into PDFs (SIL OFL 1.1)
scripts/          llm-smoke.ts (manual live check)
test/
  integration/    module tests against Postgres
  e2e/            user journeys with the worker running
  fixtures/       sample content, database rows, PDF files
  helpers/        test app, logged-in agents, test worker, e2e harness, PDF inspection
  setup/          testcontainers global setup
```

## Trade-offs

- **Postgres as the job queue, not Redis/BullMQ.** One less service, and the job is enqueued in
  the same transaction as the CV or answer it belongs to, so there is never a CV without a job
  or a job without its CV. `FOR UPDATE SKIP LOCKED`, leases and a partial unique index (one
  live job per CV) give the guarantees needed at this scale. The cost is polling (1 s idle)
  and throughput far below a dedicated broker.
- **Worker in the API process.** One container to run and one pool; `WORKER_ENABLED=false`
  allows a separate worker process later without code changes. CPU-heavy work that could
  starve HTTP (PDF parsing) runs in a worker thread.
- **Polling, not SSE/WebSockets.** Progress lives in the database, so a reload, a second
  device or an API restart need no reconnection logic; the cost is a request every ~1.5 s
  while a CV is busy.
- **A deterministic verifier, not an LLM judge.** Every flag has a reason a user can check,
  the same draft always gets the same result, it costs nothing and cannot be talked out of a
  finding by the content it checks. It is conservative where it is cheap to be (contact data
  and skills are removed) and only flags prose. It misses claims made from the source's own
  words in a new combination; see the architecture doc for the full list.
- **Structured outputs with our own sanitiser.** The schema keeps Claude's output parseable;
  limits, ids, ordering and safety are enforced in code, because the API does not enforce
  lengths and model output is untrusted input.
- **Optimistic locking plus a busy lock**, not last-write-wins: the editor sends a version,
  conflicts are explicit (`409`), and edits are refused while the AI rewrites a section, so
  the two never overwrite each other.
- **react-pdf, not headless Chrome.** Small image, fast renders and real selectable text; the
  frontend preview is an HTML copy of the template, so page breaks can differ slightly.
- **Cut to fit the time budget**: idempotency keys for `POST /api/cvs` (a lost `202` can lead
  to a duplicate when the user resubmits), a shared rate-limit store, logging out other
  devices, inserting answer-added experience by relevance (it is appended), and an
  LLM-assisted second opinion on flags.

## Known limitations

- Rate limits are in memory: they reset on restart and assume one API process.
- Behind the Next.js rewrite the per-IP signup/login limit is one shared bucket (the client's
  `X-Forwarded-For` cannot be trusted there); the per-email limit is what stops password
  guessing. A real edge proxy that overwrites `X-Forwarded-For` would make the per-IP limit
  meaningful again.
- scrypt uses N=2^14 (16 MiB per hash), below OWASP's current 2^17 (128 MiB). The stored
  format allows raising it with rehash-on-login; 128 MiB per login was left out for a small
  single-container deployment.
- For scanned PDFs, Claude's transcription becomes the source of truth for verification; the
  user can read it at `GET /api/cvs/:id/source`, but the PDF itself is not kept.
- The verifier cannot see that a sentence recombines true facts into a false one, and numbers
  are checked against the whole source, not their original context.
- Sessions last 30 days with no idle timeout.

## AI tooling

This project was built with Claude Code (Claude Opus 5.5) as a pair programmer; every commit
after the initial one carries a `Co-Authored-By` trailer. The contract (`docs/API.md`) and the
architecture were written first and used as the spec; code followed in small commits, each with
tests.

AI-written code was not taken on trust. Before submission the code went through independent
review passes (security, reliability, grounding, API contract, UX and code quality) whose
claims were checked by running code rather than by reading it: a 180 KB PDF was measured
blocking the event loop, the Next.js rewrite proxy was shown to pass `X-Forwarded-For`
through unchanged, and the verifier was run on crafted inputs (an invented "Kubernetes" in a
bullet, a degree upgraded to "Master", a phone area code grounding "30%"). Each finding was
fixed with a regression test, deferred with a reason (see Trade-offs and Known limitations),
or rejected. Bugs these reviews caught include a stale attempt of the same process failing a
CV that a newer attempt was still generating, a deadlock between deleting a CV and its job
finishing, and an answer deleting the email the user had typed. Earlier, tests and reviews
caught a shared font cache that broke the letter "M" in PDFs rendered after a Cyrillic one,
and the PDF download name (the user's full name) leaking into response logs.
