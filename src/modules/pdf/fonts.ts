import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Font } from '@react-pdf/renderer';

/**
 * Inter 4.001 (SIL OFL 1.1, see assets/fonts/OFL.txt): Latin, Cyrillic and Greek. The files
 * live in the repo-root `assets/fonts`, which is the same relative location from `src/` (tsx,
 * vitest) and from `dist/` (compiled), and is copied next to `dist` in the Docker image.
 */
const FONT_DIR = new URL('../../../assets/fonts/', import.meta.url);

const FONT_FACES = [
  { file: 'Inter-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
  { file: 'Inter-Bold.ttf', fontWeight: 700, fontStyle: 'normal' },
  { file: 'Inter-Italic.ttf', fontWeight: 400, fontStyle: 'italic' },
] as const;

const fontPath = (file: string) => fileURLToPath(new URL(file, FONT_DIR));

/** Longer than any natural word: URLs, file paths, "Go/Kafka/Kubernetes/Terraform" lists. */
const LONG_WORD_CHARS = 30;
const LONG_WORD_CHUNK_CHARS = 16;
// Break after URL/path punctuation first, so wrapped links stay readable.
const URL_BREAK_RE = /(?<=[/\-_.?&=#,;])/;

/**
 * Hyphenation callback: the parts of a word where a line may break. Normal words are never
 * split (the default hyphenator applies English rules to every language and breaks names and
 * technology terms). Very long tokens are split, otherwise they would run off the page.
 */
export function breakOpportunities(word: string): string[] {
  if (Array.from(word).length <= LONG_WORD_CHARS) return [word];
  const parts: string[] = [];
  for (const segment of word.split(URL_BREAK_RE)) {
    // Code points, not UTF-16 units, so a surrogate pair is never cut in half.
    const chars = Array.from(segment);
    for (let i = 0; i < chars.length; i += LONG_WORD_CHUNK_CHARS) {
      parts.push(chars.slice(i, i + LONG_WORD_CHUNK_CHARS).join(''));
    }
  }
  return parts;
}

let documentCount = 0;

export interface DocumentFonts {
  /** Font family name to use in this document's styles. */
  family: string;
  /** Unregisters the family; call when the document has been rendered. */
  release: () => void;
}

/**
 * Registers a fresh instance of the font family for ONE document.
 *
 * Why not once per process: fontkit caches glyph objects per loaded font, and subsetting a
 * document caches the components of composite glyphs without their code points (Cyrillic
 * "М" is drawn from Latin "M"). A later document using "M" then got a wrong ToUnicode map
 * and, in some viewers, an invisible glyph. Parsing the font per document costs a few
 * milliseconds and shares no state between documents (or concurrent renders).
 */
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

/**
 * Fails fast at startup if the font files are missing (e.g. an image built without
 * `assets/`), instead of failing on the first PDF download.
 */
export async function assertPdfFontsReadable(): Promise<void> {
  await Promise.all(FONT_FACES.map(({ file }) => access(fontPath(file), constants.R_OK)));
}
