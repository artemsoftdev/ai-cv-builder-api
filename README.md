# ai-cv-builder-api

REST API for AI CV Builder: upload a CV (PDF or text) and a target role, get a structured CV
draft from Claude that is checked against the source so it cannot invent facts, answer the
questions it asks, edit by hand and export an A4 PDF.

Express 5, TypeScript, TypeORM + PostgreSQL 17, zod, pino, Anthropic SDK, react-pdf.
The frontend lives in [ai-cv-builder-front](https://github.com/artemsoftdev/ai-cv-builder-front).

- REST contract: [docs/API.md](docs/API.md)
- Design (modules, data model, job queue, grounding, security): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Run everything with Docker

Requirements: Docker with Compose v2, and both repositories cloned side by side (this repo's
`docker-compose.yml` builds the frontend from `../ai-cv-builder-front`).

```bash
git clone git@github.com:artemsoftdev/ai-cv-builder-api.git
git clone git@github.com:artemsoftdev/ai-cv-builder-front.git
cd ai-cv-builder-api

cp .env.example .env            # put your key in ANTHROPIC_API_KEY (the only secret)
docker compose up --build
```

Open <http://localhost:3000>. The API is also published on <http://localhost:4000/api/health>
(loopback only).

All configuration lives in `.env` (services read it via `env_file`; nothing is hardcoded in
`docker-compose.yml`).

- No key? Set `LLM_PROVIDER=fake` in `.env` for a demo in which CVs are drafted by simple
  heuristics instead of Claude (everything else is real).
- Frontend checked out elsewhere: set `WEB_CONTEXT=/path/to/ai-cv-builder-front` in `.env`.
- `docker compose down` stops the stack; `docker compose down -v` also deletes the database.

| Service | Port | Notes                                                                    |
| ------- | ---- | ------------------------------------------------------------------------ |
| `web`   | 3000 | Next.js; proxies `/api/*` to the API, so the browser talks to one origin |
| `api`   | 4000 | runs migrations on start, then serves HTTP and the background job worker |
| `db`    | -    | `postgres:17-alpine`, volume `db-data`, not published to the host        |

## Local development

Requirements: Node 24, npm, a PostgreSQL 17 database, Docker (for the integration tests).

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
npm test                    # everything
npm run test:unit           # pure unit tests (incl. PDF rendering), no Docker needed
npm run test:integration    # API tests against a throwaway postgres:17-alpine container
```

Integration tests use testcontainers: one container per run on a random host port, the real
migrations applied once, tables truncated before every test. They drive the job worker
deterministically (`createTestWorker(...).runOnce()` / `.drain()`) with `FakeLlmClient`, whose
methods can be overridden per test (a draft with invented facts, a `TransientError`, ...).

## Configuration

| Variable              | Default                            | Meaning                                                               |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`        | - (required)                       | `postgres://` URL                                                     |
| `PORT`                | `4000`                             | HTTP port                                                             |
| `ANTHROPIC_API_KEY`   | -                                  | the only secret; without it generation jobs fail `LLM_NOT_CONFIGURED` |
| `ANTHROPIC_MODEL`     | `claude-opus-5-5`                  | model id                                                              |
| `ANTHROPIC_EFFORT`    | `medium`                           | `low` / `medium` / `high` / `xhigh` / `max`                           |
| `ANTHROPIC_FALLBACKS` | `true`                             | server-side refusal fallback (beta header)                            |
| `LLM_PROVIDER`        | `anthropic`                        | `fake`: heuristic drafts, for a keyless demo and tests                |
| `FAKE_LLM_DELAY_MS`   | `1500`                             | fake provider only: delay per step, to watch progress in the UI       |
| `WORKER_ENABLED`      | `true`                             | run the job worker in this process                                    |
| `WORKER_CONCURRENCY`  | `2`                                | jobs processed in parallel                                            |
| `COOKIE_SECURE`       | `false`                            | `Secure` session cookie; set `true` behind HTTPS                      |
| `TRUST_PROXY`         | `loopback, linklocal, uniquelocal` | Express `trust proxy` (client IP for rate limits behind Next.js)      |
| `LOG_LEVEL`           | `info`                             | pino level                                                            |
| `NODE_ENV`            | `development`                      | `production` in the Docker image                                      |

## How it works (short)

- **Generation is a job, not a request.** `POST /api/cvs` validates the upload, extracts the
  PDF text, stores the CV and a job in one transaction and answers `202`. A worker inside the
  API process claims jobs from Postgres (`FOR UPDATE SKIP LOCKED`, leases and heartbeats,
  retries with backoff). Nothing lives only in memory: a page reload or an API restart loses
  no work, and the frontend simply keeps polling `GET /api/cvs/:id`.
- **Claude may rephrase, never invent.** The draft cites evidence quotes from the source; a
  deterministic verifier checks quotes, numbers, names, seniority and ownership verbs against
  the source plus the user's answers, flags or removes what it cannot find, and gaps become
  questions whose answers rewrite only the affected section.
- **PDF export** renders real, selectable text in an embedded font (Inter, Latin + Cyrillic)
  with react-pdf; see `src/modules/pdf`.

## Layout

```
src/
  config/         zod-validated environment
  db/             entities, hand-written migrations, data source, startup helpers
  http/           app factory, route composition, error model, middleware
  modules/auth/       scrypt passwords, session tokens/cookies, auth routes
  modules/cvs/        content schema + limits, ownership-scoped repository, PATCH rules, routes
  modules/ingestion/  POST /api/cvs: multipart upload, PDF text extraction, source normalisation
  modules/jobs/       Postgres job queue (claim, lease, heartbeat, retry) and the worker
  modules/llm/        LlmClient port: Claude (structured outputs) and a fake for demo/tests
  modules/generation/ prompts, LLM output schemas, sanitiser, job handlers, retry/answer routes
  modules/grounding/  deterministic verifier: evidence quotes, numbers, contact data, skills
  modules/pdf/        GET /api/cvs/:id/pdf: react-pdf template, fonts, download headers
  modules/health/     GET /api/health
  shared/             text sanitisation for untrusted strings
assets/fonts/     Inter TTFs embedded into PDFs (SIL OFL 1.1)
scripts/          llm-smoke.ts (manual live check)
test/
  integration/    supertest suites + testcontainers global setup
  helpers/        test app, logged-in agents, row fixtures, PDF fixtures, test worker
```

## Trade-offs and AI tooling

_To be written._
