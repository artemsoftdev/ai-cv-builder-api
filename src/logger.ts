import { pino, type Logger } from 'pino';
import type { AppConfig } from './config/config.js';

export type { Logger };

/** Paths that must never reach the logs (session cookies, credentials). */
const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.apiKey',
];

export function createLogger(level: AppConfig['logLevel']): Logger {
  return pino({
    level,
    base: { service: 'ai-cv-builder-api' },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  });
}
