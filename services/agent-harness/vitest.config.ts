import { existsSync } from 'node:fs';
import { URL } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The deployment config arrives with the Worker entrypoint, not before it.
      wrangler: existsSync(new URL('./wrangler.jsonc', import.meta.url))
        ? { configPath: './wrangler.jsonc' }
        : undefined,
      remoteBindings: false,
      miniflare: { compatibilityDate: '2026-06-05', compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
  test: { include: ['src/**/*.test.ts'], passWithNoTests: true },
});
