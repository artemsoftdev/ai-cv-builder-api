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
  // TypeORM's QueryFailedError carries the statement's parameters: CV content, source text,
  // password and session-token hashes. The SQL text and the driver's error code stay.
  'err.parameters',
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
