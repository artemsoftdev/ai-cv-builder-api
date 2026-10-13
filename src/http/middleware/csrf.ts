import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every state-changing request must carry `X-Requested-With: XMLHttpRequest`. A cross-site
 * form post cannot set custom headers, and a cross-site fetch with one needs a CORS preflight
 * that this API never approves; together with SameSite=Lax cookies this blocks CSRF.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || req.get('x-requested-with') === 'XMLHttpRequest') {
    next();
    return;
  }
  next(new AppError('CSRF_CHECK_FAILED', 'Missing X-Requested-With header'));
};
