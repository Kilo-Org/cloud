import { defineConfig } from 'vitest/config';

export default defineConfig({
  assetsInclude: ['**/*.sql'],
  test: {
    name: 'postgres',
    environment: 'node',
    setupFiles: ['./test/unit-setup.ts'],
    include: ['test/postgres/**/*.test.ts'],
  },
});
