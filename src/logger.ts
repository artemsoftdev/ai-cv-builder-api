import { pino, type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from './config/config.js';

export type { Logger };

const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  // The PDF download name contains the owner's full name.
  'res.headers["content-disposition"]',
  '*.password',
  '*.passwordHash',
  '*.apiKey',
  'llm.apiKey',
  '*.llm.apiKey',
  // SQL parameters and Postgres `detail`/`where` hold row values (CV text, emails).
  'err.parameters',
  'err.detail',
  'err.where',
  'err.driverError',
  'err.cause.parameters',
  'err.cause.detail',
  'err.cause.where',
  'err.cause.driverError',
];

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
