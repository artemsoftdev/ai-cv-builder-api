import { sanitizeMultiline } from '../../shared/text.js';

export const SOURCE_LIMITS = {
  textMin: 50,
  textMax: 20_000,
  extractedMax: 40_000,
  /** Fewer non-whitespace characters in the text layer: a scan. */
  scannedThreshold: 200,
  pdfBytes: 5 * 1024 * 1024,
  pdfPages: 10,
} as const;

export function normalizeSourceText(raw: string): string {
  return sanitizeMultiline(raw.normalize('NFC')).replace(/ {2,}/g, ' ').replace(/^ +/gm, '');
}

export function countNonWhitespace(text: string): number {
  return text.replace(/\s/g, '').length;
}
