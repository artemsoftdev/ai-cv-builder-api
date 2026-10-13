// Both sides of every comparison go through these, so typography never decides support.
// Patterns are built from code points to keep the file ASCII.

const cls = (codePoints: string) => new RegExp(`[${codePoints}]`, 'gu');

const INVISIBLE_RE = cls(
  '\\u00AD\\u061C\\u200B-\\u200F\\u2060-\\u2064\\uFEFF\\u{E0000}-\\u{E007F}',
);
// Private-use icon glyphs and pictographs that PDFs glue to contact data (an envelope icon before an email).
const SYMBOL_RE = /[\p{Co}\p{So}]/gu;
const SINGLE_QUOTE_RE = cls('\\u2018-\\u201B\\u2032\\u0060\\u00B4');
const DOUBLE_QUOTE_RE = cls('\\u201C-\\u201F\\u2033\\u00AB\\u00BB');
const DASH_RE = cls('\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D');
const ELLIPSIS_RE = cls('\\u2026');
const WHITESPACE_RE = /\s+/gu;
// Not + or #: "C++", "C#".
const EDGE_PUNCTUATION = `[\\s.,;:!?'"()\\[\\]{}<>*\\-|/]+`;
const LEADING_PUNCT_RE = new RegExp(`^${EDGE_PUNCTUATION}`, 'u');
const TRAILING_PUNCT_RE = new RegExp(`${EDGE_PUNCTUATION}$`, 'u');
const WORD_RE = /[\p{L}\p{N}]+/gu;
const COMPACT_SEPARATORS_RE = /[\s.\-_/]+/gu;
// "b.sc.", "ph.d.", "m.a." -> "bsc", "phd", "ma"
const DOTTED_ABBREVIATION_RE =
  /(?<![\p{L}\p{N}])((?:\p{L}{1,3}\.){1,3}\p{L}{0,3})\.?(?![\p{L}\p{N}])/gu;

/** NFKC, lowercase, unified quotes/dashes/ellipsis, invisible characters and icons removed. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(INVISIBLE_RE, '')
    .replace(SYMBOL_RE, ' ')
    .replace(SINGLE_QUOTE_RE, "'")
    .replace(DOUBLE_QUOTE_RE, '"')
    .replace(DASH_RE, '-')
    .replace(ELLIPSIS_RE, '...')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

export function stripEdgePunctuation(text: string): string {
  return text.replace(LEADING_PUNCT_RE, '').replace(TRAILING_PUNCT_RE, '');
}

export function normalizePhrase(text: string): string {
  return stripEdgePunctuation(normalizeText(text));
}

/** Letter/digit runs of an already normalised string. */
export function wordsOf(normalized: string): string[] {
  return normalized.match(WORD_RE) ?? [];
}

export function compact(normalized: string): string {
  return normalized.replace(COMPACT_SEPARATORS_RE, '');
}

export function collapseAbbreviations(normalized: string): string {
  return normalized.replace(DOTTED_ABBREVIATION_RE, (match) => match.replaceAll('.', ''));
}

/** "https://www.GitHub.com/jane/" and "github.com/jane" compare equal. */
export function normalizeUrl(url: string): string {
  return stripEdgePunctuation(
    normalizeText(url)
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^mailto:/, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, ''),
  );
}

const isAsciiWord = (word: string) => /^[a-z0-9]+$/.test(word);

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Same word up to inflection. English only gets plural forms; other scripts (Cyrillic, German
 * umlauts) share a stem when they agree on all but their last two letters: "Москва"/"Москве",
 * "руководил"/"руководителем".
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (isAsciiWord(a) && isAsciiWord(b)) {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return long === `${short}s` || long === `${short}es`;
  }
  const shortest = Math.min(a.length, b.length);
  return shortest >= 4 && commonPrefixLength(a, b) >= Math.max(4, shortest - 2);
}
