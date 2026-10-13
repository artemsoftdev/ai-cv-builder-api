import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cross-site forms cannot set this header; a cross-site fetch would need CORS. */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || req.get('x-requested-with') === 'XMLHttpRequest') {
    next();
    return;
  }
  next(new AppError('CSRF_CHECK_FAILED', 'Missing X-Requested-With header'));
};
