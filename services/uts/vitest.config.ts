import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  test: {
    include: ['test/unit/**/*.test.ts', 'test/runtime/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
