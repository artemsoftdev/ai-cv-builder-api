import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getAuth } from '../../http/auth-context.js';
import { parseInput } from '../../http/validation.js';
import { lineText } from '../cvs/cv-content.schema.js';
import type { IngestionService } from './ingestion.service.js';
import { parseCvUpload } from './upload.js';

const createCvFieldsSchema = z.object({
  targetRole: lineText(120).min(1, 'Target role is required'),
  // Length limits are checked after normalisation (422, see IngestionService).
  text: z.string().optional(),
});

/** POST /api/cvs (multipart). Mounted behind requireAuth. */
export function createIngestionRouter(deps: {
  ingestionService: IngestionService;
  /** Per-user budget of generation starts, shared with retry. */
  generationRateLimit: RequestHandler;
}): Router {
  const router = Router();

  // Rate limit before parsing: a throttled request should not cost an upload.
  router.post('/', deps.generationRateLimit, parseCvUpload, async (req, res) => {
    const fields = parseInput(createCvFieldsSchema, req.body);
    const cv = await deps.ingestionService.createCv(
      getAuth(req).user.id,
      {
        targetRole: fields.targetRole,
        text: fields.text,
        file: req.file && { buffer: req.file.buffer, originalName: req.file.originalname },
      },
      req.log,
    );
    res.status(202).json({ cv });
  });

  return router;
}
