# API contract

Single source of truth for the REST API shared by `ai-cv-builder-api` (Express) and
`ai-cv-builder-front` (Next.js). The frontend keeps a hand-written copy of the DTO types
in `src/lib/api/types.ts`; any change here must be mirrored there.

- Base path: every route lives under `/api`. The browser only ever talks to the Next.js
  origin; Next rewrites `/api/:path*` to `${API_INTERNAL_URL}/api/:path*`, so cookies are
  first-party and no CORS is needed.
- Content type: JSON (`application/json`) unless stated otherwise.
- Timestamps: ISO-8601 strings (UTC).
- Resource ids (users, CVs, questions, review flags): UUID strings. Path ids that are not UUIDs
  are rejected with `400 VALIDATION_ERROR`. Ids of items inside CV content follow their own
  rules, see [Content ids and review semantics](#content-ids-and-review-semantics).

## Conventions

### Authentication

Session cookie `cvb_session` (opaque random token; only its SHA-256 is stored in the DB).
`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=30 days`, `Secure` when `COOKIE_SECURE=true`.
All routes except `POST /api/auth/signup`, `POST /api/auth/login` and `GET /api/health`
require a valid session, otherwise `401 UNAUTHORIZED`. A `401` caused by a stale or unknown
cookie also clears the cookie (`Set-Cookie: cvb_session=; Expires=Thu, 01 Jan 1970 ...`).

### CSRF

Every request other than `GET`, `HEAD` and `OPTIONS` must carry the header
`X-Requested-With: XMLHttpRequest` (the frontend API client always sends it). Missing header
-> `403 CSRF_CHECK_FAILED`. The check runs before the body is parsed, for every route,
including multipart uploads and logout. Together with `SameSite=Lax` and the absence of CORS
this blocks cross-site writes.

### Errors

Every non-2xx response has this body:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "Human readable text", "details": {} } }
```

`details` is optional. `message` is safe to show to the user. Codes used by the API:

| HTTP | code | when |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body/params failed validation (`details.issues` = `[{ path: string, message: string }]`, at most 50); malformed JSON; malformed multipart body; a path id that is not a UUID; malformed percent-encoding in the path |
| 401 | `UNAUTHORIZED` | no, unknown or expired session |
| 401 | `INVALID_CREDENTIALS` | wrong email or password (the same response for an unknown email) |
| 403 | `CSRF_CHECK_FAILED` | missing `X-Requested-With` on a non-GET request |
| 404 | `NOT_FOUND` | resource does not exist **or belongs to another user** (never 403, to avoid leaking existence); unknown route |
| 409 | `EMAIL_TAKEN` | signup with an existing email (case-insensitive) |
| 409 | `VERSION_CONFLICT` | PATCH with a stale `version`; `details.currentVersion: number` |
| 409 | `CV_BUSY` | a job (generation or answer) is queued/running for this CV: edits and answers are rejected until it finishes |
| 409 | `CV_NOT_READY` | the operation needs generated content and the CV has none: PDF export, answering, or a PATCH that sends `content` |
| 409 | `INVALID_STATE` | retry of a CV that is not `failed`; answering or dismissing a question that is not `open`/`failed`; answering a question whose CV entry was removed (dismiss it instead) |
| 413 | `FILE_TOO_LARGE` | uploaded PDF over 5 MB, or a JSON body over 1 MB |
| 415 | `UNSUPPORTED_FILE` | not a PDF (checked by magic bytes, not by extension or content type) |
| 422 | `UNPROCESSABLE_SOURCE` | pasted text too short or too long after normalisation; PDF encrypted, damaged, over 10 pages, too complex or too slow to read, or with more than 40 000 characters of text |
| 429 | `RATE_LIMITED` | a rate limit, the per-user limit of CVs generating at once, or the deployment-wide job queue is full (see [Rate limits](#rate-limits)); `Retry-After` is always set |
| 500 | `INTERNAL` | unexpected error (no internals leaked) |

## Types (DTOs)

```ts
type User = { id: string; email: string; createdAt: string };

type CvStatus = 'generating' | 'ready' | 'failed';
// Progress of the initial generation. 'extracting' only happens for scanned PDFs
// (no text layer), which Claude has to transcribe first.
type GenerationStage = 'queued' | 'extracting' | 'drafting' | 'verifying' | 'done';

type Bullet = { id: string; text: string };

type ExperienceItem = {
  id: string;
  company: string;
  title: string;
  location: string;   // '' when unknown
  startDate: string;  // free text as in the source, e.g. "Mar 2021", "2019"; '' when unknown
  endDate: string;    // free text, e.g. "Present"; '' when unknown
  bullets: Bullet[];
};

type EducationItem = {
  id: string;
  institution: string;
  degree: string;     // e.g. "BSc Computer Science"
  location: string;
  startDate: string;
  endDate: string;
  details: string;    // optional free text (honours, thesis...), may contain line breaks; '' when none
};

type SkillGroup = { id: string; name: string; items: string[] }; // name e.g. "Languages"

type CvLink = { id: string; label: string; url: string };

type CvContent = {
  contact: {
    fullName: string;
    headline: string;  // short professional title based on a title the candidate held
    email: string;
    phone: string;
    location: string;
    links: CvLink[];
  };
  summary: string;     // may contain line breaks
  experience: ExperienceItem[]; // after generation: most relevant to the target role first
  education: EducationItem[];
  skills: SkillGroup[];
};

// Output of the grounding verifier. Lives next to content, never inside it.
type ReviewFlag = {
  id: string;       // UUID
  itemId: string;   // Bullet.id | ExperienceItem.id | EducationItem.id | 'summary' | 'headline'
  reason: string;   // e.g. 'Number "40" does not appear in your source'
};
type RemovedClaim = {
  field: 'contact.fullName' | 'contact.email' | 'contact.phone' | 'contact.location'
       | 'contact.links' | 'skills';
  value: string;    // the removed value
  reason: string;
};
type CvReview = {
  flags: ReviewFlag[];                // shown as warning badges; the user edits or dismisses them
  removed: RemovedClaim[];            // values the verifier dropped because they are not in the source
  evidence: Record<string, string[]>; // Bullet.id | 'summary' -> verified quotes from the source
};

type QuestionSection = 'contact' | 'summary' | 'experience' | 'education' | 'skills';
type QuestionStatus = 'open' | 'applying' | 'applied' | 'dismissed' | 'failed';
type CvQuestion = {
  id: string;
  section: QuestionSection;
  itemId: string | null;  // ExperienceItem.id / EducationItem.id when the question is about one entry
  question: string;
  answer: string | null;
  status: QuestionStatus;
  error: string | null;         // job error code, set when status = 'failed'
  errorMessage: string | null;  // user-facing text for `error`, set when status = 'failed'
  createdAt: string;
  updatedAt: string;
};

type Cv = {
  id: string;
  title: string;
  targetRole: string;
  sourceType: 'pdf' | 'text';
  sourceFilename: string | null;
  status: CvStatus;
  stage: GenerationStage;
  error: { code: string; message: string } | null; // set when status = 'failed'
  content: CvContent | null;   // null until the first generation succeeds
  review: CvReview | null;
  questions: CvQuestion[];     // in the order the generation produced them
  version: number;             // optimistic-locking counter, see "Content ids and review semantics"
  busy: boolean;               // true while a job for this CV is queued or running
  createdAt: string;
  updatedAt: string;
};

type CvSummary = Pick<Cv, 'id' | 'title' | 'targetRole' | 'status' | 'stage' | 'busy' | 'createdAt' | 'updatedAt'> & {
  openQuestions: number;       // questions with status 'open' or 'failed'
};

type CvSource = {
  type: 'pdf' | 'text';
  filename: string | null;
  transcribed: boolean;        // text is Claude's transcription of a scanned PDF
  text: string | null;         // normalised source text; null while a scan awaits transcription
};
```

Job error codes (in `Cv.error.code` and `CvQuestion.error`): `SOURCE_UNREADABLE`,
`LLM_NOT_CONFIGURED`, `LLM_REFUSED`, `LLM_UNAVAILABLE`, `LLM_INVALID_OUTPUT`, `INTERNAL`.
`LLM_UNAVAILABLE` and `LLM_INVALID_OUTPUT` are retried automatically (3 attempts in total)
before they are shown; the others are final at once.

### Content ids and review semantics

- Content item ids (links, experience entries, bullets, education entries, skill groups) match
  `[A-Za-z0-9_-]{1,64}`, are unique across the whole document and must not be `summary` or
  `headline` (those are reserved flag targets). The server generates UUIDs for generated
  items; the editor may use its own ids (e.g. `u_3f2a`) for items the user adds. A PATCH that
  breaks these rules gets `400 VALIDATION_ERROR`.
- `review.evidence` is keyed by `Bullet.id` and `'summary'`. When the text of a flag target or
  of an evidence key changes (or the item is removed), the server drops its flags and its
  evidence on the next PATCH: text the user wrote is never shown as "found in your source".
- `version` increments on every change of title, content or review: a PATCH that changes
  something (including only dismissing flags), a completed generation and an applied answer.
  It does not change when the stage moves, when a question is dismissed, or when an answer is
  submitted or fails. A no-op PATCH keeps the version.
- PATCH normalises strings before storing them: trimmed, control and invisible formatting
  characters removed, line breaks turned into spaces in single-line fields. Clients should
  treat the content in the response as the new base.
- Values the user types or confirms (by dismissing a flag) are remembered server-side and
  count as facts when a later answer rewrites the same part, so an answer never removes them.

## Endpoints

### Health

`GET /api/health` (public) -> `200 { "status": "ok", "db": "ok", "llm": "configured" | "missing_key" | "fake" }`,
or `503 { "status": "degraded", "db": "down", "llm": ... }` when Postgres does not answer
within 2 s.

### Auth

| Method & path | Body | Success |
|---|---|---|
| `POST /api/auth/signup` | `{ email, password }`: email trimmed + lowercased (max 254), password 8–128 chars | `201 { user }` + sets cookie |
| `POST /api/auth/login` | `{ email, password }` | `200 { user }` + sets cookie (replaces this browser's previous session) |
| `POST /api/auth/logout` | — | `204`, clears the cookie and deletes this session only |
| `GET /api/auth/me` | — | `200 { user }` |

### CVs

| Method & path | Request | Success |
|---|---|---|
| `GET /api/cvs` | — | `200 { items: CvSummary[] }` newest first |
| `POST /api/cvs` | `multipart/form-data`: `targetRole` (1–120 chars, required) and exactly one of `text` (50–20 000 chars after normalisation) or `file` (PDF ≤ 5 MB, ≤ 10 pages) | `202 { cv }` |
| `GET /api/cvs/:id` | — | `200 { cv }` |
| `GET /api/cvs/:id/source` | — | `200 { source: CvSource }` |
| `PATCH /api/cvs/:id` | `{ version: number, title?: string (1–120), content?: CvContent, dismissFlagIds?: string[] }` | `200 { cv }` |
| `DELETE /api/cvs/:id` | — | `204` (questions and jobs go with it) |
| `POST /api/cvs/:id/retry` | — | `202 { cv }`; only when `status = 'failed'` |
| `POST /api/cvs/:id/questions/:questionId/answer` | `{ answer: string }` (1–2 000 chars) | `202 { cv }`; question -> `applying`, CV -> `busy` |
| `POST /api/cvs/:id/questions/:questionId/dismiss` | — | `200 { cv }`; question -> `dismissed` |
| `GET /api/cvs/:id/pdf` | — | `200 application/pdf` (see below) |

Notes:

- `POST /api/cvs` reads the source during the request, so a bad upload fails with a 4xx at
  once; the slow part runs in a background job. The `202` body is the CV right after it was
  queued (`status: 'generating'`); poll it for progress. A PDF whose text layer has fewer than
  200 non-whitespace characters is treated as a scan and transcribed by Claude (stage
  `extracting`). Link annotations of a PDF (e.g. a "GitHub" label) are appended to the source.
- `PATCH` checks in this order: `404`, `409 CV_BUSY`, `409 VERSION_CONFLICT`,
  `409 CV_NOT_READY` (content sent for a CV without content). Content is validated with the
  same limits as LLM output (below). The title can be changed on any CV.
- Answers are facts for the AI: write them as sentences ("A team of 6; I led the on-call
  rotation"). A bare "yes" (up to three words, no negation) confirms the statement in the
  question; any other answer only stands for itself.
- `GET /api/cvs/:id/pdf` works while the CV is busy (it exports the current content) and
  answers `409 CV_NOT_READY` without content. Headers:
  `Content-Type: application/pdf`, `Cache-Control: no-store` and
  `Content-Disposition: attachment; filename="<ascii name>.pdf"; filename*=UTF-8''<utf-8 name>.pdf`.
  The name is `<fullName> - <title>` (or whichever of the two exists, or `CV`), stripped of
  characters unsafe in file names; the ASCII fallback drops accents and other non-ASCII
  characters.
- Polling: the frontend polls `GET /api/cvs/:id` every ~1.5 s while
  `status === 'generating' || busy`, and stops otherwise. All progress is server-side, so a
  page reload simply resumes polling. `GET` reads the CV, its questions and `busy` from one
  snapshot, so `busy: false` never comes with stale content.
- Content limits (enforced on LLM output and on PATCH): ≤ 30 experience items, ≤ 15 bullets
  per item, ≤ 15 education items, ≤ 20 skill groups × 40 items, ≤ 10 links; strings ≤ 300
  chars except `summary` ≤ 1 500, bullet text ≤ 400, education `details` ≤ 600. Model output
  over a limit is shortened at a word boundary and ends with "…". Links must be `http`,
  `https`, `mailto` or scheme-less.

### Rate limits

All limits are in memory (one API process). Every `429` carries `Retry-After`; responses of
the request limiters also carry `RateLimit` / `RateLimit-Policy` headers.

| Scope | Limit | Key |
|---|---|---|
| `POST /api/auth/signup` + `/login` | 100 / 15 min | client IP; behind the Next.js rewrite this is one shared bucket unless `TRUST_PROXY` names an edge proxy that overwrites `X-Forwarded-For` |
| failed signups + logins | 10 / 15 min | normalised email address |
| `POST /api/cvs` + `POST /api/cvs/:id/retry` | 10 / hour, accepted (`202`) requests only | user |
| CVs generating at once | 3 (`Retry-After: 30`) | user |
| answers | 60 / hour, accepted (`202`) requests only | user |
| queued + running jobs | 100 across all users (`Retry-After: 60`); applies to create, retry and answer | deployment |
| `GET /api/cvs/:id/pdf` | 30 / 10 min | user |
