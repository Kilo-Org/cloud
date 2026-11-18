import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Integration tests - run in the Workers runtime via Miniflare, so the Durable
// Object, its SQLite database and its alarms are the real ones.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.test.jsonc',
      },
    }),
  ],
  test: {
    name: 'integration',
    globals: true,
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['test/integration/setup.ts'],
  },
});
