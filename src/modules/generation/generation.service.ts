import type { DataSource } from 'typeorm';
import { runSql } from '../../db/sql.js';
import { AppError, notFound } from '../../http/errors.js';
import type { CvContent } from '../cvs/cv-content.schema.js';
import { CvRepository } from '../cvs/cv.repository.js';
import { cvBusy, type CvService } from '../cvs/cv.service.js';
import {
  ACTIONABLE_QUESTION_STATUSES,
  type CvDto,
  type QuestionSection,
  type QuestionStatus,
} from '../cvs/cv.types.js';
import {
  assertGenerationCapacity,
  assertQueueCapacity,
  type CapacityLimits,
} from '../ingestion/generation-capacity.js';
import { enqueueJob, isCvBusyError } from '../jobs/job-queue.js';

function entryExists(content: CvContent, section: QuestionSection, itemId: string): boolean {
  if (section === 'experience') return content.experience.some((item) => item.id === itemId);
  if (section === 'education') return content.education.some((item) => item.id === itemId);
  return true;
}

const isActionable = (status: QuestionStatus) =>
  (ACTIONABLE_QUESTION_STATUSES as readonly QuestionStatus[]).includes(status);

/** User-triggered work for the job queue: retrying a failed generation, applying answers. */
export class GenerationService {
  constructor(
    private readonly deps: {
      dataSource: DataSource;
      cvService: CvService;
      capacity: CapacityLimits;
    },
  ) {}

  /** failed -> generating/queued with a fresh job. */
  async retry(userId: string, cvId: string): Promise<CvDto> {
    await this.withBusyMapping(() =>
      this.deps.dataSource.transaction(async (manager) => {
        const cv = await new CvRepository(manager).findOwned(userId, cvId);
        if (!cv) throw notFound('CV');
        if (cv.status !== 'failed') throw retryNotAllowed(cv.status);
        await assertGenerationCapacity(manager, userId, this.deps.capacity.maxActiveGenerations);
        await assertQueueCapacity(manager, this.deps.capacity.maxLiveJobs);
        // Re-checked in the UPDATE: a concurrent retry waited on the user lock above.
        const { affected } = await runSql(
          manager,
          `UPDATE cvs
              SET status = 'generating', stage = 'queued', error_code = NULL,
                  error_message = NULL, updated_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'failed'`,
          [cvId, userId],
        );
        if (affected !== 1) throw retryNotAllowed('generating');
        await enqueueJob(manager, { type: 'generate_cv', cvId });
      }),
    );
    return this.deps.cvService.get(userId, cvId);
  }

  /** Stores the answer, marks the question `applying` and enqueues the rewrite. */
  async submitAnswer(
    userId: string,
    cvId: string,
    questionId: string,
    answer: string,
  ): Promise<CvDto> {
    await this.withBusyMapping(() =>
      this.deps.dataSource.transaction(async (manager) => {
        const repo = new CvRepository(manager);
        const cv = await repo.findOwned(userId, cvId);
        if (!cv) throw notFound('CV');
        const question = await repo.findQuestion(userId, cvId, questionId);
        if (!question) throw notFound('Question');
        if (!cv.content) {
          throw new AppError('CV_NOT_READY', 'This CV has no generated content yet');
        }
        if (await repo.isBusy(userId, cvId)) throw cvBusy();
        if (!isActionable(question.status)) {
          throw new AppError(
            'INVALID_STATE',
            `Only open or failed questions can be answered (this one is ${question.status})`,
          );
        }
        if (
          question.itemId !== null &&
          !entryExists(cv.content, question.section, question.itemId)
        ) {
          throw new AppError(
            'INVALID_STATE',
            'The CV entry this question is about has been removed. Dismiss the question instead.',
          );
        }
        await assertQueueCapacity(manager, this.deps.capacity.maxLiveJobs);
        const { affected } = await runSql(
          manager,
          `UPDATE cv_questions
              SET answer = $1, status = 'applying', error = NULL, error_message = NULL,
                  updated_at = now()
            WHERE id = $2 AND cv_id = $3 AND status = ANY ($4::text[])`,
          [answer, questionId, cvId, ACTIONABLE_QUESTION_STATUSES],
        );
        if (affected !== 1) {
          throw new AppError('INVALID_STATE', 'This question was answered or dismissed meanwhile');
        }
        // The unique index on live jobs per CV makes a concurrent second answer fail here.
        await enqueueJob(manager, { type: 'apply_answer', cvId, questionId });
      }),
    );
    return this.deps.cvService.get(userId, cvId);
  }

  /** A unique violation on the live-job index means another job won the race: 409 CV_BUSY. */
  private async withBusyMapping(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (isCvBusyError(err)) throw cvBusy();
      throw err;
    }
  }
}

const retryNotAllowed = (status: string) =>
  new AppError('INVALID_STATE', `Only a failed CV can be retried (this one is ${status})`);
