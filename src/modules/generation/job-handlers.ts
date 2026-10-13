import type { DataSource } from 'typeorm';
import type { Logger } from '../../logger.js';
import type { JobHandlers } from '../jobs/job.types.js';
import type { LlmClient } from '../llm/llm-client.js';
import { ApplyAnswerHandler } from './apply-answer.handler.js';
import { GenerateCvHandler } from './generate-cv.handler.js';
import { GenerationRepository } from './generation.repository.js';

/** Handlers for every job type, wired to one LLM client. */
export function createJobHandlers(deps: {
  dataSource: DataSource;
  llm: LlmClient;
  logger: Logger;
}): JobHandlers {
  const handlerDeps = {
    repository: new GenerationRepository(deps.dataSource),
    llm: deps.llm,
    logger: deps.logger,
  };
  return {
    generate_cv: new GenerateCvHandler(handlerDeps),
    apply_answer: new ApplyAnswerHandler(handlerDeps),
  };
}
