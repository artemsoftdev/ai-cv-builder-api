import { parentPort } from 'node:worker_threads';
import type { RenderReply, RenderRequest } from './pdf-renderer.js';
import { renderCvPdf } from './render-cv-pdf.js';

parentPort?.on('message', ({ id, content, title }: RenderRequest) => {
  renderCvPdf(content, { title }).then(
    (pdf) => parentPort?.postMessage({ id, ok: true, pdf } satisfies RenderReply),
    (err: unknown) =>
      parentPort?.postMessage({
        id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      } satisfies RenderReply),
  );
});
