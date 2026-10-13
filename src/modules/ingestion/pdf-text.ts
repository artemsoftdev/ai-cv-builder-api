import { extractLinks, extractText, getDocumentProxy } from 'unpdf';
import { SOURCE_LIMITS } from './source-text.js';

/** A PDF we cannot (or will not) read; `userMessage` is safe to show. */
export class PdfUnreadableError extends Error {
  constructor(
    readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(userMessage, options);
    this.name = 'PdfUnreadableError';
  }
}

export interface ExtractedPdf {
  text: string;
  pages: number;
  /** URLs of link annotations: often a "GitHub" label whose URL is not in the text itself. */
  links: string[];
}

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const MAX_LINKS = 20;
const SAFE_LINK_RE = /^(?:https?:|mailto:)/i;

/** Checked on the bytes, not on the file name or the client's content type. */
export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * Reads the text layer of a PDF with pdf.js (via unpdf), refusing encrypted, broken or too
 * long documents. The parse runs in-process, so it is bounded by the upload size, the page
 * limit and a timeout.
 */
export async function extractPdfText(
  bytes: Buffer,
  {
    timeoutMs = 10_000,
    maxPages = SOURCE_LIMITS.pdfPages,
  }: { timeoutMs?: number; maxPages?: number } = {},
): Promise<ExtractedPdf> {
  // pdf.js may detach the buffer it is given, so it gets a copy.
  const loading = getDocumentProxy(new Uint8Array(bytes), {
    verbosity: 0, // errors only; warnings would go to stdout
  });
  const read = (async (): Promise<ExtractedPdf> => {
    const doc = await loading;
    if (doc.numPages > maxPages) {
      throw new PdfUnreadableError(
        `This PDF has ${doc.numPages} pages; at most ${maxPages} are supported.`,
      );
    }
    const { text } = await extractText(doc, { mergePages: true });
    const { links } = await extractLinks(doc);
    return { text, pages: doc.numPages, links: safeLinks(links) };
  })();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PdfUnreadableError('This PDF took too long to read.')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([read, timeout]);
  } catch (err) {
    throw toUnreadable(err);
  } finally {
    clearTimeout(timer);
    // Free pdf.js resources once reading has settled (even after a timeout).
    void read
      .catch(() => undefined)
      .then(() => loading)
      .then((doc) => doc.loadingTask.destroy())
      .catch(() => undefined);
  }
}

function safeLinks(links: string[]): string[] {
  const unique = new Set(
    links
      .map((link) => link.trim())
      .filter((link) => SAFE_LINK_RE.test(link) && link.length <= 300),
  );
  return [...unique].slice(0, MAX_LINKS);
}

function toUnreadable(err: unknown): PdfUnreadableError {
  if (err instanceof PdfUnreadableError) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'PasswordException') {
    return new PdfUnreadableError('This PDF is password-protected.', { cause: err });
  }
  if (name === 'InvalidPDFException') {
    return new PdfUnreadableError('This PDF is damaged or not a valid PDF.', { cause: err });
  }
  return new PdfUnreadableError('We could not read this PDF.', { cause: err });
}
