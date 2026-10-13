const STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  CSRF_CHECK_FAILED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  VERSION_CONFLICT: 409,
  CV_BUSY: 409,
  CV_NOT_READY: 409,
  INVALID_STATE: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  UNPROCESSABLE_SOURCE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof STATUS_BY_CODE;

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

/** The message is shown to the user, so it must never contain internals. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS_BY_CODE[code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const validationError = (issues: ValidationIssue[], message = 'Invalid request') =>
  new AppError('VALIDATION_ERROR', message, { issues });

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);

export const unauthorized = () => new AppError('UNAUTHORIZED', 'Authentication required');
