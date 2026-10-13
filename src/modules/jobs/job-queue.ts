import type { DataSource, EntityManager } from 'typeorm';
import type { JobType } from '../../db/entities/job.entity.js';
import { isUniqueViolation } from '../../db/errors.js';
import { runSql } from '../../db/sql.js';
import type { ClaimedJob, Lease } from './job.types.js';

export const ONE_ACTIVE_JOB_PER_CV_INDEX = 'jobs_one_active_per_cv_uidx';

export type NewJob =
  | { type: 'generate_cv'; cvId: string }
  | { type: 'apply_answer'; cvId: string; questionId: string };

/** Throws a unique violation if the CV already has a live job; see isCvBusyError. */
export async function enqueueJob(manager: EntityManager, job: NewJob): Promise<string> {
  const questionId = job.type === 'apply_answer' ? job.questionId : null;
  const { rows } = await runSql<{ id: string }>(
    manager,
    `INSERT INTO jobs (type, cv_id, question_id) VALUES ($1, $2, $3) RETURNING id`,
    [job.type, job.cvId, questionId],
  );
  return rows[0]!.id;
}

export function isCvBusyError(err: unknown): boolean {
  return isUniqueViolation(err, ONE_ACTIVE_JOB_PER_CV_INDEX);
}

export async function countLiveJobs(manager: EntityManager): Promise<number> {
  const { rows } = await runSql<{ count: number }>(
    manager,
    `SELECT count(*)::int AS count FROM jobs WHERE status IN ('queued', 'running')`,
  );
  return rows[0]?.count ?? 0;
}

export function leaseHeldSql(jobIdParam: string, lockedByParam: string): string {
  return `EXISTS (
    SELECT 1 FROM jobs
     WHERE jobs.id = ${jobIdParam} AND jobs.locked_by = ${lockedByParam} AND jobs.status = 'running'
  )`;
}

interface ClaimedJobRow {
  id: string;
  type: JobType;
  cvId: string;
  questionId: string | null;
  attempts: number;
  maxAttempts: number;
}

/** Every state change after the claim is guarded by the lease. */
export class JobQueue {
  constructor(private readonly dataSource: DataSource) {}

  /** Due or lease-expired jobs; users with fewer live jobs first, so no backlog starves others. */
  async claim(lockedBy: string, leaseMs: number): Promise<ClaimedJob | null> {
    const { rows } = await runSql<ClaimedJobRow>(
      this.dataSource.manager,
      `UPDATE jobs
          SET status = 'running',
              attempts = attempts + 1,
              locked_by = $1,
              locked_until = now() + ($2::int * interval '1 millisecond'),
              updated_at = now()
        WHERE id = (
                WITH live AS (
                  SELECT c.user_id, count(*) AS n
                    FROM jobs lj JOIN cvs c ON c.id = lj.cv_id
                   WHERE lj.status IN ('queued', 'running')
                   GROUP BY c.user_id
                )
                SELECT j.id
                  FROM jobs j
                  JOIN cvs c ON c.id = j.cv_id
                  JOIN live ON live.user_id = c.user_id
                 WHERE (j.status = 'queued' AND j.run_at <= now())
                    OR (j.status = 'running' AND j.locked_until < now())
                 ORDER BY live.n, j.run_at
                 FOR UPDATE OF j SKIP LOCKED
                 LIMIT 1
              )
        RETURNING id, type, cv_id AS "cvId", question_id AS "questionId", attempts,
                  max_attempts AS "maxAttempts"`,
      [lockedBy, leaseMs],
    );
    return rows[0] ?? null;
  }

  /** False when the job is no longer ours (reclaimed, finished or deleted). */
  async heartbeat(lease: Lease, leaseMs: number): Promise<boolean> {
    const { affected } = await runSql(
      this.dataSource.manager,
      `UPDATE jobs
          SET locked_until = now() + ($3::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [lease.jobId, lease.lockedBy, leaseMs],
    );
    return affected === 1;
  }

  async markSucceeded(manager: EntityManager, lease: Lease): Promise<boolean> {
    return this.finish(manager, lease, 'succeeded', null);
  }

  async markFailed(manager: EntityManager, lease: Lease, lastError: string): Promise<boolean> {
    return this.finish(manager, lease, 'failed', lastError);
  }

  async reschedule(lease: Lease, delayMs: number, lastError: string): Promise<boolean> {
    const { affected } = await runSql(
      this.dataSource.manager,
      `UPDATE jobs
          SET status = 'queued',
              run_at = now() + ($3::int * interval '1 millisecond'),
              locked_by = NULL,
              locked_until = NULL,
              last_error = $4,
              updated_at = now()
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [lease.jobId, lease.lockedBy, Math.max(0, Math.round(delayMs)), lastError],
    );
    return affected === 1;
  }

  /** Shutdown hand-back: the attempt is not counted, the job did not fail. */
  async release(lease: Lease): Promise<boolean> {
    const { affected } = await runSql(
      this.dataSource.manager,
      `UPDATE jobs
          SET status = 'queued',
              attempts = GREATEST(attempts - 1, 0),
              run_at = now(),
              locked_by = NULL,
              locked_until = NULL,
              updated_at = now()
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [lease.jobId, lease.lockedBy],
    );
    return affected === 1;
  }

  private async finish(
    manager: EntityManager,
    lease: Lease,
    status: 'succeeded' | 'failed',
    lastError: string | null,
  ): Promise<boolean> {
    const { affected } = await runSql(
      manager,
      `UPDATE jobs
          SET status = $3,
              last_error = COALESCE($4, last_error),
              -- locked_by is kept: it records which worker finished the job.
              locked_until = NULL,
              finished_at = now(),
              updated_at = now()
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [lease.jobId, lease.lockedBy, status, lastError],
    );
    return affected === 1;
  }
}
