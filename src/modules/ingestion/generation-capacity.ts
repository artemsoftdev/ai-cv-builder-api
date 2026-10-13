import type { EntityManager } from 'typeorm';
import { runSql } from '../../db/sql.js';
import { AppError } from '../../http/errors.js';
import { countLiveJobs } from '../jobs/job-queue.js';

export const DEFAULT_MAX_ACTIVE_GENERATIONS = 3;
export const DEFAULT_MAX_LIVE_JOBS = 100;
const RETRY_AFTER_SECONDS = '30';
const QUEUE_FULL_RETRY_AFTER_SECONDS = '60';

export interface CapacityLimits {
  maxActiveGenerations: number;
  maxLiveJobs: number;
}

/** Locks the user row, so two parallel starts cannot both see N-1 and proceed. */
export async function assertGenerationCapacity(
  manager: EntityManager,
  userId: string,
  maxActive: number,
): Promise<void> {
  await runSql(manager, 'SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const { rows } = await runSql<{ count: number }>(
    manager,
    `SELECT count(*)::int AS count FROM cvs WHERE user_id = $1 AND status = 'generating'`,
    [userId],
  );
  if ((rows[0]?.count ?? 0) >= maxActive) {
    throw new AppError(
      'RATE_LIMITED',
      `You can generate at most ${maxActive} CVs at the same time. Please wait for one to finish.`,
      undefined,
      { 'Retry-After': RETRY_AFTER_SECONDS },
    );
  }
}

/** Deployment-wide: bounds LLM spend and queue latency. */
export async function assertQueueCapacity(manager: EntityManager, maxLiveJobs: number) {
  if ((await countLiveJobs(manager)) >= maxLiveJobs) {
    throw new AppError(
      'RATE_LIMITED',
      'The AI is busy with other CVs right now. Please try again in a few minutes.',
      undefined,
      { 'Retry-After': QUEUE_FULL_RETRY_AFTER_SECONDS },
    );
  }
}
