import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '../../apps/web/src'),
      'cloudflare:workers': resolve(
        import.meta.dirname,
        'src/test-support/cloudflare-workers-stub.ts'
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
