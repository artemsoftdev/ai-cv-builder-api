import 'reflect-metadata';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/bootstrap.js';
import { createDataSource } from '../../src/db/data-source.js';
import { createLogger } from '../../src/logger.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** Starts a throwaway Postgres (random host port) and applies the real migrations once. */
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const databaseUrl = container.getConnectionUri();

  const dataSource = createDataSource({ url: databaseUrl, poolSize: 2 });
  await dataSource.initialize();
  try {
    await runMigrations(dataSource, createLogger('silent'));
  } finally {
    await dataSource.destroy();
  }
  project.provide('databaseUrl', databaseUrl);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
