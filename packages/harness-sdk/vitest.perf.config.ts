import { defineConfig } from 'vitest/config';
import ttsc from '@ttsc/unplugin/vite';

// The timing gate. Its ceilings are about five times the recorded numbers, so
// it catches a regression in order of magnitude and not a busy machine.
export default defineConfig({
  plugins: [ttsc()],
  test: {
    include: ['src/**/*.perf.test.ts'],
    environment: 'node',
    // One file at a time: parallel workers compete for the CPU being measured.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
