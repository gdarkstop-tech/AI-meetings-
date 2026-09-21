import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption for credentials at rest (OAuth tokens).
 *
 * AES-256-GCM with a random 12-byte IV per record. The key never leaves the
 * server process; ciphertext is the only thing the database holds, and no API
 * response or log line ever contains either (docs/03-security.md §4).
 */
const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

export class SecretKeyError extends Error {}

export function parseSecretKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new SecretKeyError('SECRETS_KEY is not set. Generate one with: openssl rand -base64 32');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new SecretKeyError('SECRETS_KEY must decode to exactly 32 bytes (base64 of 32 random bytes).');
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretKeyError('Malformed secret payload.');
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

/** Stable digest used for action payloads and idempotency keys. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
