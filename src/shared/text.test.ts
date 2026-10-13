import { describe, expect, it } from 'vitest';
import { sanitizeLine, sanitizeMultiline } from './text.js';

const BELL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const RLO = String.fromCharCode(0x202e); // right-to-left override
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const ZWJ = String.fromCharCode(0x200d);

describe('sanitizeLine', () => {
  it('turns line breaks and tabs into single spaces and trims', () => {
    expect(sanitizeLine('  Senior\r\nBackend\tEngineer\n  ')).toBe('Senior Backend Engineer');
    expect(sanitizeLine(`a${LINE_SEPARATOR}b`)).toBe('a b');
  });

  it('strips control characters and bidi overrides', () => {
    expect(sanitizeLine(`Ac${BELL}me${NUL} ${RLO}Corp`)).toBe('Acme Corp');
  });

  it('keeps non-Latin text and joiners', () => {
    expect(sanitizeLine('Иван Петров')).toBe('Иван Петров');
    expect(sanitizeLine(`a${ZWJ}b`)).toBe(`a${ZWJ}b`);
  });
});

describe('sanitizeMultiline', () => {
  it('keeps newlines, normalising CRLF and collapsing blank runs', () => {
    expect(sanitizeMultiline('Line one\r\nLine two\r\n\r\n\r\n\r\nLine three')).toBe(
      'Line one\nLine two\n\nLine three',
    );
  });

  it('strips control characters and trailing spaces before newlines', () => {
    expect(sanitizeMultiline(`Hello${BELL}   \n\tworld  `)).toBe('Hello\n world');
  });
});
