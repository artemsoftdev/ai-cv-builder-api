import type { Express } from 'express';
import supertest from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import type { AppConfig } from '../../src/config/config.js';
import { createDataSource } from '../../src/db/data-source.js';
import { createApp } from '../../src/http/app.js';
import type { AppOptions } from '../../src/http/deps.js';
import { createLogger } from '../../src/logger.js';
import type { UserDto } from '../../src/modules/auth/auth.types.js';

export const DEFAULT_PASSWORD = 'correct horse battery staple';

export const NO_LIMIT = { limit: 10_000, windowMs: 60_000 };

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    databaseUrl: inject('databaseUrl'),
    trustProxy: 'loopback',
    cookieSecure: false,
    logLevel: 'silent',
    llm: {
      provider: 'fake',
      apiKey: undefined,
      model: 'claude-opus-5-5',
      effort: 'medium',
      fallbacks: false,
      fakeDelayMs: 0,
    },
    worker: { enabled: false, concurrency: 1 },
    ...overrides,
  };
}

export interface TestContext {
  app: Express;
  dataSource: DataSource;
}

/**
 * Registers hooks that connect to the shared test database, build the app and wipe all
 * tables before every test. Returns a context object filled in by beforeAll.
 */
export function useTestApp(
  options: AppOptions = {},
  configOverrides: Partial<AppConfig> = {},
): TestContext {
  const ctx = {} as TestContext;

  beforeAll(async () => {
    const config = testConfig(configOverrides);
    ctx.dataSource = await createDataSource({ url: config.databaseUrl, poolSize: 4 }).initialize();
    ctx.app = createApp(
      { config, logger: createLogger('silent'), dataSource: ctx.dataSource },
      {
        credentialsRateLimit: NO_LIMIT,
        accountRateLimit: NO_LIMIT,
        ...options,
      },
    );
  });

  beforeEach(async () => {
    await truncateAll(ctx.dataSource);
  });

  afterAll(async () => {
    await ctx.dataSource?.destroy();
  });

  return ctx;
}

export async function truncateAll(dataSource: DataSource): Promise<void> {
  await dataSource.query('TRUNCATE users, sessions, cvs, cv_questions, jobs CASCADE');
}

/** Agent that keeps cookies and always sends the CSRF header, like the real frontend. */
export function browser(app: Express) {
  return supertest.agent(app).set('X-Requested-With', 'XMLHttpRequest');
}

export type Browser = ReturnType<typeof browser>;

let emailCounter = 0;

export function uniqueEmail(prefix = 'user'): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@example.com`;
}

/** Signs up a fresh user and returns a logged-in agent. */
export async function signedInUser(
  app: Express,
  email = uniqueEmail(),
): Promise<{ agent: Browser; user: UserDto }> {
  const agent = browser(app);
  const res = await agent.post('/api/auth/signup').send({ email, password: DEFAULT_PASSWORD });
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { agent, user: (res.body as { user: UserDto }).user };
}
