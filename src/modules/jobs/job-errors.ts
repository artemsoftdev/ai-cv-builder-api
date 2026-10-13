// Unknown errors are retried like TransientError, then reported as INTERNAL.

export const JOB_ERROR_CODES = [
  'SOURCE_UNREADABLE',
  'LLM_NOT_CONFIGURED',
  'LLM_REFUSED',
  'LLM_UNAVAILABLE',
  'LLM_INVALID_OUTPUT',
  'INTERNAL',
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

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
    /** Internal: logs and jobs.last_error only. */
    message: string,
    options?: ErrorOptions & { userMessage?: string },
  ) {
    super(message, options);
    this.name = 'PermanentError';
    this.userMessage = options?.userMessage ?? JOB_ERROR_MESSAGES[code];
  }
}

export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`Lost the lease on job ${jobId}`);
    this.name = 'LeaseLostError';
  }
}

export class AttemptTimeoutError extends TransientError {
  constructor(timeoutMs: number) {
    super(`Attempt exceeded ${timeoutMs} ms`, 'LLM_UNAVAILABLE');
    this.name = 'AttemptTimeoutError';
  }
}

export class WorkerStoppingError extends Error {
  constructor() {
    super('Worker is shutting down');
    this.name = 'WorkerStoppingError';
  }
}

export interface JobFailure {
  code: JobErrorCode;
  userMessage: string;
}

export function toJobFailure(err: unknown): JobFailure {
  if (err instanceof PermanentError) return { code: err.code, userMessage: err.userMessage };
  if (err instanceof TransientError) {
    return { code: err.code, userMessage: JOB_ERROR_MESSAGES[err.code] };
  }
  return { code: 'INTERNAL', userMessage: JOB_ERROR_MESSAGES.INTERNAL };
}

export function describeError(err: unknown): string {
  const text =
    err instanceof Error ? `${err.name}: ${err.message}` : `Non-error thrown: ${String(err)}`;
  return text.replace(/\s+/g, ' ').slice(0, 1_000);
}
