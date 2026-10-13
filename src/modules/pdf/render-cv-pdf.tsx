import { renderToBuffer } from '@react-pdf/renderer';
import type { CvContent } from '../cvs/cv-content.schema.js';
import { CvDocument } from './cv-document.js';
import { registerDocumentFonts } from './fonts.js';
import { toPrintableCv } from './printable-cv.js';

export async function renderCvPdf(
  content: CvContent,
  { title }: { title: string },
): Promise<Buffer> {
  const fonts = registerDocumentFonts();
  try {
    return await renderToBuffer(
      <CvDocument cv={toPrintableCv(content)} title={title} fontFamily={fonts.family} />,
    );
  } finally {
    fonts.release();
  }
}
