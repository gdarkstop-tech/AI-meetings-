import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 14),
  // Rate limits are configuration, not code. Defaults are the production values;
  // only the registration limit is raised in the test environment so a suite can
  // create many accounts. Login limits stay at their real values and are tested.
  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_REGISTER_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60_000),
  RATE_LIMIT_AI_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_AI_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** 32 random bytes, base64. Required: integration tokens are encrypted with it. */
  SECRETS_KEY: z.string().min(1, 'SECRETS_KEY is required (openssl rand -base64 32)'),
  /** Public HTTPS origin, required for OAuth callbacks. */
  PUBLIC_BASE_URL: z.string().optional(),
  METRICS_TOKEN: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024 * 1024),
  UPLOAD_CHUNK_SIZE: z.coerce.number().int().positive().default(8 * 1024 * 1024),
});

export type Config = z.infer<typeof schema> & { isProduction: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' };
}
