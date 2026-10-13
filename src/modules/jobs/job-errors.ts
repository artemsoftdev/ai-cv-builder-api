/*
 * Error taxonomy for background jobs. Handlers (and the LLM layer they call) throw:
 *   - TransientError: worth retrying later (rate limit, overload, network, lost race);
 *   - PermanentError: retrying cannot help (refusal, unreadable source, missing API key).
 * Any other error is treated as transient until the attempts run out, then as INTERNAL.
 */

/** Codes stored in `cvs.error_code` / `cv_questions.error` (see docs/API.md). */
export const JOB_ERROR_CODES = [
  'SOURCE_UNREADABLE',
  'LLM_NOT_CONFIGURED',
  'LLM_REFUSED',
  'LLM_UNAVAILABLE',
  'LLM_INVALID_OUTPUT',
  'INTERNAL',
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** Default user-facing text per code. Never contains internals. */
export const JOB_ERROR_MESSAGES: Record<JobErrorCode, string> = {
  SOURCE_UNREADABLE:
    "We couldn't read any text from your source. Try a different PDF or paste the text instead.",
  LLM_NOT_CONFIGURED: 'AI generation is not configured on the server.',
  LLM_REFUSED: 'The AI declined to process this source.',
  LLM_UNAVAILABLE: 'The AI service is unavailable right now. Please try again in a few minutes.',
  LLM_INVALID_OUTPUT: 'The AI produced an unusable result. Retrying usually helps.',
  INTERNAL: 'Something went wrong while processing your CV. Please try again.',
};

export class TransientError extends Error {
  constructor(
    message: string,
    /** Reported to the user if the job runs out of attempts. */
    readonly code: JobErrorCode = 'LLM_UNAVAILABLE',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TransientError';
  }
}

export class PermanentError extends Error {
  readonly userMessage: string;

  constructor(
    readonly code: JobErrorCode,
    /** Internal description for logs and `jobs.last_error`. */
    message: string,
    options?: ErrorOptions & { userMessage?: string },
  ) {
    super(message, options);
    this.name = 'PermanentError';
    this.userMessage = options?.userMessage ?? JOB_ERROR_MESSAGES[code];
  }
}

/** The worker no longer owns the job (lease expired and was reclaimed, or the CV was deleted). */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`Lost the lease on job ${jobId}`);
    this.name = 'LeaseLostError';
  }
}

/** Abort reason when an attempt runs past its deadline; retried like any transient error. */
export class AttemptTimeoutError extends TransientError {
  constructor(timeoutMs: number) {
    super(`Attempt exceeded ${timeoutMs} ms`, 'LLM_UNAVAILABLE');
    this.name = 'AttemptTimeoutError';
  }
}

/** Abort reason used when the worker shuts down while a handler is still running. */
export class WorkerStoppingError extends Error {
  constructor() {
    super('Worker is shutting down');
    this.name = 'WorkerStoppingError';
  }
}

/** What a failed job reports to its CV / question. */
export interface JobFailure {
  code: JobErrorCode;
  userMessage: string;
}

/** Final failure for an error that will not be retried (any more). */
export function toJobFailure(err: unknown): JobFailure {
  if (err instanceof PermanentError) return { code: err.code, userMessage: err.userMessage };
  if (err instanceof TransientError) {
    return { code: err.code, userMessage: JOB_ERROR_MESSAGES[err.code] };
  }
  return { code: 'INTERNAL', userMessage: JOB_ERROR_MESSAGES.INTERNAL };
}

/** Bounded, single-line description for `jobs.last_error` (internal, never sent to clients). */
export function describeError(err: unknown): string {
  const text =
    err instanceof Error ? `${err.name}: ${err.message}` : `Non-error thrown: ${String(err)}`;
  return text.replace(/\s+/g, ' ').slice(0, 1_000);
}
