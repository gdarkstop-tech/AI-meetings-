import { describe, expect, it } from 'vitest';
import { createLogger, redact, REDACTED } from './logger.js';

const capture = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

describe('structured logger', () => {
  it('never writes a secret passed under a sensitive key', () => {
    const { lines, write } = capture();
    const log = createLogger({ write, level: 'debug' });
    log.info('provider_call', { apiKey: 'sk-live-SUPERSECRETVALUE12345', password: 'hunter2hunter2' });
    const output = lines.join('\n');
    expect(output).not.toContain('SUPERSECRETVALUE');
    expect(output).not.toContain('hunter2hunter2');
    expect(output).toContain(REDACTED);
  });

  it('redacts secret-shaped values even under innocent keys', () => {
    const { lines, write } = capture();
    const log = createLogger({ write, level: 'debug' });
    log.info('connected', {
      note: 'using sk-abcdefghijklmnopqrstuvwxyz012345 for now',
      dsn: 'postgresql://user:p4ssw0rd@db.example.com:5432/app',
      auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
    });
    const output = lines.join('\n');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(output).not.toContain('p4ssw0rd');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('redacts secrets inside nested structures and messages', () => {
    const { lines, write } = capture();
    const log = createLogger({ write, level: 'debug' });
    log.error('failed with sk-abcdefghijklmnopqrstuvwxyz012345', {
      request: { headers: { authorization: 'Bearer abc123def456ghi' }, nested: { token: 'secret-token' } },
    });
    const output = lines.join('\n');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('abc123def456ghi');
  });

  it('emits one JSON object per line with level, timestamp and message', () => {
    const { lines, write } = capture();
    createLogger({ write, level: 'info', base: { app: 'api' } }).info('hello', { userId: 'u1' });
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ level: 'info', msg: 'hello', app: 'api', userId: 'u1' });
    expect(typeof parsed.ts).toBe('string');
  });

  it('respects the configured level', () => {
    const { lines, write } = capture();
    const log = createLogger({ write, level: 'warn' });
    log.debug('noise');
    log.info('noise');
    log.warn('kept');
    expect(lines).toHaveLength(1);
  });

  it('carries child fields', () => {
    const { lines, write } = capture();
    createLogger({ write, level: 'info' }).child({ requestId: 'r-1' }).info('done');
    expect(JSON.parse(lines[0]).requestId).toBe('r-1');
  });

  it('redact() handles errors and cycles without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(redact(new Error('boom sk-abcdefghijklmnopqrstuvwxyz012345'))).toMatchObject({ name: 'Error' });
  });
});
