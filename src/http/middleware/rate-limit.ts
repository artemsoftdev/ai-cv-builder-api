import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { AppError } from '../errors.js';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimiterConfig {
  /** Default: the client IP as Express sees it (see TRUST_PROXY). */
  key?: (req: Request) => string;
  /** Only requests answered with 4xx/5xx count, e.g. failed logins. */
  countFailuresOnly?: boolean;
  /** Only requests answered with 2xx/3xx count, e.g. accepted generations. */
  countSuccessesOnly?: boolean;
}

/** In-memory fixed-window limiter (single API process) answering 429 RATE_LIMITED. */
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
    // An untrusted X-Forwarded-For is expected behind the Next.js rewrite (TRUST_PROXY=false).
    validate: { xForwardedForHeader: false },
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}

/** Normalised email from a credentials body; falls back to the IP for malformed bodies. */
export function emailKey(req: Request): string {
  const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() !== ''
    ? `email:${email.trim().toLowerCase().slice(0, 254)}`
    : `ip:${ipKeyGenerator(req.ip ?? '')}`;
}
