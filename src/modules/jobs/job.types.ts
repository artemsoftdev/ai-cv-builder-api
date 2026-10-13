import type { EntityManager } from 'typeorm';
import type { JobType } from '../../db/entities/job.entity.js';
import type { JobFailure } from './job-errors.js';

/** A job this worker has claimed (status 'running', leased to it). */
export interface ClaimedJob {
  id: string;
  type: JobType;
  cvId: string;
  /** Set for apply_answer jobs only. */
  questionId: string | null;
  /** Including the current attempt. */
  attempts: number;
  maxAttempts: number;
}

/**
 * Proof of ownership. Every write a handler makes is conditional on the job still being
 * `running` and locked by this worker, so a worker whose lease was reclaimed cannot overwrite
 * the result of a newer attempt.
 */
export interface Lease {
  jobId: string;
  workerId: string;
}

export interface JobContext {
  lease: Lease;
  /** Aborted when the lease is lost or the worker is stopping; pass it to slow calls. */
  signal: AbortSignal;
  /**
   * Runs `write` in one transaction that first marks the job succeeded (lease-guarded).
   * Throws LeaseLostError, writing nothing, if this worker no longer owns the job.
   */
  complete(write: (manager: EntityManager) => Promise<void>): Promise<void>;
}

export interface JobHandler {
  /** Does the work and must finish by calling `ctx.complete()`. */
  run(job: ClaimedJob, ctx: JobContext): Promise<void>;
  /**
   * Records a final failure on the domain object (CV or question). Runs inside the transaction
   * that marks the job failed, after the lease check succeeded.
   */
  onFailed(manager: EntityManager, job: ClaimedJob, failure: JobFailure): Promise<void>;
}

export type JobHandlers = Record<JobType, JobHandler>;
