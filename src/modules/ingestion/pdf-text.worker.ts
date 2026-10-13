// Only packages and erased types: Node loads this file directly in dev and tests.
import { parentPort, workerData } from 'node:worker_threads';
import { extractLinks, extractText, getDocumentProxy } from 'unpdf';
import type { PdfWorkerInput, PdfWorkerResult } from './pdf-text.js';

async function read({ bytes, maxPages }: PdfWorkerInput): Promise<PdfWorkerResult> {
  const doc = await getDocumentProxy(bytes, { verbosity: 0 });
  if (doc.numPages > maxPages) return { ok: false, reason: 'too_many_pages', pages: doc.numPages };
  const { text } = await extractText(doc, { mergePages: true });
  const { links } = await extractLinks(doc);
  return { ok: true, text, pages: doc.numPages, links };
}

read(workerData as PdfWorkerInput).then(
  (result) => parentPort?.postMessage(result),
  (err: unknown) =>
    parentPort?.postMessage({
      ok: false,
      reason: 'error',
      errorName: err instanceof Error ? err.name : '',
    } satisfies PdfWorkerResult),
);
