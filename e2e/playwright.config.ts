/**
 * Kilo Cloud UI tests. The app under test is a locally started `apps/web` (`pnpm dev:start` from the
 * repo root, or `ci/start-web.mjs` in the CI job); this package never starts it itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnacondaConfigDefaults, AnacondaProjectDefaults } from '@anaconda/playwright-utils';
import { defineConfig, devices } from '@playwright/test';

/** `pnpm dev:start` serves on 3000 + the worktree's port offset, the stack whose database `.env.local` names. */
function localAppUrl(): string {
  const offsetFile = resolve(__dirname, '../dev/logs/port-offset');
  const offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, 'utf8').trim()) : 0;
  return `http://localhost:${3000 + (Number.isInteger(offset) && offset > 0 ? offset : 0)}`;
}

export const BASE_URL = process.env.URL ?? localAppUrl();

export default defineConfig({
  ...AnacondaConfigDefaults,
  testDir: './tests/specs',
  // `next dev` compiles routes on first hit and slows down under many parallel sign-ins.
  workers: process.env.CI ? 2 : 4,
  use: {
    ...AnacondaProjectDefaults,
    // The defaults add Cloudflare Access headers (for Anaconda's CF-protected envs) to every browser
    // request, third-party origins included. Kilo's local app isn't behind CF Access, so send none.
    extraHTTPHeaders: {},
    trace: process.env.CI ? { mode: 'retain-on-failure', sources: false } : 'retain-on-failure',
    screenshot: 'only-on-failure',
    baseURL: BASE_URL,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
