import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const PASSWORD = 'phase-one-password-2026';

/** Generate a real audio file so the upload path is exercised end to end. */
function makeAudioFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alia-e2e-'));
  const file = path.join(dir, 'meeting.ogg');
  execFileSync(ffmpegPath as unknown as string, [
    '-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=420:duration=3',
    '-ac', '1', '-ar', '16000', '-c:a', 'libopus', file,
  ]);
  return file;
}

test('register, create a meeting with consent, upload real audio, and flip to RTL', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.test`;

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.screenshot({ path: 'artifacts/01-login.png', fullPage: true });

  await page.getByRole('button', { name: /Need an account/i }).click();
  await page.getByLabel('Full name').fill('E2E Executive');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Dashboard renders live data from the API.
  await expect(page.getByRole('button', { name: 'Meetings' })).toBeVisible();
  await expect(page.getByText('Not configured').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/02-dashboard.png', fullPage: true });

  // Consent gate, then a real upload through the resumable chunk API.
  await page.getByRole('button', { name: 'Meetings' }).click();
  await page.getByLabel('Title').fill('Quarterly review — مراجعة الربع');
  await page.getByLabel('Spoken language').selectOption('mixed');
  await page.getByRole('checkbox').first().check();
  await page.setInputFiles('input[type="file"]', makeAudioFile());

  // The app navigates to the meeting once the upload completes.
  await page.waitForURL(/#\/meetings\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByText('Quarterly review — مراجعة الربع')).toBeVisible();
  await expect(page.locator('audio')).toBeVisible();
  // Transcription is not configured here, so the app must not claim a transcript.
  await expect(page.getByText('No transcript yet.')).toBeVisible();
  await page.screenshot({ path: 'artifacts/03-meeting.png', fullPage: true });

  // Approvals surface exists and is honest about having nothing pending.
  await page.getByRole('button', { name: 'Approvals' }).click();
  await expect(page.getByText('Nothing is waiting for approval.')).toBeVisible();

  // Settings shows real provider status, not decoration.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Require recording consent')).toBeVisible();
  await page.screenshot({ path: 'artifacts/04-settings.png', fullPage: true });

  // Language toggle flips the whole layout.
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByText('الخصوصية والاحتفاظ')).toBeVisible();
  await page.screenshot({ path: 'artifacts/05-settings-ar.png', fullPage: true });

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});
