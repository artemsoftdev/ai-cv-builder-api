import type { CvEntity, CvQuestionEntity } from '../../db/entities/index.js';
import type { CvSummaryRow } from './cv.repository.js';
import type { CvDto, CvQuestionDto, CvSummaryDto } from './cv.types.js';

/** Maps rows to contract DTOs. Fields are listed explicitly so nothing internal leaks. */
export function toCvDto(cv: CvEntity, questions: CvQuestionEntity[], busy: boolean): CvDto {
  return {
    id: cv.id,
    title: cv.title,
    targetRole: cv.targetRole,
    sourceType: cv.sourceType,
    sourceFilename: cv.sourceFilename,
    status: cv.status,
    stage: cv.stage,
    error:
      cv.status === 'failed' && cv.errorCode
        ? { code: cv.errorCode, message: cv.errorMessage ?? '' }
        : null,
    content: cv.content,
    review: cv.review,
    questions: questions.map(toCvQuestionDto),
    version: cv.version,
    busy,
    createdAt: cv.createdAt.toISOString(),
    updatedAt: cv.updatedAt.toISOString(),
  };
}

export function toCvQuestionDto(question: CvQuestionEntity): CvQuestionDto {
  return {
    id: question.id,
    section: question.section,
    itemId: question.itemId,
    question: question.question,
    answer: question.answer,
    status: question.status,
    error: question.status === 'failed' ? question.error : null,
    errorMessage: question.status === 'failed' ? question.errorMessage : null,
    createdAt: question.createdAt.toISOString(),
    updatedAt: question.updatedAt.toISOString(),
  };
}

export function toCvSummaryDto(row: CvSummaryRow): CvSummaryDto {
  return {
    id: row.id,
    title: row.title,
    targetRole: row.targetRole,
    status: row.status,
    stage: row.stage,
    busy: row.busy,
    openQuestions: row.openQuestions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
