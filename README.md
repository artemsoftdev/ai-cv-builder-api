# ai-cv-builder-api

REST API for AI CV Builder: Express 5, TypeScript, TypeORM + PostgreSQL 17, zod, pino.

- REST contract: [docs/API.md](docs/API.md)
- Design (modules, data model, job queue, grounding, security): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Local development

Requirements: Node 24, npm, a PostgreSQL 17 database, Docker (for integration tests).

```bash
cp .env.example .env   # set DATABASE_URL; ANTHROPIC_API_KEY is the only secret
npm ci
npm run dev            # http://localhost:4000/api/health
```

Migrations run automatically on startup (before the port opens). Invalid configuration
fails fast with a list of the offending variables.

### LLM and background jobs

CV generation and answers run as jobs in a Postgres-backed queue, processed by a worker inside
the API process (`WORKER_ENABLED`, `WORKER_CONCURRENCY`). Nothing lives only in memory: a
restart or a crashed worker loses no work, the job's lease expires and it is picked up again.

| Variable              | Default           | Meaning                                                    |
| --------------------- | ----------------- | ---------------------------------------------------------- |
| `LLM_PROVIDER`        | `anthropic`       | `fake` drafts CVs with heuristics (keyless demo, tests)    |
| `ANTHROPIC_API_KEY`   | -                 | the only secret; without it jobs fail `LLM_NOT_CONFIGURED` |
| `ANTHROPIC_MODEL`     | `claude-opus-5-5` | model id                                                   |
| `ANTHROPIC_EFFORT`    | `medium`          | `low` / `medium` / `high` / `xhigh` / `max`                |
| `ANTHROPIC_FALLBACKS` | `true`            | server-side refusal fallback (beta header)                 |
| `FAKE_LLM_DELAY_MS`   | `1500`            | fake provider: delay per step, to watch progress in the UI |

Check the real Claude integration without a database (reads the key from `.env`):

```bash
npm run smoke:llm                                        # built-in sample source
npm run smoke:llm -- cv.pdf "Senior Backend Engineer" "I led a team of 4 engineers"
```

| Script                     | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `npm run dev`              | watch mode via tsx, loads `.env` if present                  |
| `npm run build` / `start`  | compile to `dist/` / run the compiled server                 |
| `npm run typecheck`        | `tsc --noEmit` over sources and tests                        |
| `npm run lint` / `format`  | ESLint (typescript-eslint, type-aware) / Prettier            |
| `npm test`                 | all tests                                                    |
| `npm run test:unit`        | pure unit tests, no Docker needed                            |
| `npm run test:integration` | API tests against a throwaway `postgres:17-alpine` container |
| `npm run smoke:llm`        | one live draft (+ optional answer) against the Claude API    |

Integration tests use testcontainers: one container per run on a random host port, real
migrations applied once, tables truncated before every test.

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
  modules/health/     GET /api/health
  shared/             text sanitisation for untrusted strings
scripts/              llm-smoke.ts (manual live check)
test/
  integration/    supertest suites + testcontainers global setup
  helpers/        test app, logged-in agents, row fixtures, PDF fixtures, test worker
```

Tests drive the worker deterministically (`createTestWorker(...).runOnce()` / `.drain()`) with
`FakeLlmClient`, whose methods can be overridden per test (e.g. a draft with invented facts, or
a thrown `TransientError`).
