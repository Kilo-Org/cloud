import { defineConfig } from 'vitest/config';
import ttsc from '@ttsc/unplugin/vite';

// The tests import source, and typia's checks only exist after its transform runs.
// Without this plugin every `typia.*` call throws "no transform has been configured".
export default defineConfig({
  plugins: [ttsc()],
  test: {
    include: ['src/**/*.test.ts'],
    // The timing tests are a separate gate: `pnpm test:perf`.
    exclude: ['src/**/*.perf.test.ts'],
    environment: 'node',
  },
});
