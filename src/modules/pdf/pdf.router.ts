import { Router, type RequestHandler } from 'express';
import { getAuth } from '../../http/auth-context.js';
import { AppError } from '../../http/errors.js';
import { parseInput } from '../../http/validation.js';
import { cvParamsSchema } from '../cvs/cv.schemas.js';
import type { CvService } from '../cvs/cv.service.js';
import { attachmentDisposition, cvFileBaseName } from './content-disposition.js';
import { PdfRenderTimeoutError, type PdfRenderer } from './pdf-renderer.js';

export function createPdfRouter(deps: {
  cvService: CvService;
  pdfRenderer: PdfRenderer;
  pdfRateLimit: RequestHandler;
}): Router {
  const router = Router();

  router.get('/:id/pdf', deps.pdfRateLimit, async (req, res) => {
    const { id } = parseInput(cvParamsSchema, req.params);
    const cv = await deps.cvService.get(getAuth(req).user.id, id);
    if (!cv.content) {
      throw new AppError('CV_NOT_READY', 'This CV has no generated content to export yet');
    }

    const startedAt = performance.now();
    const pdf = await deps.pdfRenderer.render(cv.content, cv.title).catch((err: unknown) => {
      if (!(err instanceof PdfRenderTimeoutError)) throw err;
      throw new AppError('INTERNAL', 'Creating the PDF took too long. Please try again.');
    });
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
