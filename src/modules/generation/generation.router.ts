import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getAuth } from '../../http/auth-context.js';
import { parseInput } from '../../http/validation.js';
import { multilineText } from '../cvs/cv-content.schema.js';
import { cvParamsSchema, questionParamsSchema } from '../cvs/cv.schemas.js';
import type { GenerationService } from './generation.service.js';

export const ANSWER_MAX_CHARS = 2_000;

const answerBodySchema = z.object({
  answer: multilineText(ANSWER_MAX_CHARS).min(1, 'Answer is required'),
});

/** Retry and answer routes, mounted at /api/cvs behind requireAuth. Both answer 202. */
export function createGenerationRouter(deps: {
  generationService: GenerationService;
  generationRateLimit: RequestHandler;
  answerRateLimit: RequestHandler;
}): Router {
  const { generationService } = deps;
  const router = Router();

  router.post('/:id/retry', deps.generationRateLimit, async (req, res) => {
    const { id } = parseInput(cvParamsSchema, req.params);
    res.status(202).json({ cv: await generationService.retry(getAuth(req).user.id, id) });
  });

  router.post('/:id/questions/:questionId/answer', deps.answerRateLimit, async (req, res) => {
    const { id, questionId } = parseInput(questionParamsSchema, req.params);
    const { answer } = parseInput(answerBodySchema, req.body);
    const cv = await generationService.submitAnswer(getAuth(req).user.id, id, questionId, answer);
    res.status(202).json({ cv });
  });

  return router;
}
