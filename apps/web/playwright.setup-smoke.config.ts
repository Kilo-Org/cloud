import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

/** The origin `APP_URL_OVERRIDE` names, normalised the way `resolveAppUrl` does. */
function appUrlOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

// The dev stack serves the origin its own env names: `resolveAppUrl` builds
// every absolute auth redirect from APP_URL_OVERRIDE (`src/lib/constants`),
// and a worktree's .env.local points that at a LAN IP for phone testing or at
// 127.0.0.1 for the device harness. A NextAuth session cookie is host-scoped,
// so browsing localhost while the server redirects to that other origin drops
// the session mid-sign-in and profile.spec.ts spends its whole timeout in
// page.waitForURL — the same localhost/127.0.0.1 trap playwright.config.ts
// documents. Follow the origin the server canonicalises to; an explicit
// PLAYWRIGHT_BASE_URL still wins.
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  appUrlOrigin(process.env.APP_URL_OVERRIDE) ??
  `http://localhost:${port}`;

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
