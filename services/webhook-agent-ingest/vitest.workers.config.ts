import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
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
  },
});
