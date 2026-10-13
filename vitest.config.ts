import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

// Each project gets its own throwaway Postgres; its files share it and truncate between tests.
const withPostgres = (name: string, timeoutMs: number): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name,
    include: [`test/${name}/**/*.test.ts`],
    environment: 'node',
    globalSetup: ['test/setup/postgres.ts'],
    setupFiles: ['test/setup/reflect-metadata.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: timeoutMs,
  },
});

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'node',
          testTimeout: 15_000,
        },
      },
      withPostgres('integration', 30_000),
      withPostgres('e2e', 60_000),
    ],
  },
});
