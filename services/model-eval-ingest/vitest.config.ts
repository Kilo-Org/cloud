import { defineConfig } from 'vitest/config';

// Unit tests run in Node — fast, supports global mocks, no Workers runtime.
// (No integration suite yet; Hyperdrive + Secrets Store don't have local
// stand-ins that add much value over what the unit tests already cover.)
export default defineConfig({
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
