import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt (memory-hard, Node core, no native build step).
 * ADR 0004 records why scrypt and not argon2id for Phase 1, and the migration
 * path: the stored format is versioned, so `needsRehash` can move users later.
 */
const ALGO = 'scrypt';
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN);
  return [ALGO, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGO) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when the stored hash uses weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const [algo, n, r, p] = stored.split('$');
  return algo !== ALGO || Number(n) < N || Number(r) < R || Number(p) < P;
}
