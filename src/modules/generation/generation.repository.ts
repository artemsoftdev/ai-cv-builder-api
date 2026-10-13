import type { DataSource, EntityManager } from 'typeorm';
import { CvEntity, CvQuestionEntity } from '../../db/entities/index.js';
import { runSql } from '../../db/sql.js';
import type { CvContent } from '../cvs/cv-content.schema.js';
import type { CvReview, GenerationStage, QuestionSection } from '../cvs/cv.types.js';
import type { JobFailure } from '../jobs/job-errors.js';
import { leaseHeldSql } from '../jobs/job-queue.js';
import type { Lease } from '../jobs/job.types.js';
import type { AnsweredQuestion } from '../llm/llm-client.js';
import type { NewQuestion } from './draft-sanitizer.js';

export interface GenerationSource {
  id: string;
  targetRole: string;
  status: CvEntity['status'];
  sourceText: string | null;
  sourcePdf: Buffer | null;
}

export interface AnswerContext {
  cv: {
    id: string;
    targetRole: string;
    content: CvContent | null;
    review: CvReview | null;
    version: number;
    sourceText: string | null;
  };
  question: {
    id: string;
    section: QuestionSection;
    itemId: string | null;
    question: string;
    answer: string | null;
    status: CvQuestionEntity['status'];
  };
  /** Other questions of this CV whose answers were already applied. */
  appliedAnswers: AnsweredQuestion[];
}

/**
 * Data access for the background pipeline. Jobs act for the system, not a user, so unlike
 * CvRepository nothing here is scoped by user. Writes made while a job runs are guarded by its
 * lease; writes inside `JobContext.complete()` are not, because that transaction has already
 * verified (and locked) the lease.
 */
export class GenerationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async loadSource(cvId: string): Promise<GenerationSource | null> {
    return this.dataSource.manager
      .createQueryBuilder(CvEntity, 'cv')
      .select(['cv.id', 'cv.targetRole', 'cv.status'])
      .addSelect(['cv.sourceText', 'cv.sourcePdf'])
      .where('cv.id = :cvId', { cvId })
      .getOne();
  }

  /** Progress shown to the user. Not a content change: the version stays. */
  async setStage(cvId: string, stage: GenerationStage, lease: Lease): Promise<void> {
    await runSql(
      this.dataSource.manager,
      `UPDATE cvs SET stage = $1, updated_at = now()
        WHERE id = $2 AND status = 'generating' AND ${leaseHeldSql('$3', '$4')}`,
      [stage, cvId, lease.jobId, lease.lockedBy],
    );
  }

  /**
   * Keeps the transcription of a scanned PDF and drops the PDF bytes, so a later retry does
   * not transcribe (and pay for) it again.
   */
  async saveTranscription(cvId: string, text: string, lease: Lease): Promise<void> {
    await runSql(
      this.dataSource.manager,
      `UPDATE cvs SET source_text = $1, source_pdf = NULL, updated_at = now()
        WHERE id = $2 AND ${leaseHeldSql('$3', '$4')}`,
      [text, cvId, lease.jobId, lease.lockedBy],
    );
  }

  /** Stores the generated CV and its questions (inside the job's completing transaction). */
  async saveGenerated(
    manager: EntityManager,
    cvId: string,
    result: { content: CvContent; review: CvReview; questions: NewQuestion[] },
  ): Promise<void> {
    await runSql(
      manager,
      `UPDATE cvs
          SET content = $1::jsonb, review = $2::jsonb, status = 'ready', stage = 'done',
              error_code = NULL, error_message = NULL, version = version + 1, updated_at = now()
        WHERE id = $3`,
      [JSON.stringify(result.content), JSON.stringify(result.review), cvId],
    );
    // A generation defines the CV from scratch, so questions about an older draft go away.
    await manager.delete(CvQuestionEntity, { cvId });
    if (result.questions.length > 0) {
      await manager.insert(
        CvQuestionEntity,
        result.questions.map((question, index) => ({
          cvId,
          section: question.section,
          itemId: question.itemId,
          question: question.question,
          status: 'open' as const,
          position: index + 1,
        })),
      );
    }
  }

  async markGenerationFailed(
    manager: EntityManager,
    cvId: string,
    failure: JobFailure,
  ): Promise<void> {
    await runSql(
      manager,
      `UPDATE cvs SET status = 'failed', error_code = $1, error_message = $2, updated_at = now()
        WHERE id = $3 AND status = 'generating'`,
      [failure.code, failure.userMessage, cvId],
    );
  }

  async loadAnswerContext(cvId: string, questionId: string): Promise<AnswerContext | null> {
    const cv = await this.dataSource.manager
      .createQueryBuilder(CvEntity, 'cv')
      .select(['cv.id', 'cv.targetRole', 'cv.content', 'cv.review', 'cv.version'])
      .addSelect('cv.sourceText')
      .where('cv.id = :cvId', { cvId })
      .getOne();
    if (!cv) return null;
    const questions = await this.dataSource.manager.find(CvQuestionEntity, {
      where: { cvId },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    const question = questions.find((q) => q.id === questionId);
    if (!question) return null;
    return {
      cv,
      question,
      appliedAnswers: questions.flatMap((q) =>
        q.id !== questionId && q.status === 'applied' && q.answer !== null
          ? [{ question: q.question, answer: q.answer }]
          : [],
      ),
    };
  }

  /**
   * Stores the content updated from an answer if the CV is still at `expectedVersion`, and
   * marks the question applied. Returns false (writing nothing) on a version mismatch.
   */
  async saveAnswerResult(
    manager: EntityManager,
    update: {
      cvId: string;
      questionId: string;
      expectedVersion: number;
      content: CvContent;
      review: CvReview;
    },
  ): Promise<boolean> {
    const { affected } = await runSql(
      manager,
      `UPDATE cvs SET content = $1::jsonb, review = $2::jsonb, version = version + 1,
              updated_at = now()
        WHERE id = $3 AND version = $4`,
      [
        JSON.stringify(update.content),
        JSON.stringify(update.review),
        update.cvId,
        update.expectedVersion,
      ],
    );
    if (affected !== 1) return false;
    await this.finishQuestion(manager, update.questionId, 'applied', null);
    return true;
  }

  async finishQuestion(
    manager: EntityManager,
    questionId: string,
    status: 'applied' | 'failed',
    error: string | null,
  ): Promise<void> {
    await runSql(
      manager,
      `UPDATE cv_questions SET status = $1, error = $2, updated_at = now()
        WHERE id = $3 AND status = 'applying'`,
      [status, error, questionId],
    );
  }
}
