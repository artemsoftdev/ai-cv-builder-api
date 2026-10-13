import type { DataSource } from 'typeorm';
import { createLogger } from '../../src/logger.js';
import { createJobHandlers } from '../../src/modules/generation/job-handlers.js';
import type { JobHandlers } from '../../src/modules/jobs/job.types.js';
import { JobWorker, type WorkerOptions } from '../../src/modules/jobs/worker.js';
import { FakeLlmClient } from '../../src/modules/llm/fake-llm-client.js';
import type { LlmClient } from '../../src/modules/llm/llm-client.js';

export interface TestWorkerOptions extends Partial<WorkerOptions> {
  llm?: LlmClient;
  handlers?: JobHandlers;
}

/** Driven with runOnce()/drain(); retries are immediate unless retryDelaysMs says otherwise. */
export function createTestWorker(
  dataSource: DataSource,
  { llm = new FakeLlmClient(), handlers, ...options }: TestWorkerOptions = {},
): JobWorker {
  const logger = createLogger('silent');
  return new JobWorker(
    { dataSource, logger, handlers: handlers ?? createJobHandlers({ dataSource, llm, logger }) },
    { concurrency: 1, retryDelaysMs: [0], ...options },
  );
}
