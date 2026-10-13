import { pino, type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from './config/config.js';

export type { Logger };

/** Paths that must never reach the logs. */
const REDACTED_PATHS = [
  // Session cookies and credentials.
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  // The PDF download name contains the CV owner's full name.
  'res.headers["content-disposition"]',
  '*.password',
  '*.passwordHash',
  // The Anthropic key, wherever a config object is logged.
  '*.apiKey',
  'llm.apiKey',
  '*.llm.apiKey',
  // QueryFailedError carries the statement's parameters, and Postgres puts row values into
  // `detail`/`where` (CV content, source text, emails). The SQL text and error code stay.
  'err.parameters',
  'err.detail',
  'err.where',
  'err.driverError',
  'err.cause.parameters',
  'err.cause.detail',
  'err.cause.where',
  'err.cause.driverError',
];

/** `destination` defaults to stdout; tests pass a stream to inspect the output. */
export function createLogger(
  level: AppConfig['logLevel'],
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level,
      base: { service: 'ai-cv-builder-api' },
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    },
    destination,
  );
}
