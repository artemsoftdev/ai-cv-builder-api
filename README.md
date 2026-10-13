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

| Script                     | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `npm run dev`              | watch mode via tsx, loads `.env` if present                  |
| `npm run build` / `start`  | compile to `dist/` / run the compiled server                 |
| `npm run typecheck`        | `tsc --noEmit` over sources and tests                        |
| `npm run lint` / `format`  | ESLint (typescript-eslint, type-aware) / Prettier            |
| `npm test`                 | all tests                                                    |
| `npm run test:unit`        | pure unit tests, no Docker needed                            |
| `npm run test:integration` | API tests against a throwaway `postgres:17-alpine` container |

Integration tests use testcontainers: one container per run on a random host port, real
migrations applied once, tables truncated before every test.

## Layout

```
src/
  config/         zod-validated environment
  db/             entities, hand-written migrations, data source, startup helpers
  http/           app factory, route composition, error model, middleware
  modules/auth/   scrypt passwords, session tokens/cookies, auth routes
  modules/cvs/    content schema + limits, ownership-scoped repository, PATCH rules, routes
  modules/health/ GET /api/health
  shared/         text sanitisation for untrusted strings
test/
  integration/    supertest suites + testcontainers global setup
  helpers/        test app, logged-in agents, row fixtures
```
