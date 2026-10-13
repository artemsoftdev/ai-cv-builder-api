import { describe, expect, it } from 'vitest';
import { assertPdfFontsReadable, breakOpportunities } from './fonts.js';

describe('breakOpportunities', () => {
  it('never splits ordinary words', () => {
    expect(breakOpportunities('Kubernetes')).toEqual(['Kubernetes']);
    expect(breakOpportunities('высоконагруженных')).toEqual(['высоконагруженных']);
  });

  it('splits very long tokens after URL punctuation, then into chunks', () => {
    const url = 'https://example.com/projects/payments-platform?tab=overview';
    const parts = breakOpportunities(url);
    expect(parts.join('')).toBe(url);
    expect(parts).toEqual([
      'https:/',
      '/',
      'example.',
      'com/',
      'projects/',
      'payments-',
      'platform?',
      'tab=',
      'overview',
    ]);
    expect(breakOpportunities('a'.repeat(40))).toEqual([
      'a'.repeat(16),
      'a'.repeat(16),
      'a'.repeat(8),
    ]);
  });

  it('never cuts a surrogate pair', () => {
    const word = '😀'.repeat(40);
    expect(breakOpportunities(word).every((part) => Array.from(part).length <= 16)).toBe(true);
    expect(breakOpportunities(word).join('')).toBe(word);
  });
});

describe('assertPdfFontsReadable', () => {
  it('finds the bundled font files', async () => {
    await expect(assertPdfFontsReadable()).resolves.toBeUndefined();
  });
});
