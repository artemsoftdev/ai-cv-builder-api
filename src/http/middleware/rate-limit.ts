import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../errors.js';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/**
 * In-memory fixed-window limiter (single API process). Sets `Retry-After` and answers with the
 * contract's 429 RATE_LIMITED body. `keyGenerator` defaults to the client IP (see TRUST_PROXY).
 */
export function createRateLimiter(
  { limit, windowMs }: RateLimitOptions,
  keyGenerator?: (req: Parameters<RequestHandler>[0]) => string,
): RequestHandler {
  return rateLimit({
    limit,
    windowMs,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}
