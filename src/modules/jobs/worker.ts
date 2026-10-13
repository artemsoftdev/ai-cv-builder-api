import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource, EntityManager } from 'typeorm';
import type { Logger } from '../../logger.js';
import {
  AttemptTimeoutError,
  describeError,
  LeaseLostError,
  PermanentError,
  toJobFailure,
  WorkerStoppingError,
} from './job-errors.js';
import { JobQueue } from './job-queue.js';
import type { ClaimedJob, JobHandlers, Lease } from './job.types.js';
import { DEFAULT_RETRY_DELAYS_MS, retryDelayMs } from './retry-policy.js';

export interface WorkerOptions {
  /** Jobs processed in parallel by this process. */
  concurrency: number;
  workerId?: string;
  /** Idle wait between polls when no job is due. */
  pollIntervalMs?: number;
  /** How long a claim stays valid without a heartbeat. */
  leaseMs?: number;
  heartbeatMs?: number;
  /** stop() waits this long for running jobs before interrupting them. */
  shutdownGraceMs?: number;
  /** An attempt still running after this is aborted and retried. */
  attemptTimeoutMs?: number;
  /** Backoff table, see retry-policy.ts. Tests pass zeros. */
  retryDelaysMs?: readonly number[];
}

export interface WorkerDeps {
  dataSource: DataSource;
  logger: Logger;
  handlers: JobHandlers;
}

/** Wait after a failed claim (e.g. database restarting) before polling again. */
const CLAIM_ERROR_BACKOFF_MS = 5_000;
/** After interrupting jobs on shutdown, how long to wait for them to hand their jobs back. */
const INTERRUPT_SETTLE_MS = 3_000;

interface RunningJob {
  jobId: string;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * In-process job worker: `concurrency` independent loops, each claiming and running one job
 * at a time. All state lives in Postgres, so a crash loses nothing: an unfinished job's lease
 * expires and any worker (this process after a restart, or another instance) reclaims it.
 */
export class JobWorker {
  readonly workerId: string;
  private readonly queue: JobQueue;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly shutdownGraceMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly running = new Map<string, RunningJob>();
  private readonly idle = new AbortController();
  private loops: Promise<void>[] = [];
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly options: WorkerOptions,
  ) {
    this.workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.queue = new JobQueue(deps.dataSource);
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseMs = options.leaseMs ?? 120_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 25_000;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 15 * 60_000;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  start(): void {
    if (this.loops.length > 0 || this.stopping) return;
    this.deps.logger.info(
      { workerId: this.workerId, concurrency: this.options.concurrency },
      'Job worker started',
    );
    for (let slot = 0; slot < this.options.concurrency; slot++) this.loops.push(this.loop());
  }

  /**
   * Stops claiming, lets running jobs finish for up to `shutdownGraceMs`, then interrupts the
   * rest; interrupted jobs go straight back to the queue for the next process.
   */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  /** Claims and processes at most one job; false when none was due. Used by tests. */
  async runOnce(): Promise<boolean> {
    const lease = { lockedBy: `${this.workerId}:${randomUUID()}` };
    const job = await this.queue.claim(lease.lockedBy, this.leaseMs);
    if (!job) return false;
    await this.process(job, { jobId: job.id, ...lease });
    return true;
  }

  /** Processes jobs until none is due (or `maxJobs` ran). Used by tests. */
  async drain(maxJobs = 1_000): Promise<number> {
    let processed = 0;
    while (processed < maxJobs && (await this.runOnce())) processed++;
    return processed;
  }

  private async shutdown(): Promise<void> {
    this.idle.abort();
    const settled = () =>
      Promise.all([...this.loops, ...[...this.running.values()].map((job) => job.done)]);
    if (await finishesWithin(settled(), this.shutdownGraceMs)) return;

    this.deps.logger.warn(
      { jobIds: [...this.running.values()].map((job) => job.jobId) },
      'Interrupting running jobs for shutdown',
    );
    for (const job of this.running.values()) job.controller.abort(new WorkerStoppingError());
    await finishesWithin(settled(), INTERRUPT_SETTLE_MS);
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (err) {
        // process() never throws, so this is the claim itself (database unavailable).
        this.deps.logger.error({ err }, 'Job worker could not claim a job');
        await this.idleWait(CLAIM_ERROR_BACKOFF_MS);
        continue;
      }
      // Busy: poll again right away. Idle: wait, with jitter so loops do not poll in lockstep.
      if (!worked) await this.idleWait(this.pollIntervalMs * (0.75 + Math.random() * 0.5));
    }
  }

  private async idleWait(ms: number): Promise<void> {
    await sleep(ms, undefined, { signal: this.idle.signal }).catch(() => undefined);
  }

  private async process(job: ClaimedJob, lease: Lease): Promise<void> {
    const controller = new AbortController();
    const done = this.execute(job, lease, controller);
    this.running.set(lease.lockedBy, { jobId: job.id, controller, done });
    try {
      await done;
    } finally {
      this.running.delete(lease.lockedBy);
    }
  }

  /** Never throws: every outcome is recorded or left to the lease expiry. */
  private async execute(job: ClaimedJob, lease: Lease, controller: AbortController): Promise<void> {
    const log = this.deps.logger.child({
      jobId: job.id,
      jobType: job.type,
      cvId: job.cvId,
      attempt: job.attempts,
    });
    const startedAt = Date.now();
    const heartbeat = setInterval(() => void this.beat(lease, controller, log), this.heartbeatMs);
    const deadline = setTimeout(
      () => controller.abort(new AttemptTimeoutError(this.attemptTimeoutMs)),
      this.attemptTimeoutMs,
    );
    try {
      if (job.attempts > job.maxAttempts) {
        // Reclaimed after its last attempt died with the worker (crash or hang): give up.
        throw new PermanentError(
          'INTERNAL',
          `Job was reclaimed after exhausting ${job.maxAttempts} attempts`,
        );
      }
      let completed = false;
      await this.deps.handlers[job.type].run(job, {
        lease,
        signal: controller.signal,
        complete: async (write) => {
          await this.complete(lease, write);
          completed = true;
        },
      });
      if (!completed) throw new Error('Job handler returned without completing the job');
      log.info({ durationMs: Date.now() - startedAt }, 'Job succeeded');
    } catch (err) {
      await this.handleError(job, lease, err, controller.signal, log);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }

  private async complete(
    lease: Lease,
    write: (manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    await this.deps.dataSource.transaction(async (manager) => {
      // First statement: verifies the lease and row-locks the job, so a reclaiming worker
      // cannot take it while this transaction writes the result.
      if (!(await this.queue.markSucceeded(manager, lease))) throw new LeaseLostError(lease.jobId);
      await write(manager);
    });
  }

  private async beat(lease: Lease, controller: AbortController, log: Logger): Promise<void> {
    try {
      const held = await this.queue.heartbeat(lease, this.leaseMs);
      if (!held && !controller.signal.aborted) {
        log.warn('Job lease lost, abandoning the job');
        controller.abort(new LeaseLostError(lease.jobId));
      }
    } catch (err) {
      // Transient database trouble: the lease is long enough to survive a few missed beats.
      log.warn({ err }, 'Job heartbeat failed');
    }
  }

  private async handleError(
    job: ClaimedJob,
    lease: Lease,
    err: unknown,
    signal: AbortSignal,
    log: Logger,
  ): Promise<void> {
    const abortReason: unknown = signal.aborted ? signal.reason : undefined;
    if (err instanceof LeaseLostError || abortReason instanceof LeaseLostError) {
      // Another worker owns the job now, or the CV (and with it the job) was deleted.
      log.warn('Job outcome discarded: lease lost or job deleted');
      return;
    }

    try {
      if (abortReason instanceof WorkerStoppingError) {
        const released = await this.queue.release(lease);
        log.info({ released }, 'Job interrupted by shutdown and handed back to the queue');
        return;
      }

      const failure = abortReason instanceof AttemptTimeoutError ? abortReason : err;
      const lastError = describeError(failure);
      if (!(failure instanceof PermanentError) && job.attempts < job.maxAttempts) {
        const delayMs = retryDelayMs(job.attempts, this.retryDelaysMs);
        const rescheduled = await this.queue.reschedule(lease, delayMs, lastError);
        log.warn({ err, delayMs, rescheduled }, 'Job attempt failed, will retry');
        return;
      }

      const outcome = toJobFailure(failure);
      const recorded = await this.deps.dataSource.transaction(async (manager) => {
        if (!(await this.queue.markFailed(manager, lease, lastError))) return false;
        await this.deps.handlers[job.type].onFailed(manager, job, outcome);
        return true;
      });
      const level = outcome.code === 'INTERNAL' ? 'error' : 'warn';
      log[level]({ err, code: outcome.code, recorded }, 'Job failed');
    } catch (writeErr) {
      // The outcome could not be stored (e.g. database down). Nothing is lost: the lease
      // expires and the job is reclaimed.
      log.error({ err: writeErr, cause: describeError(err) }, 'Could not record the job outcome');
    }
  }
}

async function finishesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timeout = new AbortController();
  const timedOut = sleep(ms, true, { signal: timeout.signal }).catch(() => false);
  try {
    return await Promise.race([promise.then(() => true), timedOut.then(() => false)]);
  } finally {
    timeout.abort();
  }
}
