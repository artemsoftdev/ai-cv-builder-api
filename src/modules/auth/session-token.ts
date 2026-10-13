import { createHash, randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;
/** 32 bytes in base64url (no padding) are always 43 characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Opaque bearer token for the session cookie. Only its hash is persisted. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256 is enough here (no salt / slow hash): the token has 256 bits of entropy, so a leaked
 * sessions table cannot be brute-forced back into usable cookies.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap pre-check so garbage cookies never reach the database. */
export function isWellFormedSessionToken(value: string): boolean {
  return TOKEN_RE.test(value);
}
