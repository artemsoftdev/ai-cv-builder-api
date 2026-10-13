import type { EntityManager } from 'typeorm';
import { Corpus } from '../grounding/corpus.js';
import { replaceReviewPart } from '../grounding/verifier.js';
import {
  LeaseLostError,
  PermanentError,
  TransientError,
  type JobFailure,
} from '../jobs/job-errors.js';
import type { ClaimedJob, JobContext, JobHandler } from '../jobs/job.types.js';
import type { GenerationDeps } from './generate-cv.handler.js';
import { applySectionRewrite, sectionSnapshot } from './section-rewrite.js';

/**
 * apply_answer: rewrites only the section (or entry) the question is about, re-verifies that
 * part against source + answers, and stores it with an optimistic version check.
 */
export class ApplyAnswerHandler implements JobHandler {
  constructor(private readonly deps: GenerationDeps) {}

  async run(job: ClaimedJob, ctx: JobContext): Promise<void> {
    const { repository, llm, logger } = this.deps;
    if (!job.questionId) throw new PermanentError('INTERNAL', 'apply_answer job without question');

    const context = await repository.loadAnswerContext(job.cvId, job.questionId);
    // CV or question deleted: the job row went with it (FK cascade).
    if (!context) throw new LeaseLostError(job.id);
    const { cv, question, appliedAnswers } = context;
    if (question.status !== 'applying' || question.answer === null) {
      logger.warn({ questionId: question.id, status: question.status }, 'Answer is not applying');
      await ctx.complete(async () => {});
      return;
    }
    if (!cv.content || cv.sourceText === null) {
      throw new PermanentError('INTERNAL', 'CV has no generated content to update');
    }

    const target = { section: question.section, itemId: question.itemId };
    const rewrite = await llm.rewriteSection(
      {
        ...sectionSnapshot(cv.content, target),
        targetRole: cv.targetRole,
        sourceText: cv.sourceText,
        question: question.question,
        answer: question.answer,
        priorAnswers: appliedAnswers,
      },
      { signal: ctx.signal },
    );

    // The user's answers are facts; the questions are not, so they stay out of the corpus.
    const corpus = new Corpus(cv.sourceText, [
      ...appliedAnswers.map((a) => a.answer),
      question.answer,
    ]);
    const applied = applySectionRewrite(cv.content, target, rewrite, corpus);
    const review = replaceReviewPart(cv.review, applied.scope, applied.review);

    await ctx.complete(async (manager) => {
      const saved = await repository.saveAnswerResult(manager, {
        cvId: cv.id,
        questionId: question.id,
        expectedVersion: cv.version,
        content: applied.content,
        review,
      });
      // Edits are rejected while the CV is busy, so this is a rare race: start over.
      if (!saved) throw new TransientError('CV changed while the answer was applied', 'INTERNAL');
    });
  }

  async onFailed(manager: EntityManager, job: ClaimedJob, failure: JobFailure): Promise<void> {
    if (!job.questionId) return;
    // The contract stores the error code; the frontend explains it.
    await this.deps.repository.finishQuestion(manager, job.questionId, 'failed', failure.code);
  }
}
