import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import { extractLinks, extractText, getDocumentProxy, getMeta } from 'unpdf';

const require = createRequire(import.meta.url);

export interface PdfFixtureOptions {
  /** Embed DejaVu Sans (needed for non-Latin text such as Cyrillic). */
  unicode?: boolean;
  /** Adds a link annotation whose URL does not appear in the text. */
  hiddenLinkUrl?: string;
}

async function loadFont(doc: PDFDocument, unicode: boolean): Promise<PDFFont> {
  if (!unicode) return doc.embedFont(StandardFonts.Helvetica);
  doc.registerFontkit(fontkit);
  const fontPath = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
  return doc.embedFont(await readFile(fontPath), { subset: true });
}

/** A PDF with a real text layer: one page per entry of `pages`, one line per string. */
export async function makePdf(
  pages: readonly (readonly string[])[],
  options: PdfFixtureOptions = {},
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await loadFont(doc, options.unicode ?? false);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]); // A4 in points
    lines.forEach((line, i) => {
      page.drawText(line, { x: 50, y: 790 - i * 16, size: 11, font });
    });
    if (options.hiddenLinkUrl && page === doc.getPage(0)) {
      const link = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [50, 780, 200, 800],
          Border: [0, 0, 0],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(options.hiddenLinkUrl) },
        }),
      );
      page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
    }
  }
  return Buffer.from(await doc.save());
}

/** A PDF without a text layer, like a scanned document (only shapes). */
export async function makeScannedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 50, y: 600, width: 300, height: 150, color: rgb(0.2, 0.2, 0.2) });
  return Buffer.from(await doc.save());
}

export interface InspectedPdf {
  /** Width x height of every page, in points. */
  pageSizes: { width: number; height: number }[];
  /** Extracted text per page, with whitespace runs (including line wraps) collapsed. */
  pageTexts: string[];
  /** All pages' text, joined and collapsed the same way. */
  text: string;
  links: string[];
  title: string | undefined;
}

/** Reads a generated PDF back the way a viewer or an ATS would: page boxes, text, links. */
export async function inspectPdf(bytes: Buffer): Promise<InspectedPdf> {
  const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const pageSizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const [x0, y0, x1, y1] = (await doc.getPage(i)).view as [number, number, number, number];
    pageSizes.push({ width: x1 - x0, height: y1 - y0 });
  }
  const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
  const { text } = await extractText(doc, { mergePages: false });
  const pageTexts = text.map(collapse);
  const { links } = await extractLinks(doc);
  const { info } = await getMeta(doc);
  return {
    pageSizes,
    pageTexts,
    text: pageTexts.join(' '),
    links,
    title: typeof info.Title === 'string' ? info.Title : undefined,
  };
}
