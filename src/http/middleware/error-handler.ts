import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, notFound, validationError } from '../errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('Route'));
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const appError = toAppError(err);
  if (appError) {
    if (appError.headers) res.set(appError.headers);
    res.status(appError.status).json(appError.toBody());
    return;
  }
  req.log.error({ err }, 'Unhandled error');
  const internal = new AppError('INTERNAL', 'Something went wrong. Please try again.');
  res.status(internal.status).json(internal.toBody());
};

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  // Bad escapes in path params ("/api/cvs/%E0%A4").
  if (err instanceof URIError) {
    return validationError([{ path: '', message: 'Malformed URL encoding' }]);
  }
  if (!isHttpError(err)) return null;
  switch (err.type) {
    case 'entity.parse.failed':
      return validationError([{ path: '', message: 'Malformed JSON body' }]);
    case 'entity.too.large':
      return new AppError('FILE_TOO_LARGE', 'Request body is too large');
    default:
      return err.status >= 400 && err.status < 500
        ? validationError([{ path: '', message: 'Malformed request' }])
        : null;
  }
}

function isHttpError(err: unknown): err is { status: number; type?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    'expose' in err
  );
}
