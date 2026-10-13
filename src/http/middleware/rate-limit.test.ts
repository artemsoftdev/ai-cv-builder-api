import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { emailKey } from './rate-limit.js';

const request = (body: unknown, ip = '203.0.113.7') => ({ body, ip }) as unknown as Request;

describe('emailKey', () => {
  it('keys credentials by the normalised email address', () => {
    expect(emailKey(request({ email: ' Jane@Example.COM ' }))).toBe('email:jane@example.com');
    expect(emailKey(request({ email: 'jane@example.com' }, '198.51.100.1'))).toBe(
      'email:jane@example.com',
    );
  });

  it('falls back to the client IP for bodies without an email', () => {
    for (const body of [undefined, {}, { email: '' }, { email: 42 }, 'text']) {
      expect(emailKey(request(body))).toBe('ip:203.0.113.7');
    }
  });
});
