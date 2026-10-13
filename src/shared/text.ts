/*
 * Text normalisation for untrusted strings (user input and LLM output alike).
 * Control characters can break PDF rendering and log lines; bidi overrides can visually
 * reorder text (spoofing). ZWJ/ZWNJ are kept: some scripts and emoji need them.
 */

// Built from code points so the source stays plain ASCII.
const STRIP_RE = new RegExp(
  [
    '[',
    // C0 controls except \t (09), \n (0A) and \r (0D), which are normalised separately.
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F',
    // DEL and C1 controls.
    '\\u007F-\\u009F',
    // Bidi embeddings/overrides (LRE..RLO) and isolates (LRI..PDI).
    '\\u202A-\\u202E\\u2066-\\u2069',
    // Byte order mark / zero width no-break space.
    '\\uFEFF',
    ']',
  ].join(''),
  'g',
);
// CRLF, lone CR, and the Unicode line/paragraph separators.
const LINE_BREAK_RE = new RegExp('\\r\\n?|\\u2028|\\u2029', 'g');

/** Single-line text: every line break or tab becomes a space, then space runs collapse. */
export function sanitizeLine(value: string): string {
  return value
    .replace(STRIP_RE, '')
    .replace(LINE_BREAK_RE, '\n')
    .replace(/[\t\n]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Multi-line text: keeps `\n` (normalising CRLF), drops other control characters. */
export function sanitizeMultiline(value: string): string {
  return value
    .replace(STRIP_RE, '')
    .replace(LINE_BREAK_RE, '\n')
    .replace(/\t/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
