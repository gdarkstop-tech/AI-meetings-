import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke tests against the real API and the real database.
 * Run with: npm run test:e2e  (requires DATABASE_URL and a running migration)
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    // Use a pre-installed Chromium when the environment provides one
    // (PLAYWRIGHT_CHROMIUM_PATH), instead of downloading a browser.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
    screenshot: 'only-on-failure',
    locale: 'en-GB',
  },
  reporter: [['list']],
  workers: 1,
});
