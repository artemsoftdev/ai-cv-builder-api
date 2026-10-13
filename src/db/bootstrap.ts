import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { DataSource } from 'typeorm';
import type { Logger } from '../logger.js';

const MIGRATION_LOCK_KEY = 4_206_942;

export interface WaitOptions {
  attempts?: number;
  delayMs?: number;
  check?: (url: string) => Promise<void>;
}

async function selectOne(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function waitForDatabase(
  url: string,
  logger: Logger,
  { attempts = 30, delayMs = 1_000, check = selectOne }: WaitOptions = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await check(url);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      logger.warn(
        { attempt, err: err instanceof Error ? err.message : String(err) },
        'Database not reachable yet, retrying',
      );
      await sleep(delayMs);
    }
  }
}

/** One transaction, serialised across instances by an advisory lock. */
export async function runMigrations(dataSource: DataSource, logger: Logger): Promise<void> {
  const lockRunner = dataSource.createQueryRunner();
  await lockRunner.connect();
  try {
    await lockRunner.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    logger.info({ applied: applied.map((m) => m.name) }, 'Database migrations up to date');
  } finally {
    await lockRunner
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await lockRunner.release();
  }
}
