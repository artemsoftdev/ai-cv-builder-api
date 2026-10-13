import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { AppError } from '../errors.js';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimiterConfig {
  key?: (req: Request) => string;
  countFailuresOnly?: boolean;
  countSuccessesOnly?: boolean;
}

/** In memory: per API process. */
export function createRateLimiter(
  { limit, windowMs }: RateLimitOptions,
  { key, countFailuresOnly = false, countSuccessesOnly = false }: RateLimiterConfig = {},
): RequestHandler {
  return rateLimit({
    limit,
    windowMs,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: key ?? ((req) => ipKeyGenerator(req.ip ?? '')),
    skipSuccessfulRequests: countFailuresOnly,
    skipFailedRequests: countSuccessesOnly,
    // Expected behind the Next.js rewrite, which passes the client's header through.
    validate: { xForwardedForHeader: false },
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}

export function emailKey(req: Request): string {
  const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() !== ''
    ? `email:${email.trim().toLowerCase().slice(0, 254)}`
    : `ip:${ipKeyGenerator(req.ip ?? '')}`;
}
