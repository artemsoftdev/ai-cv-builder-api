import type { EntityManager } from 'typeorm';
import type { Logger } from '../../logger.js';
import { Corpus } from '../grounding/corpus.js';
import { verifyContent } from '../grounding/verifier.js';
import {
  countNonWhitespace,
  normalizeSourceText,
  SOURCE_LIMITS,
} from '../ingestion/source-text.js';
import { LeaseLostError, PermanentError, type JobFailure } from '../jobs/job-errors.js';
import type { ClaimedJob, JobContext, JobHandler } from '../jobs/job.types.js';
import type { LlmClient } from '../llm/llm-client.js';
import { sanitizeDraft } from './draft-sanitizer.js';
import type { GenerationRepository } from './generation.repository.js';
import { NO_READABLE_TEXT } from './prompts.js';

const MIN_TRANSCRIBED_CHARS = 50;

export interface GenerationDeps {
  repository: GenerationRepository;
  llm: LlmClient;
  logger: Logger;
}

/** Content, review, questions and the job status are committed together at the end. */
export class GenerateCvHandler implements JobHandler {
  constructor(private readonly deps: GenerationDeps) {}

  async run(job: ClaimedJob, ctx: JobContext): Promise<void> {
    const { repository, llm, logger } = this.deps;
    const cv = await repository.loadSource(job.cvId);
    if (!cv) throw new LeaseLostError(job.id);
    if (cv.status !== 'generating') {
      logger.warn(
        { cvId: cv.id, status: cv.status },
        'generate_cv for a CV that is not generating',
      );
      await ctx.complete(async () => {});
      return;
    }

    let sourceText = cv.sourceText;
    if (sourceText === null) {
      if (!cv.sourcePdf) {
        throw new PermanentError('SOURCE_UNREADABLE', 'CV has neither source text nor PDF');
      }
      await repository.setStage(cv.id, 'extracting', ctx.lease);
      sourceText = await this.transcribe(cv.sourcePdf, ctx.signal);
      await repository.saveTranscription(cv.id, sourceText, ctx.lease);
    }

    await repository.setStage(cv.id, 'drafting', ctx.lease);
    const draft = await llm.draftCv(
      { sourceText, targetRole: cv.targetRole },
      { signal: ctx.signal },
    );

    await repository.setStage(cv.id, 'verifying', ctx.lease);
    const sanitized = sanitizeDraft(draft);
    const { content, review } = verifyContent(
      sanitized.content,
      sanitized.claimedEvidence,
      new Corpus(sourceText),
    );
    logger.info(
      {
        cvId: cv.id,
        experience: content.experience.length,
        flags: review.flags.length,
        removed: review.removed.length,
        questions: sanitized.questions.length,
      },
      'CV draft verified',
    );

    await ctx.complete((manager) =>
      repository.saveGenerated(manager, cv.id, {
        content,
        review,
        questions: sanitized.questions,
      }),
    );
  }

  async onFailed(manager: EntityManager, job: ClaimedJob, failure: JobFailure): Promise<void> {
    await this.deps.repository.markGenerationFailed(manager, job.cvId, failure);
  }

  /** Model output: normalised and checked like an uploaded text. */
  private async transcribe(pdf: Buffer, signal: AbortSignal): Promise<string> {
    const text = normalizeSourceText(await this.deps.llm.transcribePdf(pdf, { signal }));
    if (text.includes(NO_READABLE_TEXT) || countNonWhitespace(text) < MIN_TRANSCRIBED_CHARS) {
      throw new PermanentError('SOURCE_UNREADABLE', 'Transcription found no readable text');
    }
    if (text.length > SOURCE_LIMITS.extractedMax) {
      throw new PermanentError('SOURCE_UNREADABLE', 'Transcription exceeds the source limit', {
        userMessage: `This PDF contains more text than we can process (at most ${SOURCE_LIMITS.extractedMax.toLocaleString('en')} characters).`,
      });
    }
    return text;
  }
}
