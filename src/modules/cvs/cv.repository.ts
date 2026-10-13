import type { EntityManager } from 'typeorm';
import { CvEntity, CvQuestionEntity } from '../../db/entities/index.js';
import { ACTIVE_JOB_STATUSES } from '../../db/entities/job.entity.js';
import { runSql } from '../../db/sql.js';
import type { CvContent } from './cv-content.schema.js';
import type { CvChanges } from './cv-patch.js';
import {
  ACTIONABLE_QUESTION_STATUSES,
  type CvReview,
  type CvStatus,
  type GenerationStage,
  type QuestionStatus,
  type SourceType,
} from './cv.types.js';

export interface CvSummaryRow {
  id: string;
  title: string;
  targetRole: string;
  status: CvStatus;
  stage: GenerationStage;
  busy: boolean;
  openQuestions: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCv {
  userId: string;
  title: string;
  targetRole: string;
  sourceType: SourceType;
  sourceFilename?: string | null;
  sourceText?: string | null;
  sourcePdf?: Buffer | null;
  status?: CvStatus;
  stage?: GenerationStage;
  content?: CvContent | null;
  review?: CvReview | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** Every query filters by owner, so another user's CV looks missing (404, never 403). */
export class CvRepository {
  constructor(private readonly manager: EntityManager) {}

  async create(input: NewCv): Promise<CvEntity> {
    return this.manager.save(this.manager.create(CvEntity, input));
  }

  async listSummaries(userId: string): Promise<CvSummaryRow[]> {
    return this.manager.query<CvSummaryRow[]>(
      `SELECT c.id,
              c.title,
              c.target_role AS "targetRole",
              c.status,
              c.stage,
              EXISTS (
                SELECT 1 FROM jobs j WHERE j.cv_id = c.id AND j.status = ANY ($2::text[])
              ) AS busy,
              (
                SELECT count(*)::int FROM cv_questions q
                 WHERE q.cv_id = c.id AND q.status = ANY ($3::text[])
              ) AS "openQuestions",
              c.created_at AS "createdAt",
              c.updated_at AS "updatedAt"
         FROM cvs c
        WHERE c.user_id = $1
        ORDER BY c.created_at DESC, c.id DESC`,
      [userId, ACTIVE_JOB_STATUSES, ACTIONABLE_QUESTION_STATUSES],
    );
  }

  async findOwned(userId: string, cvId: string): Promise<CvEntity | null> {
    return this.manager.findOneBy(CvEntity, { id: cvId, userId });
  }

  async findSource(
    userId: string,
    cvId: string,
  ): Promise<Pick<
    CvEntity,
    'sourceType' | 'sourceFilename' | 'sourceTranscribed' | 'sourceText'
  > | null> {
    return this.manager
      .createQueryBuilder(CvEntity, 'cv')
      .select(['cv.id', 'cv.sourceType', 'cv.sourceFilename', 'cv.sourceTranscribed'])
      .addSelect('cv.sourceText')
      .where('cv.id = :cvId AND cv.user_id = :userId', { cvId, userId })
      .getOne();
  }

  async loadUserFacts(userId: string, cvId: string): Promise<string[]> {
    const row = await this.manager
      .createQueryBuilder(CvEntity, 'cv')
      .select('cv.id')
      .addSelect('cv.userFacts')
      .where('cv.id = :cvId AND cv.user_id = :userId', { cvId, userId })
      .getOne();
    return row?.userFacts ?? [];
  }

  async isBusy(userId: string, cvId: string): Promise<boolean> {
    const [row] = await this.manager.query<{ busy: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM jobs j JOIN cvs c ON c.id = j.cv_id
          WHERE j.cv_id = $1 AND c.user_id = $2 AND j.status = ANY ($3::text[])
       ) AS busy`,
      [cvId, userId, ACTIVE_JOB_STATUSES],
    );
    return row?.busy ?? false;
  }

  async listQuestions(userId: string, cvId: string): Promise<CvQuestionEntity[]> {
    return this.manager.find(CvQuestionEntity, {
      where: { cvId, cv: { userId } },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
  }

  async findQuestion(
    userId: string,
    cvId: string,
    questionId: string,
  ): Promise<CvQuestionEntity | null> {
    return this.manager.findOneBy(CvQuestionEntity, { id: questionId, cvId, cv: { userId } });
  }

  /** Version and busy check in one statement, so a job enqueued after the caller's checks wins. */
  async updateIfCurrent(
    userId: string,
    cvId: string,
    expectedVersion: number,
    changes: CvChanges,
  ): Promise<number | null> {
    const result = await this.manager
      .createQueryBuilder()
      .update(CvEntity)
      .set({ ...changes, version: () => 'version + 1' })
      .where('id = :cvId AND user_id = :userId AND version = :expectedVersion', {
        cvId,
        userId,
        expectedVersion,
      })
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM jobs WHERE jobs.cv_id = cvs.id AND jobs.status IN (:...activeStatuses)
         )`,
        { activeStatuses: ACTIVE_JOB_STATUSES },
      )
      .returning(['version'])
      .execute();
    const rows = result.raw as { version: number }[];
    return rows[0]?.version ?? null;
  }

  async transitionQuestion(
    userId: string,
    cvId: string,
    questionId: string,
    from: readonly QuestionStatus[],
    to: QuestionStatus,
  ): Promise<boolean> {
    const result = await this.manager
      .createQueryBuilder()
      .update(CvQuestionEntity)
      .set({ status: to })
      .where('id = :questionId AND cv_id = :cvId AND status IN (:...from)', {
        questionId,
        cvId,
        from,
      })
      .andWhere(
        'EXISTS (SELECT 1 FROM cvs WHERE cvs.id = cv_questions.cv_id AND cvs.user_id = :userId)',
        { userId },
      )
      .execute();
    return result.affected === 1;
  }

  /** In a transaction; jobs first, the lock order of a completing job (else deadlock). */
  async deleteOwned(userId: string, cvId: string): Promise<boolean> {
    await runSql(
      this.manager,
      `DELETE FROM jobs
        WHERE cv_id = $1 AND EXISTS (SELECT 1 FROM cvs WHERE cvs.id = $1 AND cvs.user_id = $2)`,
      [cvId, userId],
    );
    const result = await this.manager.delete(CvEntity, { id: cvId, userId });
    return result.affected === 1;
  }
}
