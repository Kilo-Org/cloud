import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/mobile-mermaid-host',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/mobile-mermaid-host',
  use: {
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
