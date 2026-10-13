import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError, validationError } from '../../http/errors.js';
import { sanitizeLine } from '../../shared/text.js';
import { SOURCE_LIMITS } from './source-text.js';

const MAX_FILENAME_CHARS = 200;

// Limits apply while streaming, so an oversized upload is cut off rather than buffered.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SOURCE_LIMITS.pdfBytes,
    files: 1,
    fields: 4,
    parts: 5,
    // 20 000 characters of up to 4 UTF-8 bytes, plus slack for whitespace.
    fieldSize: 128 * 1024,
    fieldNameSize: 64,
    fieldNestingDepth: 0,
    headerPairs: 100,
  },
  // Browsers send non-ASCII file names as raw UTF-8 bytes.
  defParamCharset: 'utf8',
}).single('file');

export const parseCvUpload: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    next(validationError([{ path: '', message: 'Expected a multipart/form-data body' }]));
    return;
  }
  upload(req, res, (err: unknown) => {
    next(err === undefined ? undefined : toUploadError(err));
  });
};

function toUploadError(err: unknown): AppError {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new AppError('FILE_TOO_LARGE', 'The PDF must be at most 5 MB');
    }
    if (err.code === 'LIMIT_FIELD_VALUE' && err.field === 'text') {
      return new AppError('UNPROCESSABLE_SOURCE', 'The text is too long');
    }
    return validationError([{ path: err.field ?? '', message: err.message }]);
  }
  return validationError([{ path: '', message: 'Malformed multipart body' }]);
}

/** Shown back in the UI: a printable base name only. */
export function safeFilename(original: string | undefined): string | null {
  const base = (original ?? '').split(/[\\/]/).pop() ?? '';
  const clean = Array.from(sanitizeLine(base.normalize('NFC')))
    .slice(0, MAX_FILENAME_CHARS)
    .join('')
    .trim();
  return clean || null;
}
