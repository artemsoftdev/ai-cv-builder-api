import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.js';

describe('session tokens', () => {
  it('generates 32 random bytes as base64url (43 chars)', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(isWellFormedSessionToken(token)).toBe(true);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateSessionToken));
    expect(tokens.size).toBe(1000);
  });

  it('hashes with SHA-256 to lowercase hex', () => {
    expect(hashSessionToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(generateSessionToken()));
  });

  it.each(['', 'short', 'x'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}/`])(
    'rejects malformed cookie values (%j)',
    (value) => {
      expect(isWellFormedSessionToken(value)).toBe(false);
    },
  );
});
