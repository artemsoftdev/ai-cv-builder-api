import { Router, type RequestHandler } from 'express';
import { getAuth } from '../../http/auth-context.js';
import { AppError } from '../../http/errors.js';
import { parseInput } from '../../http/validation.js';
import { cvParamsSchema } from '../cvs/cv.schemas.js';
import type { CvService } from '../cvs/cv.service.js';
import { attachmentDisposition, cvFileBaseName } from './content-disposition.js';
import { renderCvPdf } from './render-cv-pdf.js';

/** GET /api/cvs/:id/pdf, mounted behind requireAuth. */
export function createPdfRouter(deps: {
  cvService: CvService;
  /** Per-user budget: rendering is CPU work in the API process. */
  pdfRateLimit: RequestHandler;
}): Router {
  const router = Router();

  router.get('/:id/pdf', deps.pdfRateLimit, async (req, res) => {
    const { id } = parseInput(cvParamsSchema, req.params);
    // Ownership check included: another user's CV is a 404. The read transaction is over
    // before rendering starts.
    const cv = await deps.cvService.get(getAuth(req).user.id, id);
    if (!cv.content) {
      throw new AppError('CV_NOT_READY', 'This CV has no generated content to export yet');
    }

    const startedAt = performance.now();
    const pdf = await renderCvPdf(cv.content, { title: cv.title });
    req.log.info(
      { cvId: cv.id, bytes: pdf.length, durationMs: Math.round(performance.now() - startedAt) },
      'CV PDF rendered',
    );

    const fileName = cvFileBaseName(cv.content.contact.fullName, cv.title);
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': attachmentDisposition(fileName, 'pdf'),
        'Cache-Control': 'no-store',
      })
      .send(pdf);
  });

  return router;
}
