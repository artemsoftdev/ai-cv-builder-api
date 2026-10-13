import { Router } from 'express';
import { getAuth } from '../../http/auth-context.js';
import { parseInput } from '../../http/validation.js';
import { cvParamsSchema, patchCvBodySchema, questionParamsSchema } from './cv.schemas.js';
import type { CvService } from './cv.service.js';

/**
 * CV read/edit/delete routes, mounted at /api/cvs behind requireAuth.
 * Creation, retry, answers (part 2) and PDF export (part 3) live in their own routers mounted
 * on the same path, see http/routes.ts.
 */
export function createCvsRouter({ cvService }: { cvService: CvService }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json({ items: await cvService.list(getAuth(req).user.id) });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseInput(cvParamsSchema, req.params);
    res.json({ cv: await cvService.get(getAuth(req).user.id, id) });
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parseInput(cvParamsSchema, req.params);
    const body = parseInput(patchCvBodySchema, req.body);
    res.json({ cv: await cvService.update(getAuth(req).user.id, id, body) });
  });

  router.delete('/:id', async (req, res) => {
    const { id } = parseInput(cvParamsSchema, req.params);
    await cvService.delete(getAuth(req).user.id, id);
    res.status(204).end();
  });

  router.post('/:id/questions/:questionId/dismiss', async (req, res) => {
    const { id, questionId } = parseInput(questionParamsSchema, req.params);
    res.json({ cv: await cvService.dismissQuestion(getAuth(req).user.id, id, questionId) });
  });

  return router;
}
