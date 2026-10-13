import { DataSource } from 'typeorm';
import type { Logger } from '../logger.js';
import { ENTITIES } from './entities/index.js';
import { MIGRATIONS } from './migrations/index.js';

export interface DataSourceOptions {
  url: string;
  /** Max pool size; the worker (part of this process) shares the pool with HTTP handlers. */
  poolSize?: number;
  /** Receives errors of idle pooled connections (e.g. Postgres restarted). */
  logger?: Logger;
}

export function createDataSource({ url, poolSize = 10, logger }: DataSourceOptions): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTransactionMode: 'all',
    migrationsRun: false,
    synchronize: false,
    // gen_random_uuid() is core since PG 13; never try to CREATE EXTENSION (needs superuser).
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    logging: false,
    poolErrorHandler: (err: unknown) => logger?.warn({ err }, 'Postgres pool error'),
    extra: {
      max: poolSize,
      connectionTimeoutMillis: 5_000,
      // Guard rails: no query or idle transaction may hold a connection forever.
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
      application_name: 'ai-cv-builder-api',
    },
  });
}
