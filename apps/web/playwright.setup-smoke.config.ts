import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { parse } from 'dotenv';

/** The files `scripts/dev.sh` reads the app origin from, in its order. */
const APP_URL_OVERRIDE_FILES = [
  '.env.development.local',
  '.env.local',
  '../../.env.development.local',
  '../../.env.local',
];

/** The origin `APP_URL_OVERRIDE` names, normalised the way `resolveAppUrl` does. */
function appUrlOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/**
 * The `APP_URL_OVERRIDE` the dev stack for this worktree runs with.
 *
 * `scripts/dev.sh` exports its copy into the `next dev` process only, and
 * Playwright loads no dotenv file, so a value that lives in `.env.local` never
 * reaches this process on its own. Read the same files in the same order, so a
 * worktree that points the override at a LAN IP or 127.0.0.1 still matches the
 * origin the server canonicalises to.
 */
function appUrlOverrideFor(
  dir: string,
  env: Record<string, string | undefined>
): string | undefined {
  if (env.APP_URL_OVERRIDE) return env.APP_URL_OVERRIDE;
  for (const file of APP_URL_OVERRIDE_FILES) {
    const path = resolve(dir, file);
    if (!existsSync(path)) continue;
    let value: string | undefined;
    try {
      value = parse(readFileSync(path, 'utf-8')).APP_URL_OVERRIDE;
    } catch {
      continue;
    }
    if (value) return value;
  }
  return undefined;
}

/**
 * The base URL that drives the dev stack the smoke test runs against.
 *
 * The dev stack serves the origin its own env names: `resolveAppUrl` builds
 * every absolute auth redirect from APP_URL_OVERRIDE (`src/lib/constants`),
 * and a worktree's .env.local points that at a LAN IP for phone testing or at
 * 127.0.0.1 for the device harness. A NextAuth session cookie is host-scoped,
 * so browsing localhost while the server redirects to that other origin drops
 * the session mid-sign-in and profile.spec.ts spends its whole timeout in
 * page.waitForURL — the same localhost/127.0.0.1 trap playwright.config.ts
 * documents. Follow the origin the server canonicalises to; an explicit
 * PLAYWRIGHT_BASE_URL still wins.
 */
export function resolveBaseUrl(
  dir: string,
  env: Record<string, string | undefined> = process.env
): string {
  const port = env.PORT ? Number(env.PORT) : 3000;
  return (
    env.PLAYWRIGHT_BASE_URL ??
    appUrlOrigin(appUrlOverrideFor(dir, env)) ??
    `http://localhost:${port}`
  );
}

const baseURL = resolveBaseUrl(__dirname);

export default defineConfig({
  testDir: './tests/setup-smoke',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['html', { open: 'never' }],
        ['json', { outputFile: 'test-results/setup-smoke-results.json' }],
      ]
    : 'list',
  outputDir: 'test-results/setup-smoke',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'on-all-retries',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
