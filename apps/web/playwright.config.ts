import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
// Use localhost instead of 127.0.0.1 to match cookie domain
const baseURL = `http://localhost:${port}`;

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? 'html' : 'list',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    // Setup project - runs once to authenticate (doesn't use storageState)
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    // Chromatic requires Chrome for snapshotting
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /* Use authenticated state for all tests (except setup) */
        storageState: 'playwright/.auth/state.json',
        /* High resolution viewport for crisp screenshots */
        viewport: { width: 1920, height: 1080 },
        /* Device scale factor for retina-quality screenshots */
        deviceScaleFactor: 2,
      },
      dependencies: ['setup'],
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    // Always use dev mode for Playwright tests - never production
    command: `dotenvx run --convention=nextjs -- pnpm next dev -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      // Always use development mode for Playwright tests
      NODE_ENV: 'development',
      DEBUG_SHOW_DEV_UI: 'true', // Enable fake login
      PORT: String(port),
    },
  },
});
