import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { CvContent } from '../cvs/cv-content.schema.js';

export interface RenderRequest {
  id: number;
  content: CvContent;
  title: string;
}

export type RenderReply =
  { id: number; ok: true; pdf: Uint8Array } | { id: number; ok: false; message: string };

export interface PdfRendererOptions {
  timeoutMs?: number;
  maxHeapMb?: number;
}

export class PdfRenderTimeoutError extends Error {
  constructor() {
    super('PDF rendering timed out');
    this.name = 'PdfRenderTimeoutError';
  }
}

const WORKER_URL = new URL(
  `./pdf-render.worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);
// From src/ the worker imports .tsx, which Node cannot load without tsx (a dev dependency).
const WORKER_EXEC_ARGV = WORKER_URL.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [];

interface Pending {
  resolve: (pdf: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** react-pdf holds the event loop for a whole render, so renders run in one long-lived worker thread. */
export class PdfRenderer {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private readonly maxHeapMb: number;

  constructor({ timeoutMs = 20_000, maxHeapMb = 512 }: PdfRendererOptions = {}) {
    this.timeoutMs = timeoutMs;
    this.maxHeapMb = maxHeapMb;
  }

  render(content: CvContent, title: string): Promise<Buffer> {
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    return new Promise<Buffer>((resolve, reject) => {
      // A stuck render blocks every render queued behind it in the worker: start over.
      const timer = setTimeout(() => this.stop(new PdfRenderTimeoutError()), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, content, title } satisfies RenderRequest);
    });
  }

  /** Rejects renders in flight; the next render starts a new worker. */
  stop(reason: Error = new Error('PDF renderer stopped')): void {
    const worker = this.worker;
    this.worker = null;
    for (const [id, pending] of this.pending) this.settle(id, pending, reason);
    if (worker) void worker.terminate();
  }

  private start(): Worker {
    const worker = new Worker(WORKER_URL, {
      execArgv: WORKER_EXEC_ARGV,
      resourceLimits: { maxOldGenerationSizeMb: this.maxHeapMb },
    });
    worker.unref();
    worker.on('message', (reply: RenderReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.settle(
        reply.id,
        pending,
        reply.ok
          ? Buffer.from(reply.pdf.buffer, reply.pdf.byteOffset, reply.pdf.byteLength)
          : new Error(reply.message),
      );
    });
    worker.on('error', (err: Error) => {
      if (this.worker === worker) this.stop(err);
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.stop(new Error('PDF render worker exited'));
    });
    this.worker = worker;
    return worker;
  }

  private settle(id: number, pending: Pending, outcome: Buffer | Error): void {
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (outcome instanceof Error) pending.reject(outcome);
    else pending.resolve(outcome);
  }
}

/** One worker for the whole process, started on the first export. */
export const sharedPdfRenderer = new PdfRenderer();
