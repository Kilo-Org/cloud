import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The real package imports `cloudflare:workers` (workerd-only). Unit
      // tests run in the node pool, so alias it to a node-safe stub. Tests
      // never instantiate the container DO; they only need the worker entry to
      // import cleanly.
      '@cloudflare/containers': resolve(__dirname, 'test/stubs/cloudflare-containers.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
