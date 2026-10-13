import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { CvEntity, JobEntity } from '../../src/db/entities/index.js';
import { PermanentError, TransientError } from '../../src/modules/jobs/job-errors.js';
import type { JobHandlers } from '../../src/modules/jobs/job.types.js';
import { FakeLlmClient } from '../../src/modules/llm/fake-llm-client.js';
import { signedInUser, useTestApp } from '../helpers/app.js';
import { createCv, createJob } from '../helpers/fixtures.js';
import { createTestWorker } from '../helpers/worker.js';

const ctx = useTestApp();

const SOURCE = `Jane Doe
jane@example.com
Backend engineer with eight years of experience building payment systems.
Software Engineer at Acme Payments (2019 - Present)
- Built the billing service in Go`;

let userId: string;

beforeEach(async () => {
  userId = (await signedInUser(ctx.app)).user.id;
});

/** A CV waiting for generation, with its queued job. */
async function queuedGeneration() {
  const cv = await createCv(ctx.dataSource, userId, {
    status: 'generating',
    stage: 'queued',
    content: null,
    review: null,
    sourceText: SOURCE,
  });
  const job = await createJob(ctx.dataSource, cv.id);
  return { cv, job };
}

const reloadJob = (id: string) => ctx.dataSource.getRepository(JobEntity).findOneByOrFail({ id });
const reloadCv = (id: string) => ctx.dataSource.getRepository(CvEntity).findOneByOrFail({ id });

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(10);
  }
}

describe('claim and complete', () => {
  it('runs a queued job once and records the result in one transaction', async () => {
    const { cv, job } = await queuedGeneration();
    const worker = createTestWorker(ctx.dataSource);

    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);

    const finished = await reloadJob(job.id);
    expect(finished).toMatchObject({ status: 'succeeded', attempts: 1, lockedUntil: null });
    expect(finished.finishedAt).toBeInstanceOf(Date);
    expect(await reloadCv(cv.id)).toMatchObject({ status: 'ready', stage: 'done', version: 2 });
  });

  it('does not claim a job before its run_at', async () => {
    const { job } = await queuedGeneration();
    await ctx.dataSource.query(`UPDATE jobs SET run_at = now() + interval '1 hour' WHERE id = $1`, [
      job.id,
    ]);
    expect(await createTestWorker(ctx.dataSource).runOnce()).toBe(false);
  });
});

describe('failures', () => {
  it('retries a transient error after a backoff, then succeeds', async () => {
    const { cv, job } = await queuedGeneration();
    let calls = 0;
    const llm = new FakeLlmClient();
    llm.overrides.draftCv = (input) => {
      calls++;
      if (calls === 1) throw new TransientError('Anthropic overloaded');
      return new FakeLlmClient().draftCv(input);
    };
    const worker = createTestWorker(ctx.dataSource, { llm, retryDelaysMs: [60_000] });

    await worker.runOnce();
    const waiting = await reloadJob(job.id);
    expect(waiting).toMatchObject({ status: 'queued', attempts: 1, lockedBy: null });
    expect(waiting.lastError).toContain('Anthropic overloaded');
    // About a minute later (+-20% jitter), not right away.
    expect(waiting.runAt.getTime() - Date.now()).toBeGreaterThan(40_000);
    expect(await worker.runOnce()).toBe(false);
    expect((await reloadCv(cv.id)).status).toBe('generating');

    await ctx.dataSource.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
    await worker.runOnce();
    expect(await reloadJob(job.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect((await reloadCv(cv.id)).status).toBe('ready');
  });

  it('fails the CV at once on a permanent error', async () => {
    const { cv, job } = await queuedGeneration();
    const llm = new FakeLlmClient({
      overrides: {
        draftCv: () => {
          throw new PermanentError('LLM_REFUSED', 'refusal (category: cyber)');
        },
      },
    });
    await createTestWorker(ctx.dataSource, { llm }).drain();

    expect(await reloadJob(job.id)).toMatchObject({ status: 'failed', attempts: 1 });
    const failed = await reloadCv(cv.id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'LLM_REFUSED' });
    // The user sees the friendly text, never the internal description.
    expect(failed.errorMessage).toBe('The AI declined to process this source.');
  });

  it('gives up after max_attempts transient errors', async () => {
    const { cv, job } = await queuedGeneration();
    const llm = new FakeLlmClient({
      overrides: {
        draftCv: () => {
          throw new TransientError('rate limited');
        },
      },
    });
    await createTestWorker(ctx.dataSource, { llm }).drain();

    expect(llm.calls.draftCv).toBe(3);
    expect(await reloadJob(job.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await reloadCv(cv.id)).toMatchObject({
      status: 'failed',
      errorCode: 'LLM_UNAVAILABLE',
    });
  });

  it('treats an unexpected error as transient, then as INTERNAL', async () => {
    const { cv } = await queuedGeneration();
    const llm = new FakeLlmClient({
      overrides: {
        draftCv: () => {
          throw new TypeError('bug');
        },
      },
    });
    await createTestWorker(ctx.dataSource, { llm }).drain();
    expect(llm.calls.draftCv).toBe(3);
    expect(await reloadCv(cv.id)).toMatchObject({ status: 'failed', errorCode: 'INTERNAL' });
  });
});

describe('leases', () => {
  it('reclaims a running job whose lease expired (its worker died)', async () => {
    const { cv, job } = await queuedGeneration();
    await ctx.dataSource.query(
      `UPDATE jobs SET status = 'running', attempts = 1, locked_by = 'dead-worker',
              locked_until = now() - interval '1 minute' WHERE id = $1`,
      [job.id],
    );
    const worker = createTestWorker(ctx.dataSource);
    expect(await worker.runOnce()).toBe(true);
    expect(await reloadJob(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      lockedBy: worker.workerId,
    });
    expect((await reloadCv(cv.id)).status).toBe('ready');
  });

  it('leaves a running job with a valid lease alone', async () => {
    const { job } = await queuedGeneration();
    await ctx.dataSource.query(
      `UPDATE jobs SET status = 'running', attempts = 1, locked_by = 'busy-worker',
              locked_until = now() + interval '1 minute' WHERE id = $1`,
      [job.id],
    );
    expect(await createTestWorker(ctx.dataSource).runOnce()).toBe(false);
  });

  it('fails a reclaimed job that already used all its attempts', async () => {
    const { cv, job } = await queuedGeneration();
    await ctx.dataSource.query(
      `UPDATE jobs SET status = 'running', attempts = 3, locked_by = 'dead-worker',
              locked_until = now() - interval '1 minute' WHERE id = $1`,
      [job.id],
    );
    const llm = new FakeLlmClient();
    await createTestWorker(ctx.dataSource, { llm }).runOnce();
    expect(llm.calls.draftCv).toBe(0);
    expect(await reloadJob(job.id)).toMatchObject({ status: 'failed', attempts: 4 });
    expect(await reloadCv(cv.id)).toMatchObject({ status: 'failed', errorCode: 'INTERNAL' });
  });

  it('does not let a worker that lost its lease write its result', async () => {
    const { cv, job } = await queuedGeneration();
    const llm = new FakeLlmClient();
    llm.overrides.draftCv = async (input) => {
      // Meanwhile the lease expired and another worker reclaimed the job.
      await ctx.dataSource.query(
        `UPDATE jobs SET locked_by = 'other-worker', locked_until = now() + interval '2 minutes'
          WHERE id = $1`,
        [job.id],
      );
      return new FakeLlmClient().draftCv(input);
    };
    await createTestWorker(ctx.dataSource, { llm }).runOnce();

    expect(await reloadJob(job.id)).toMatchObject({
      status: 'running',
      lockedBy: 'other-worker',
      attempts: 1,
    });
    expect(await reloadCv(cv.id)).toMatchObject({ status: 'generating', content: null });
  });

  it('abandons the job as soon as a heartbeat finds the lease gone', async () => {
    const { cv, job } = await queuedGeneration();
    const llm = new FakeLlmClient({ delayMs: 30_000 });
    const worker = createTestWorker(ctx.dataSource, { llm, heartbeatMs: 20 });
    const run = worker.runOnce();
    await waitFor(async () => (await reloadJob(job.id)).status === 'running');
    await ctx.dataSource.query(`UPDATE jobs SET locked_by = 'other-worker' WHERE id = $1`, [
      job.id,
    ]);
    await run; // returns quickly: the heartbeat aborted the 30 s LLM call
    expect(await reloadJob(job.id)).toMatchObject({ status: 'running', lockedBy: 'other-worker' });
    expect((await reloadCv(cv.id)).status).toBe('generating');
  });

  it('extends the lease while the handler runs', async () => {
    const { job } = await queuedGeneration();
    const llm = new FakeLlmClient({ delayMs: 300 });
    const worker = createTestWorker(ctx.dataSource, { llm, leaseMs: 1_000, heartbeatMs: 50 });
    const run = worker.runOnce();
    await waitFor(async () => (await reloadJob(job.id)).status === 'running');
    const first = (await reloadJob(job.id)).lockedUntil!.getTime();
    await sleep(150);
    const later = (await reloadJob(job.id)).lockedUntil;
    await run;
    expect(later!.getTime()).toBeGreaterThan(first);
  });
});

describe('concurrency', () => {
  it('never hands the same job to two workers', async () => {
    const jobs = await Promise.all(Array.from({ length: 8 }, () => queuedGeneration()));
    const processed: string[] = [];
    const handlers: JobHandlers = {
      generate_cv: {
        async run(job, jobCtx) {
          processed.push(job.id);
          await sleep(15);
          await jobCtx.complete(async () => {});
        },
        async onFailed() {},
      },
      apply_answer: {
        run: () => Promise.reject(new Error('unexpected')),
        async onFailed() {},
      },
    };
    const a = createTestWorker(ctx.dataSource, { handlers, workerId: 'a' });
    const b = createTestWorker(ctx.dataSource, { handlers, workerId: 'b' });
    const [byA, byB] = await Promise.all([a.drain(), b.drain()]);

    expect(byA + byB).toBe(8);
    expect(byA).toBeGreaterThan(0);
    expect(byB).toBeGreaterThan(0);
    expect([...processed].sort()).toEqual(jobs.map(({ job }) => job.id).sort());
  });
});

describe('shutdown', () => {
  it('hands an interrupted job back to the queue without counting the attempt', async () => {
    const { cv, job } = await queuedGeneration();
    const llm = new FakeLlmClient({ delayMs: 30_000 });
    const worker = createTestWorker(ctx.dataSource, {
      llm,
      pollIntervalMs: 10,
      shutdownGraceMs: 50,
    });
    worker.start();
    await waitFor(async () => (await reloadJob(job.id)).status === 'running');
    await worker.stop();

    expect(await reloadJob(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      lockedBy: null,
    });
    expect((await reloadCv(cv.id)).status).toBe('generating');
  });

  it('lets a running job finish within the grace period', async () => {
    const { job } = await queuedGeneration();
    const llm = new FakeLlmClient({ delayMs: 100 });
    const worker = createTestWorker(ctx.dataSource, { llm, pollIntervalMs: 10 });
    worker.start();
    await waitFor(async () => (await reloadJob(job.id)).status === 'running');
    await worker.stop();
    expect((await reloadJob(job.id)).status).toBe('succeeded');
  });
});

describe('deleted CVs', () => {
  it('shrugs off a CV that was deleted while its job ran', async () => {
    const { cv, job } = await queuedGeneration();
    const llm = new FakeLlmClient();
    llm.overrides.draftCv = async (input) => {
      await ctx.dataSource.getRepository(CvEntity).delete({ id: cv.id });
      return new FakeLlmClient().draftCv(input);
    };
    await expect(createTestWorker(ctx.dataSource, { llm }).runOnce()).resolves.toBe(true);
    expect(await ctx.dataSource.getRepository(JobEntity).findOneBy({ id: job.id })).toBeNull();
  });
});
