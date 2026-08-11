import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // src/observability.ts imports `tracing` from cloudflare:workers, which only the
    // Workers runtime resolves. The workers-pool suite (vitest.workers.config.ts) gets
    // the real module; these node-environment tests get a pass-through stub.
    alias: {
      'cloudflare:workers': resolve(
        import.meta.dirname,
        'src/test-support/cloudflare-workers-stub.ts'
      ),
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
