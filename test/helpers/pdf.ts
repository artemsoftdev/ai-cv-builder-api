import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import { extractLinks, extractText, getDocumentProxy, getMeta } from 'unpdf';

const require = createRequire(import.meta.url);

export interface PdfFixtureOptions {
  /** Embeds DejaVu Sans, needed for Cyrillic. */
  unicode?: boolean;
  hiddenLinkUrl?: string;
}

async function loadFont(doc: PDFDocument, unicode: boolean): Promise<PDFFont> {
  if (!unicode) return doc.embedFont(StandardFonts.Helvetica);
  doc.registerFontkit(fontkit);
  const fontPath = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
  return doc.embedFont(await readFile(fontPath), { subset: true });
}

export async function makePdf(
  pages: readonly (readonly string[])[],
  options: PdfFixtureOptions = {},
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await loadFont(doc, options.unicode ?? false);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
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

export async function makeFlateBombPdf(inflatedMb: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const key = page.node.newFontDictionary('F', font.ref);
  const op = `BT ${key.toString()} 12 Tf 50 700 Td (x) Tj ET\n`;
  const ops = op.repeat(Math.ceil((inflatedMb * 1024 * 1024) / op.length));
  const stream = doc.context.stream(deflateSync(Buffer.from(ops), { level: 9 }), {
    Filter: 'FlateDecode',
  });
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  return Buffer.from(await doc.save());
}

export async function makeScannedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 50, y: 600, width: 300, height: 150, color: rgb(0.2, 0.2, 0.2) });
  return Buffer.from(await doc.save());
}

export interface InspectedPdf {
  pageSizes: { width: number; height: number }[];
  /** Whitespace runs, line wraps included, collapsed. */
  pageTexts: string[];
  text: string;
  links: string[];
  title: string | undefined;
}

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
