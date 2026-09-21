import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseSecretKey, sha256Hex, SecretKeyError } from './secrets.js';

const key = parseSecretKey(Buffer.alloc(32, 3).toString('base64'));

describe('credential encryption at rest', () => {
  it('round-trips a token', () => {
    const token = JSON.stringify({ accessToken: 'ya29.super-secret', refreshToken: '1//refresh' });
    const sealed = encryptSecret(token, key);
    expect(sealed).not.toContain('super-secret');
    expect(decryptSecret(sealed, key)).toBe(token);
  });

  it('produces a different ciphertext every time (random IV)', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('refuses a tampered ciphertext instead of returning garbage', () => {
    const sealed = encryptSecret('sensitive', key);
    const parts = sealed.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64')].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('refuses a wrong key', () => {
    const other = parseSecretKey(Buffer.alloc(32, 9).toString('base64'));
    expect(() => decryptSecret(encryptSecret('x', key), other)).toThrow();
  });

  it('rejects an absent or wrong-sized key with a helpful message', () => {
    expect(() => parseSecretKey(undefined)).toThrow(SecretKeyError);
    expect(() => parseSecretKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('hashes deterministically for payload digests', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
  });
});
