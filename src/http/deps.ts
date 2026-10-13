import type { DataSource } from 'typeorm';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../logger.js';
import type { RateLimitOptions } from './middleware/rate-limit.js';

/**
 * Process-wide dependencies handed to createApp. Extend this (rather than importing
 * singletons) when adding collaborators such as the LLM client or the job queue, so tests can
 * pass fakes.
 */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  dataSource: DataSource;
}

/** Knobs that tests override; production uses the defaults. */
export interface AppOptions {
  /** Signup + login budget per client IP. Default: 20 requests / 15 minutes. */
  credentialsRateLimit?: RateLimitOptions;
  /** CV creations + retries per user (each one costs LLM calls). Default: 10 / hour. */
  generationRateLimit?: RateLimitOptions;
  /** Answers per user. Default: 60 / hour. */
  answerRateLimit?: RateLimitOptions;
  /** CVs a user may have generating at the same time. Default: 3. */
  maxActiveGenerations?: number;
}

const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_CREDENTIALS_RATE_LIMIT: RateLimitOptions = {
  limit: 20,
  windowMs: 15 * 60 * 1000,
};

export const DEFAULT_GENERATION_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: HOUR_MS };

export const DEFAULT_ANSWER_RATE_LIMIT: RateLimitOptions = { limit: 60, windowMs: HOUR_MS };
