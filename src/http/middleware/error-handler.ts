import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, notFound, validationError } from '../errors.js';

/** Unknown route -> 404 NOT_FOUND in the contract shape. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('Route'));
};

/**
 * Central error handler: AppErrors become their contract response; errors raised by Express'
 * body parser are mapped to client errors; everything else is logged and becomes a generic
 * 500 INTERNAL, so stack traces, SQL and driver messages never reach the client.
 */
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
  if (!isHttpError(err)) return null;
  // body-parser errors carry a `type`; see https://github.com/expressjs/body-parser#errors
  switch (err.type) {
    case 'entity.parse.failed':
      return validationError([{ path: '', message: 'Malformed JSON body' }]);
    case 'entity.too.large':
      return new AppError('FILE_TOO_LARGE', 'Request body is too large');
    default:
      // Other 4xx raised by Express internals (bad charset, aborted request...).
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
