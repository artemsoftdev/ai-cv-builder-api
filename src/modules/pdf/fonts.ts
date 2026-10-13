import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Font } from '@react-pdf/renderer';

// Same relative path from src/ and dist/; the image copies assets/ next to dist/.
const FONT_DIR = new URL('../../../assets/fonts/', import.meta.url);

const FONT_FACES = [
  { file: 'Inter-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
  { file: 'Inter-Bold.ttf', fontWeight: 700, fontStyle: 'normal' },
  { file: 'Inter-Italic.ttf', fontWeight: 400, fontStyle: 'italic' },
] as const;

const fontPath = (file: string) => fileURLToPath(new URL(file, FONT_DIR));

const LONG_WORD_CHARS = 30;
const LONG_WORD_CHUNK_CHARS = 16;
const URL_BREAK_RE = /(?<=[/\-_.?&=#,;])/;

/** Words are never hyphenated (English rules break names); only over-long tokens are split. */
export function breakOpportunities(word: string): string[] {
  if (Array.from(word).length <= LONG_WORD_CHARS) return [word];
  const parts: string[] = [];
  for (const segment of word.split(URL_BREAK_RE)) {
    const chars = Array.from(segment);
    for (let i = 0; i < chars.length; i += LONG_WORD_CHUNK_CHARS) {
      parts.push(chars.slice(i, i + LONG_WORD_CHUNK_CHARS).join(''));
    }
  }
  return parts;
}

let documentCount = 0;

export interface DocumentFonts {
  family: string;
  release: () => void;
}

/** Per document: a shared fontkit glyph cache broke "M" in PDFs rendered after a Cyrillic one. */
export function registerDocumentFonts(): DocumentFonts {
  documentCount += 1;
  const family = `Inter-${documentCount}`;
  Font.register({
    family,
    fonts: FONT_FACES.map(({ file, fontWeight, fontStyle }) => ({
      src: fontPath(file),
      fontWeight,
      fontStyle,
    })),
  });
  Font.registerHyphenationCallback(breakOpportunities);
  return {
    family,
    release: () => {
      delete Font.getRegisteredFonts()[family];
    },
  };
}

export async function assertPdfFontsReadable(): Promise<void> {
  await Promise.all(FONT_FACES.map(({ file }) => access(fontPath(file), constants.R_OK)));
}
