import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts, type PDFFont } from 'pdf-lib';

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
