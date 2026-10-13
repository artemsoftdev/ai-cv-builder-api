# API contract

Single source of truth for the REST API shared by `ai-cv-builder-api` (Express) and
`ai-cv-builder-front` (Next.js). The frontend keeps a hand-written copy of the DTO types
in `src/lib/api/types.ts`; any change here must be mirrored there.

- Base path: every route lives under `/api`. The browser only ever talks to the Next.js
  origin; Next rewrites `/api/:path*` to `${API_INTERNAL_URL}/api/:path*`, so cookies are
  first-party and no CORS is needed.
- Content type: JSON (`application/json`) unless stated otherwise.
- Timestamps: ISO-8601 strings (UTC).
- IDs: UUID v4 strings.

## Conventions

### Authentication

Session cookie `cvb_session` (opaque random token; only its SHA-256 is stored in the DB).
`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=30 days`, `Secure` when `COOKIE_SECURE=true`.
All routes except `POST /api/auth/signup`, `POST /api/auth/login` and `GET /api/health`
require a valid session, otherwise `401 UNAUTHORIZED`.

### CSRF

Every non-GET request must carry the header `X-Requested-With: XMLHttpRequest`
(the frontend API client always sends it). Missing header -> `403 CSRF_CHECK_FAILED`.
Together with `SameSite=Lax` and the absence of CORS this blocks cross-site writes.

### Errors

Every non-2xx response has this body:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "Human readable text", "details": {} } }
```

`details` is optional. Codes used by the API:

| HTTP | code | when |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body/query/params failed validation; `details.issues` = `[{ path: string, message: string }]` |
| 401 | `UNAUTHORIZED` | no/expired session |
| 401 | `INVALID_CREDENTIALS` | wrong email or password |
| 403 | `CSRF_CHECK_FAILED` | missing `X-Requested-With` on a mutating request |
| 404 | `NOT_FOUND` | resource does not exist **or belongs to another user** (never 403, to avoid leaking existence) |
| 409 | `EMAIL_TAKEN` | signup with an existing email |
| 409 | `VERSION_CONFLICT` | PATCH with a stale `version`; `details.currentVersion: number` |
| 409 | `CV_BUSY` | a job (generation or answer) is queued/running for this CV; edits are rejected until it finishes |
| 409 | `CV_NOT_READY` | operation needs generated content (PDF export, answering) but there is none |
| 409 | `INVALID_STATE` | e.g. retry on a CV that is not `failed`, answering a question that is not `open`/`failed` |
| 413 | `FILE_TOO_LARGE` | upload > 5 MB |
| 415 | `UNSUPPORTED_FILE` | not a PDF (checked by magic bytes, not by extension) |
| 422 | `UNPROCESSABLE_SOURCE` | PDF is encrypted/corrupt/has > 10 pages, or the source text is too long/too short |
| 429 | `RATE_LIMITED` | too many requests; `Retry-After` header is set |
| 500 | `INTERNAL` | unexpected error (no internals leaked) |

## Types (DTOs)

```ts
type User = { id: string; email: string; createdAt: string };

type CvStatus = 'generating' | 'ready' | 'failed';
// Progress of the initial generation. 'extracting' only happens for scanned PDFs
// (no text layer) which Claude has to transcribe first.
type GenerationStage = 'queued' | 'extracting' | 'drafting' | 'verifying' | 'done';

type Bullet = { id: string; text: string };

type ExperienceItem = {
  id: string;
  company: string;
  title: string;
  location: string;   // '' when unknown
  startDate: string;  // free text exactly as in the source, e.g. "Mar 2021", "2019"; '' when unknown
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
  details: string;    // optional free text (honours, thesis…), '' when none
};

type SkillGroup = { id: string; name: string; items: string[] }; // name e.g. "Languages"

type CvLink = { id: string; label: string; url: string };

type CvContent = {
  contact: {
    fullName: string;
    headline: string;  // short professional title aligned with the target role
    email: string;
    phone: string;
    location: string;
    links: CvLink[];
  };
  summary: string;
  experience: ExperienceItem[]; // most relevant to the target role first
  education: EducationItem[];
  skills: SkillGroup[];
};

// Output of the grounding verifier. Lives next to content, never inside it.
type ReviewFlag = {
  id: string;
  itemId: string;   // Bullet.id | ExperienceItem.id | EducationItem.id | 'summary' | 'headline'
  reason: string;   // e.g. 'Number "40%" does not appear in your source'
};
type RemovedClaim = {
  field: string;    // e.g. 'contact.phone', 'skills'
  value: string;    // the removed value
  reason: string;
};
type CvReview = {
  flags: ReviewFlag[];                // shown as warning badges; user edits or dismisses them
  removed: RemovedClaim[];            // values the verifier dropped because they are not in the source
  evidence: Record<string, string[]>; // itemId -> verified verbatim quotes from the source
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
  error: string | null;   // set when status = 'failed'
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
  questions: CvQuestion[];     // ordered by creation
  version: number;             // optimistic-locking counter, incremented on every content change
  busy: boolean;               // true while any job for this CV is queued or running
  createdAt: string;
  updatedAt: string;
};

type CvSummary = Pick<Cv, 'id' | 'title' | 'targetRole' | 'status' | 'stage' | 'busy' | 'createdAt' | 'updatedAt'> & {
  openQuestions: number;
};
```

Generation job error codes (appear in `Cv.error.code` / `CvQuestion.error`):
`SOURCE_UNREADABLE`, `LLM_NOT_CONFIGURED`, `LLM_REFUSED`, `LLM_UNAVAILABLE`,
`LLM_INVALID_OUTPUT`, `INTERNAL`.

## Endpoints

### Health

`GET /api/health` -> `200 { "status": "ok", "db": "ok", "llm": "configured" | "missing_key" | "fake" }`
(`503` with `db: "down"` when Postgres is unreachable).

### Auth

| Method & path | Body | Success |
|---|---|---|
| `POST /api/auth/signup` | `{ email, password }` — email trimmed+lowercased, password 8–128 chars | `201 { user }` + sets cookie |
| `POST /api/auth/login` | `{ email, password }` | `200 { user }` + sets cookie |
| `POST /api/auth/logout` | — | `204`, clears cookie, deletes session |
| `GET /api/auth/me` | — | `200 { user }` |

Rate limit: 20 requests / 15 min per IP on signup+login.

### CVs

| Method & path | Request | Success |
|---|---|---|
| `GET /api/cvs` | — | `200 { items: CvSummary[] }` newest first |
| `POST /api/cvs` | `multipart/form-data`: `targetRole` (1–120 chars, required), exactly one of `text` (50–20 000 chars) or `file` (PDF ≤ 5 MB, ≤ 10 pages) | `202 { cv }` with `status: 'generating'`, `stage: 'queued'` |
| `GET /api/cvs/:id` | — | `200 { cv }` |
| `PATCH /api/cvs/:id` | `{ version: number, title?: string, content?: CvContent, dismissFlagIds?: string[] }` | `200 { cv }` (version incremented if anything changed) |
| `DELETE /api/cvs/:id` | — | `204` |
| `POST /api/cvs/:id/retry` | — | `202 { cv }`; only when `status = 'failed'` |
| `POST /api/cvs/:id/questions/:questionId/answer` | `{ answer: string }` (1–2 000 chars) | `202 { cv }`; question -> `applying`, CV -> `busy` |
| `POST /api/cvs/:id/questions/:questionId/dismiss` | — | `200 { cv }`; question -> `dismissed` |
| `GET /api/cvs/:id/pdf` | — | `200 application/pdf`, `Content-Disposition: attachment; filename="<safe-name>.pdf"` |

Notes:

- `POST /api/cvs` rate limit: 10 / hour per user; at most 3 CVs per user may be
  `generating` at the same time (`429 RATE_LIMITED` otherwise).
- Answer rate limit: 60 / hour per user.
- `PATCH` rules: rejected with `409 CV_BUSY` while `busy`; with `409 VERSION_CONFLICT` if
  `version` is stale. Content is validated with the same limits as LLM output (see below).
  The server drops review flags whose target item text changed or no longer exists, and
  flags listed in `dismissFlagIds`.
- Polling: the frontend polls `GET /api/cvs/:id` every ~1.5 s while
  `status === 'generating' || busy`, and stops otherwise. All progress is server-side, so a
  page reload simply resumes polling.
- Content limits (enforced on LLM output and on PATCH): ≤ 30 experience items, ≤ 15 bullets
  per item, ≤ 15 education items, ≤ 20 skill groups × 40 items, ≤ 10 links; strings ≤ 300
  chars except `summary` ≤ 1 500, bullet text ≤ 400, education `details` ≤ 600.
