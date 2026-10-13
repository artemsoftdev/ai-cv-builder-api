import type { EntityManager } from 'typeorm';
import type { JobType } from '../../db/entities/job.entity.js';
import type { JobFailure } from './job-errors.js';

export interface ClaimedJob {
  id: string;
  type: JobType;
  cvId: string;
  questionId: string | null;
  attempts: number;
  maxAttempts: number;
}

/** `lockedBy` is unique per claim, so a reclaimed attempt can no longer write. */
export interface Lease {
  jobId: string;
  lockedBy: string;
}

export interface JobContext {
  lease: Lease;
  /** Aborted on lease loss, shutdown or the attempt deadline. */
  signal: AbortSignal;
  /** Marks the job succeeded and runs `write` in one transaction; LeaseLostError if not ours. */
  complete(write: (manager: EntityManager) => Promise<void>): Promise<void>;
}

export interface JobHandler {
  /** Must finish by calling `ctx.complete()`. */
  run(job: ClaimedJob, ctx: JobContext): Promise<void>;
  /** Runs in the transaction that marks the job failed. */
  onFailed(manager: EntityManager, job: ClaimedJob, failure: JobFailure): Promise<void>;
}

export type JobHandlers = Record<JobType, JobHandler>;
