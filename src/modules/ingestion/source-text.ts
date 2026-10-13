import { sanitizeMultiline } from '../../shared/text.js';

/** Limits from docs/API.md plus the PDF-specific ones. */
export const SOURCE_LIMITS = {
  /** Pasted text, in characters after normalisation. */
  textMin: 50,
  textMax: 20_000,
  /** Text extracted from (or transcribed off) a PDF. Longer sources are rejected, not cut. */
  extractedMax: 40_000,
  /** A text layer with fewer non-whitespace characters is treated as a scanned PDF. */
  scannedThreshold: 200,
  pdfBytes: 5 * 1024 * 1024,
  pdfPages: 10,
} as const;

/**
 * Canonical form of source text, stored and used as the grounding corpus: NFC, control
 * characters and bidi overrides removed, CRLF -> LF, tabs and space runs collapsed, at most one
 * blank line in a row, trimmed.
 */
export function normalizeSourceText(raw: string): string {
  return sanitizeMultiline(raw.normalize('NFC')).replace(/ {2,}/g, ' ').replace(/^ +/gm, '');
}

export function countNonWhitespace(text: string): number {
  return text.replace(/\s/g, '').length;
}
