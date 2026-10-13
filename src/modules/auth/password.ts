import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/*
 * Password hashing with scrypt (node:crypto, no native deps).
 * Encoded format: "scrypt$N$r$p$<salt base64url>$<hash base64url>" so parameters can be raised
 * later without invalidating existing hashes.
 */

const SCHEME = 'scrypt';
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  { N, r, p }: Pick<ParsedHash, 'N' | 'r' | 'p'>,
): Promise<Buffer> {
  // scrypt needs ~128 * N * r bytes; leave headroom above that instead of the 32 MiB default.
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r };
  return new Promise((resolve, reject) => {
    // NFC so the same password typed on different OSes/keyboards hashes identically.
    scrypt(password.normalize('NFC'), salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await deriveKey(password, salt, KEY_BYTES, PARAMS);
  return [
    SCHEME,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/** Constant-time check. A malformed stored hash verifies as false instead of throwing. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const candidate = await deriveKey(password, parsed.salt, parsed.hash.length, parsed);
  return timingSafeEqual(candidate, parsed.hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same CPU time as a real verification. Called when the email is unknown so that
 * response timing does not reveal which emails have accounts.
 */
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummyHash);
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  // Bounded so that a corrupted row cannot make a login burn unbounded CPU/memory.
  const saneParams =
    Number.isInteger(N) &&
    N >= 2 ** 10 &&
    N <= 2 ** 17 &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= 16 &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= 4;
  if (!saneParams) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const hash = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < SALT_BYTES || hash.length < 32 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}
