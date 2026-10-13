import { sanitizeLine } from '../../shared/text.js';

const MAX_NAME_CHARS = 100;
const FALLBACK_NAME = 'CV';
const UNSAFE_FILENAME_CHARS_RE = /[<>:"/\\|?*]/g;
const NON_ASCII_RE = /[^ -~]/g;
const COMBINING_MARKS_RE = /\p{M}/gu;

export function cvFileBaseName(fullName: string, title: string): string {
  const parts = [fullName, title].map((part) => cleanName(part)).filter(Boolean);
  const unique = parts.filter((part, i) => parts.indexOf(part) === i);
  return cleanName(unique.join(' - ')) || FALLBACK_NAME;
}

/** ASCII `filename` for old clients, the exact UTF-8 name in `filename*` (RFC 8187). */
export function attachmentDisposition(baseName: string, extension: string): string {
  const name = cleanName(baseName) || FALLBACK_NAME;
  const ascii = asciiFallback(name);
  return `attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${encodeRfc8187(`${name}.${extension}`)}`;
}

function cleanName(value: string): string {
  const cleaned = sanitizeLine(value.normalize('NFC'))
    .replace(UNSAFE_FILENAME_CHARS_RE, ' ')
    .replace(/\s+/g, ' ');
  return trimEdges(Array.from(cleaned).slice(0, MAX_NAME_CHARS).join(''));
}

function asciiFallback(name: string): string {
  const ascii = trimEdges(
    name
      .normalize('NFKD')
      .replace(COMBINING_MARKS_RE, '')
      .replace(NON_ASCII_RE, '')
      .replace(/\s+/g, ' '),
  );
  return /[A-Za-z0-9]/.test(ascii) ? ascii : FALLBACK_NAME;
}

function trimEdges(value: string): string {
  return value.replace(/^[\s._-]+|[\s._-]+$/g, '');
}

function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
