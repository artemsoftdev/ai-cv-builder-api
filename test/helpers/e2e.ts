import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect } from 'vitest';
import type { AppOptions } from '../../src/http/deps.js';
import { createLogger } from '../../src/logger.js';
import type { CvDto } from '../../src/modules/cvs/cv.types.js';
import { createJobHandlers } from '../../src/modules/generation/job-handlers.js';
import { JobWorker } from '../../src/modules/jobs/worker.js';
import { FakeLlmClient } from '../../src/modules/llm/fake-llm-client.js';
import { useTestApp, type Browser, type TestContext } from './app.js';

export interface E2eContext extends TestContext {
  llm: FakeLlmClient;
  worker: JobWorker;
}

/** The real app with its worker loop running, as in production; only Claude is faked. */
export function useE2eStack(options: AppOptions = {}): E2eContext {
  const ctx = useTestApp(options) as E2eContext;
  beforeEach(() => {
    const logger = createLogger('silent');
    ctx.llm = new FakeLlmClient();
    ctx.worker = new JobWorker(
      {
        dataSource: ctx.dataSource,
        logger,
        handlers: createJobHandlers({ dataSource: ctx.dataSource, llm: ctx.llm, logger }),
      },
      {
        concurrency: 2,
        pollIntervalMs: 20,
        heartbeatMs: 200,
        retryDelaysMs: [50],
        shutdownGraceMs: 500,
      },
    );
    ctx.worker.start();
  });
  afterEach(async () => {
    await ctx.worker.stop();
  });
  return ctx;
}

export async function getCv(agent: Browser, id: string): Promise<CvDto> {
  const res = await agent.get(`/api/cvs/${id}`);
  expect(res.status).toBe(200);
  return (res.body as { cv: CvDto }).cv;
}

/** Polls GET /api/cvs/:id like the frontend until `done` holds; also returns every stage seen. */
export async function pollCv(
  agent: Browser,
  id: string,
  done: (cv: CvDto) => boolean,
  timeoutMs = 10_000,
): Promise<{ cv: CvDto; stages: string[] }> {
  const deadline = Date.now() + timeoutMs;
  const stages: string[] = [];
  for (;;) {
    const cv = await getCv(agent, id);
    if (stages.at(-1) !== cv.stage) stages.push(cv.stage);
    if (done(cv)) return { cv, stages };
    if (Date.now() > deadline) {
      throw new Error(`CV ${id} never reached the expected state (last: ${cv.status}/${cv.stage})`);
    }
    await sleep(25);
  }
}

export const isSettled = (cv: CvDto) => cv.status !== 'generating' && !cv.busy;

/** A promise the test resolves when it wants a faked LLM call to finish. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
