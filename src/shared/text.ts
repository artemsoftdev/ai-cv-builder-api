// Controls, bidi and invisible format characters, Unicode tags (hidden text); ZWJ/ZWNJ stay.
const STRIP_RE = new RegExp(
  [
    '[',
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F',
    '\\u061C\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069',
    '\\uFEFF\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}',
    ']',
  ].join(''),
  'gu',
);
const LINE_BREAK_RE = new RegExp('\\r\\n?|\\u2028|\\u2029', 'g');

export function sanitizeLine(value: string): string {
  return value
    .replace(STRIP_RE, '')
    .replace(LINE_BREAK_RE, '\n')
    .replace(/[\t\n]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function sanitizeMultiline(value: string): string {
  return value
    .replace(STRIP_RE, '')
    .replace(LINE_BREAK_RE, '\n')
    .replace(/\t/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
