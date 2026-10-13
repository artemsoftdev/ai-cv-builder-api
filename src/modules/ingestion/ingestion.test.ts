import { describe, expect, it } from 'vitest';
import { makePdf, makeScannedPdf } from '../../../test/helpers/pdf.js';
import { extractPdfText, isPdf, PdfUnreadableError } from './pdf-text.js';
import { countNonWhitespace, normalizeSourceText } from './source-text.js';
import { safeFilename } from './upload.js';

const NUL = String.fromCharCode(0);
const RLO = String.fromCharCode(0x202e);
const COMBINING_ACUTE = String.fromCharCode(0x301);

describe('normalizeSourceText', () => {
  it('normalises line breaks, control characters, spaces and Unicode form', () => {
    const raw = `  Jane${NUL} Doe\r\n\r\n\r\n\r\nCaf${'e' + COMBINING_ACUTE}\t \tlead ${RLO}dev   \n   - item  `;
    expect(normalizeSourceText(raw)).toBe('Jane Doe\n\nCaf\u00e9 lead dev\n- item');
  });

  it('counts non-whitespace characters', () => {
    expect(countNonWhitespace(' a b\n c ')).toBe(3);
  });
});

describe('safeFilename', () => {
  it('keeps a printable base name only', () => {
    expect(safeFilename('C:\\Users\\jane\\CV 2024.pdf')).toBe('CV 2024.pdf');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename(`ev${RLO}il\n.pdf`)).toBe('evil .pdf');
    expect(safeFilename('Резюме.pdf')).toBe('Резюме.pdf');
    expect(safeFilename('x'.repeat(500))).toHaveLength(200);
    expect(safeFilename('')).toBeNull();
    expect(safeFilename(undefined)).toBeNull();
  });
});

describe('isPdf', () => {
  it('checks the magic bytes', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\n...'))).toBe(true);
    expect(isPdf(Buffer.from('PK\u0003\u0004 a zip'))).toBe(false);
    expect(isPdf(Buffer.alloc(0))).toBe(false);
  });
});

describe('extractPdfText', () => {
  it('reads the text layer of every page', async () => {
    const pdf = await makePdf([['Jane Doe', 'Backend Engineer at Acme'], ['Skills: Go, SQL']]);
    const result = await extractPdfText(pdf);
    expect(result.pages).toBe(2);
    expect(normalizeSourceText(result.text)).toBe(
      'Jane Doe\nBackend Engineer at Acme\nSkills: Go, SQL',
    );
  });

  it('reads Cyrillic text', async () => {
    const pdf = await makePdf([['Иван Петров', 'Разработчик в ООО Ромашка']], { unicode: true });
    expect(normalizeSourceText((await extractPdfText(pdf)).text)).toBe(
      'Иван Петров\nРазработчик в ООО Ромашка',
    );
  });

  it('returns link annotation targets', async () => {
    const pdf = await makePdf([['GitHub']], { hiddenLinkUrl: 'https://github.com/janedoe' });
    expect((await extractPdfText(pdf)).links).toEqual(['https://github.com/janedoe']);
  });

  it('returns an empty text layer for a scan', async () => {
    const result = await extractPdfText(await makeScannedPdf());
    expect(countNonWhitespace(result.text)).toBe(0);
  });

  it('rejects too many pages and damaged files with a user-facing message', async () => {
    const long = await makePdf(Array.from({ length: 3 }, (_, i) => [`Page ${i}`]));
    await expect(extractPdfText(long, { maxPages: 2 })).rejects.toThrow(
      new PdfUnreadableError('This PDF has 3 pages; at most 2 are supported.'),
    );
    const broken = Buffer.from('%PDF-1.7\nthis is not really a pdf');
    await expect(extractPdfText(broken)).rejects.toBeInstanceOf(PdfUnreadableError);
  });
});
