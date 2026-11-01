import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests - run in Node (fast, supports vi.mock and global mocking)
export default defineConfig({
  resolve: {
    // Worker modules import the runtime binding for their Durable Object
    // base class. Unit tests never instantiate one, so a plain class stands
    // in for it and the modules stay importable in Node.
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/test-support/cloudflare-workers.ts', import.meta.url)
      ),
    },
  },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    exclude: ['test/integration/**/*.test.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
  },
});
