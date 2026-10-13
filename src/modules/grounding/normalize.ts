/*
 * Normalisation for matching generated text against the source. Both sides go through the
 * same function, so typography (curly quotes, dashes, ellipsis, full-width forms, case,
 * whitespace) never decides whether a claim is supported. Patterns are built from code points
 * so this file stays plain ASCII.
 */

const cls = (codePoints: string) => new RegExp(`[${codePoints}]`, 'g');

// Soft hyphen, zero-width space/joiners, word joiner, BOM.
const INVISIBLE_RE = cls('\\u00AD\\u200B-\\u200D\\u2060\\uFEFF');
// Curly/low single quotes, prime, backtick, acute accent.
const SINGLE_QUOTE_RE = cls('\\u2018-\\u201B\\u2032\\u0060\\u00B4');
// Curly/low double quotes, double prime, guillemets.
const DOUBLE_QUOTE_RE = cls('\\u201C-\\u201F\\u2033\\u00AB\\u00BB');
// Hyphens and dashes (U+2010..U+2015), minus sign, small/full-width hyphen-minus.
const DASH_RE = cls('\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D');
const ELLIPSIS_RE = cls('\\u2026');
const WHITESPACE_RE = /\s+/gu;
// Sentence punctuation and brackets around a phrase (not + or #: "C++", "C#").
const EDGE_PUNCTUATION = `[\\s.,;:!?'"()\\[\\]{}<>*\\-]+`;
const LEADING_PUNCT_RE = new RegExp(`^${EDGE_PUNCTUATION}`, 'u');
const TRAILING_PUNCT_RE = new RegExp(`${EDGE_PUNCTUATION}$`, 'u');
const WORD_RE = /[\p{L}\p{N}]+/gu;
// Separators that commonly vary inside one technical term: "Node.js" / "NodeJS", "CI/CD".
const COMPACT_SEPARATORS_RE = /[\s.\-_/]+/gu;

/** NFKC, lowercase, unified quotes/dashes/ellipsis, invisible characters removed, single spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(INVISIBLE_RE, '')
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

/** normalizeText plus surrounding punctuation removed: the form used for quotes and phrases. */
export function normalizePhrase(text: string): string {
  return stripEdgePunctuation(normalizeText(text));
}

/** Letter/digit runs of an already normalised string. */
export function wordsOf(normalized: string): string[] {
  return normalized.match(WORD_RE) ?? [];
}

/** A phrase without the separators that vary between spellings of the same term. */
export function compact(normalized: string): string {
  return normalized.replace(COMPACT_SEPARATORS_RE, '');
}

/**
 * Comparable form of a URL: no scheme, "mailto:", "www." or trailing slash, lowercase.
 * "https://www.GitHub.com/jane/" and "github.com/jane" compare equal.
 */
export function normalizeUrl(url: string): string {
  return stripEdgePunctuation(
    normalizeText(url)
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^mailto:/, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, ''),
  );
}
