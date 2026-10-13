import type { DataSource } from 'typeorm';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../logger.js';
import type { RateLimitOptions } from './middleware/rate-limit.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  dataSource: DataSource;
}

export interface AppOptions {
  /** Per client IP: a single bucket behind Next.js unless TRUST_PROXY names a rewriting proxy. */
  credentialsRateLimit?: RateLimitOptions;
  accountRateLimit?: RateLimitOptions;
  generationRateLimit?: RateLimitOptions;
  answerRateLimit?: RateLimitOptions;
  maxActiveGenerations?: number;
  maxLiveJobs?: number;
  pdfRateLimit?: RateLimitOptions;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const DEFAULT_CREDENTIALS_RATE_LIMIT: RateLimitOptions = {
  limit: 100,
  windowMs: 15 * MINUTE_MS,
};

export const DEFAULT_ACCOUNT_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: 15 * MINUTE_MS };

export const DEFAULT_GENERATION_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: HOUR_MS };

export const DEFAULT_ANSWER_RATE_LIMIT: RateLimitOptions = { limit: 60, windowMs: HOUR_MS };

export const DEFAULT_PDF_RATE_LIMIT: RateLimitOptions = { limit: 30, windowMs: 10 * MINUTE_MS };
