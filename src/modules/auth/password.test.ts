import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('encodes scheme, parameters, salt and hash', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    // 16-byte salt -> 22 base64url chars, 64-byte key -> 86 chars
    expect(encoded).toMatch(/^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', encoded)).resolves.toBe(true);
    await expect(verifyPassword('correct horse battery stapl', encoded)).resolves.toBe(false);
    await expect(verifyPassword('', encoded)).resolves.toBe(false);
  });

  it('uses a fresh salt for every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('treats canonically equivalent Unicode passwords as equal (NFC)', async () => {
    const composed = 'caf' + String.fromCharCode(0xe9); // e-acute as one code point
    const decomposed = 'cafe' + String.fromCharCode(0x301); // e + combining acute accent
    const encoded = await hashPassword(composed);
    await expect(verifyPassword(decomposed, encoded)).resolves.toBe(true);
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', 'bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA'],
    ['missing parts', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA'],
    ['N not a power of two', `scrypt$10000$8$1$${'A'.repeat(22)}$${'A'.repeat(86)}`],
    ['N too large (DoS)', `scrypt$${2 ** 24}$8$1$${'A'.repeat(22)}$${'A'.repeat(86)}`],
    ['short salt', `scrypt$16384$8$1$AAAA$${'A'.repeat(86)}`],
  ])('returns false for a malformed stored hash (%s)', async (_name, encoded) => {
    await expect(verifyPassword('whatever', encoded)).resolves.toBe(false);
  });

  it('can burn a dummy verification for unknown users', async () => {
    await expect(verifyAgainstDummyHash('whatever')).resolves.toBeUndefined();
  });
});
