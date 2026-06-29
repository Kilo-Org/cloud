import { defineConfig } from '@playwright/test';

const isCi = process.env['CI'] !== undefined && process.env['CI'] !== '';

export default defineConfig({
  forbidOnly: isCi,
  reporter: isCi ? 'html' : 'list',
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  workers: 1,
});
