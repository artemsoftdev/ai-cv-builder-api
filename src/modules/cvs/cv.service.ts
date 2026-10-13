import type { DataSource, EntityManager } from 'typeorm';
import { AppError, notFound } from '../../http/errors.js';
import { planCvPatch, type CvPatchInput } from './cv-patch.js';
import { toCvDto, toCvSummaryDto } from './cv.mapper.js';
import { CvRepository } from './cv.repository.js';
import { ACTIONABLE_QUESTION_STATUSES, type CvDto, type CvSummaryDto } from './cv.types.js';

const cvBusy = () =>
  new AppError('CV_BUSY', 'The AI is still working on this CV. Try again when it has finished.');

const versionConflict = (currentVersion: number) =>
  new AppError(
    'VERSION_CONFLICT',
    'This CV was changed elsewhere. Reload to get the latest version.',
    {
      currentVersion,
    },
  );

export class CvService {
  constructor(private readonly dataSource: DataSource) {}

  async list(userId: string): Promise<CvSummaryDto[]> {
    const rows = await new CvRepository(this.dataSource.manager).listSummaries(userId);
    return rows.map(toCvSummaryDto);
  }

  /**
   * Reads the CV, its questions and `busy` from one snapshot. Without it a job could commit
   * between the reads, and the client would see `busy: false` next to stale content and
   * stop polling.
   */
  async get(userId: string, cvId: string): Promise<CvDto> {
    return this.dataSource.transaction('REPEATABLE READ', (manager) =>
      this.getWith(manager, userId, cvId),
    );
  }

  async update(
    userId: string,
    cvId: string,
    input: CvPatchInput & { version: number },
  ): Promise<CvDto> {
    const repo = new CvRepository(this.dataSource.manager);
    const cv = await repo.findOwned(userId, cvId);
    if (!cv) throw notFound('CV');
    if (await repo.isBusy(userId, cvId)) throw cvBusy();
    if (input.version !== cv.version) throw versionConflict(cv.version);
    if (input.content !== undefined && cv.content === null) {
      throw new AppError('CV_NOT_READY', 'This CV has no generated content to edit yet');
    }

    const changes = planCvPatch(cv, input);
    if (changes) {
      const newVersion = await repo.updateIfCurrent(userId, cvId, cv.version, changes);
      // Lost a race since the checks above (concurrent edit, new job or deletion).
      if (newVersion === null) await this.explainLostUpdate(repo, userId, cvId);
    }
    return this.get(userId, cvId);
  }

  async delete(userId: string, cvId: string): Promise<void> {
    const deleted = await new CvRepository(this.dataSource.manager).deleteOwned(userId, cvId);
    if (!deleted) throw notFound('CV');
  }

  async dismissQuestion(userId: string, cvId: string, questionId: string): Promise<CvDto> {
    const repo = new CvRepository(this.dataSource.manager);
    if (!(await repo.findOwned(userId, cvId))) throw notFound('CV');

    const dismissed = await repo.transitionQuestion(
      userId,
      cvId,
      questionId,
      ACTIONABLE_QUESTION_STATUSES,
      'dismissed',
    );
    if (!dismissed) {
      const question = await repo.findQuestion(userId, cvId, questionId);
      if (!question) throw notFound('Question');
      throw new AppError(
        'INVALID_STATE',
        `Only open or failed questions can be dismissed (this one is ${question.status})`,
      );
    }
    return this.get(userId, cvId);
  }

  private async getWith(manager: EntityManager, userId: string, cvId: string): Promise<CvDto> {
    const repo = new CvRepository(manager);
    const cv = await repo.findOwned(userId, cvId);
    if (!cv) throw notFound('CV');
    const questions = await repo.listQuestions(userId, cvId);
    const busy = await repo.isBusy(userId, cvId);
    return toCvDto(cv, questions, busy);
  }

  private async explainLostUpdate(
    repo: CvRepository,
    userId: string,
    cvId: string,
  ): Promise<never> {
    const cv = await repo.findOwned(userId, cvId);
    if (!cv) throw notFound('CV');
    if (await repo.isBusy(userId, cvId)) throw cvBusy();
    throw versionConflict(cv.version);
  }
}
