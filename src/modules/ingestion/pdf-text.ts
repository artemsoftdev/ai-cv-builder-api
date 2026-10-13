import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { SOURCE_LIMITS } from './source-text.js';

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
  links: string[];
}

export interface PdfWorkerInput {
  bytes: Uint8Array;
  maxPages: number;
}

export type PdfWorkerResult =
  | { ok: true; text: string; pages: number; links: string[] }
  | { ok: false; reason: 'too_many_pages'; pages: number }
  | { ok: false; reason: 'error'; errorName: string };

export interface ExtractOptions {
  timeoutMs?: number;
  maxPages?: number;
  maxHeapMb?: number;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const MAX_LINKS = 20;
const SAFE_LINK_RE = /^(?:https?:|mailto:)/i;
const MAX_CONCURRENT_PARSES = 2;
const WORKER_URL = new URL(
  `./pdf-text.worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

let activeParses = 0;
const waitingParses: (() => void)[] = [];

async function withParseSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeParses >= MAX_CONCURRENT_PARSES) {
    await new Promise<void>((resolve) => waitingParses.push(resolve));
  } else {
    activeParses++;
  }
  try {
    return await work();
  } finally {
    const next = waitingParses.shift();
    if (next) next();
    else activeParses--;
  }
}

/** In a worker thread: a crafted PDF hits the heap limit or the deadline, not the event loop. */
export function extractPdfText(
  bytes: Buffer,
  { timeoutMs = 10_000, maxPages = SOURCE_LIMITS.pdfPages, maxHeapMb = 256 }: ExtractOptions = {},
): Promise<ExtractedPdf> {
  return withParseSlot(() => runWorker(bytes, { timeoutMs, maxPages, maxHeapMb }));
}

function runWorker(
  bytes: Buffer,
  { timeoutMs, maxPages, maxHeapMb }: Required<ExtractOptions>,
): Promise<ExtractedPdf> {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(bytes);
    const worker = new Worker(WORKER_URL, {
      workerData: { bytes: copy, maxPages } satisfies PdfWorkerInput,
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const settle = (outcome: ExtractedPdf | PdfUnreadableError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (outcome instanceof PdfUnreadableError) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () => settle(new PdfUnreadableError('This PDF took too long to read.')),
      timeoutMs,
    );
    worker.once('message', (result: PdfWorkerResult) => settle(fromWorker(result, maxPages)));
    worker.once('error', (err: Error) => settle(fromWorkerError(err)));
    worker.once('exit', () => settle(new PdfUnreadableError('We could not read this PDF.')));
  });
}

function fromWorker(result: PdfWorkerResult, maxPages: number): ExtractedPdf | PdfUnreadableError {
  if (result.ok) return { text: result.text, pages: result.pages, links: safeLinks(result.links) };
  if (result.reason === 'too_many_pages') {
    return new PdfUnreadableError(
      `This PDF has ${result.pages} pages; at most ${maxPages} are supported.`,
    );
  }
  if (result.errorName === 'PasswordException') {
    return new PdfUnreadableError('This PDF is password-protected.');
  }
  if (result.errorName === 'InvalidPDFException') {
    return new PdfUnreadableError('This PDF is damaged or not a valid PDF.');
  }
  return new PdfUnreadableError('We could not read this PDF.');
}

function fromWorkerError(err: Error): PdfUnreadableError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return new PdfUnreadableError('This PDF is too complex to read.', { cause: err });
  }
  return new PdfUnreadableError('We could not read this PDF.', { cause: err });
}

function safeLinks(links: string[]): string[] {
  const unique = new Set(
    links
      .map((link) => link.trim())
      .filter((link) => SAFE_LINK_RE.test(link) && link.length <= 300),
  );
  return [...unique].slice(0, MAX_LINKS);
}
