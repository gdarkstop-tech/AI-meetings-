import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@alia/core': r('./packages/core/src/index.ts'),
      '@alia/db': r('./packages/db/src/index.ts'),
      '@alia/observability': r('./packages/observability/src/index.ts'),
      '@alia/policy': r('./packages/policy/src/index.ts'),
      '@alia/providers': r('./packages/providers/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
