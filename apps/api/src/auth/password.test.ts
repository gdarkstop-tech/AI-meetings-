import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  });

  it('never stores the plaintext and salts every hash', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toContain('same-password-123');
    expect(a).not.toBe(b);
  });

  it('normalizes unicode so an Arabic password verifies consistently', async () => {
    const hash = await hashPassword('كلمة-السر-القوية-2026');
    expect(await verifyPassword('كلمة-السر-القوية-2026', hash)).toBe(true);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('flags hashes with weaker parameters for rehash', async () => {
    expect(needsRehash(await hashPassword('abcdefghijkl'))).toBe(false);
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('bcrypt$10$abc')).toBe(true);
  });
});
