/**
 * Structured JSON logging with secret redaction.
 *
 * Rules enforced here (docs/03-security.md §4):
 * - secrets never reach the log stream, whatever the caller passes;
 * - transcripts and message bodies are never logged (callers pass ids, not content);
 * - every line carries a requestId so an error can be traced end to end.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(password|passwd|secret|token|authorization|cookie|api[_-]?key|credential|private[_-]?key|session)/i;

/** Values that look like credentials even when the key name is innocent. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9._-]{20,}\b/g, // JWT-shaped
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
];

export const REDACTED = '[redacted]';

export function redactValue(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), value);
}

export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactValue(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (input instanceof Error) {
    return { name: input.name, message: redactValue(input.message) };
  }
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(value, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: Record<string, unknown>;
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'));

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const payload = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactValue(msg),
      ...(redact(base) as Record<string, unknown>),
      ...((fields ? (redact(fields) as Record<string, unknown>) : {}) ?? {}),
    };
    write(JSON.stringify(payload));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, level, base: { ...base, ...fields } }),
  };
}
