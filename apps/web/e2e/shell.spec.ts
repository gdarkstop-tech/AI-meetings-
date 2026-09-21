import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const PASSWORD = 'phase-one-password-2026';

test('registers, lands on the dashboard, and flips the whole layout to RTL', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.test`;

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.screenshot({ path: 'artifacts/01-login-en.png', fullPage: true });

  // Register through the real API.
  await page.getByRole('button', { name: /Need an account/i }).click();
  await page.getByLabel('Full name').fill('E2E Executive');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Dashboard renders data returned by the API, not placeholders.
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText('audit.read')).toBeVisible();
  await page.screenshot({ path: 'artifacts/02-dashboard-en.png', fullPage: true });

  // Honest capability reporting is visible to the user.
  await expect(page.getByText('Not configured').first()).toBeVisible();
  await expect(page.getByText(/Meetings are not implemented yet/i)).toBeVisible();

  // Language toggle flips document direction and language for the whole app.
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByText('لوحة التحكم')).toBeVisible();
  await page.screenshot({ path: 'artifacts/03-dashboard-ar-rtl.png', fullPage: true });

  // The preference persists server-side: reload keeps Arabic.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});
