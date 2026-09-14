import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/containers': fileURLToPath(
        new URL('./test/integration/mocks/cloudflare-containers.ts', import.meta.url)
      ),
    },
  },
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
