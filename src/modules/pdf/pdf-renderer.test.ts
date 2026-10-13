import { afterEach, describe, expect, it } from 'vitest';
import { sampleContent } from '../../../test/fixtures/cv-content.js';
import { inspectPdf } from '../../../test/helpers/pdf-inspect.js';
import { PdfRenderer, PdfRenderTimeoutError, type PdfRendererOptions } from './pdf-renderer.js';
import { renderCvPdf } from './render-cv-pdf.js';

/** setImmediate turns while `work` runs: each one is a chance for the server to handle I/O. */
async function ioTurnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0;
  let done = false;
  const spin = (async () => {
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      turns++;
    }
  })();
  await work();
  done = true;
  await spin;
  return turns;
}

const withName = (fullName: string) => {
  const content = sampleContent();
  content.contact.fullName = fullName;
  return content;
};

// Worker start-up and rendering are CPU-bound and share the machine with other test files.
describe('PdfRenderer', { timeout: 60_000 }, () => {
  const started: PdfRenderer[] = [];
  const createRenderer = (options?: PdfRendererOptions) => {
    const renderer = new PdfRenderer(options);
    started.push(renderer);
    return renderer;
  };
  afterEach(() => {
    for (const renderer of started.splice(0)) renderer.stop();
  });

  it('renders off the main thread, so requests keep being served meanwhile', async () => {
    const renderer = createRenderer();
    const content = withName('Иван Петров');
    await renderer.render(content, 'warm-up');

    let pdf: Buffer = Buffer.alloc(0);
    const turnsWithWorker = await ioTurnsDuring(async () => {
      pdf = await renderer.render(content, 'CV');
    });
    const turnsInThread = await ioTurnsDuring(() => renderCvPdf(content, { title: 'CV' }));

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await inspectPdf(pdf)).text).toContain('Иван Петров');
    // In-thread, react-pdf keeps the loop in its timers phase until the document is done.
    expect(turnsWithWorker).toBeGreaterThan(Math.max(100, turnsInThread * 10));
  });

  it('answers concurrent renders with their own documents', async () => {
    const renderer = createRenderer();
    const names = ['Ada Lovelace', 'Grace Hopper', 'Мария Иванова'];
    const pdfs = await Promise.all(names.map((name) => renderer.render(withName(name), name)));
    const docs = await Promise.all(pdfs.map((pdf) => inspectPdf(pdf)));
    expect(docs.map((doc) => doc.title)).toEqual(names);
    docs.forEach((doc, i) => expect(doc.text).toContain(names[i]));
  });

  it('rejects a render that misses the deadline', async () => {
    const renderer = createRenderer({ timeoutMs: 1 });
    await expect(renderer.render(sampleContent(), 'CV')).rejects.toBeInstanceOf(
      PdfRenderTimeoutError,
    );
  });

  it('starts a new worker after being stopped', async () => {
    const renderer = createRenderer();
    const inFlight = renderer.render(sampleContent(), 'first');
    renderer.stop(new Error('restart'));
    await expect(inFlight).rejects.toThrow('restart');

    const pdf = await renderer.render(withName('Jane Doe'), 'second');
    expect((await inspectPdf(pdf)).title).toBe('second');
  });
});
