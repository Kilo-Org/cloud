import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

// Integration tests - run in Cloudflare Workers runtime via Miniflare
export default defineWorkersProject({
  test: {
    name: 'integration',
    globals: true,
    include: ['test/integration/**/*.test.ts'],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: './wrangler.test.jsonc',
        },
      },
    },
  },
});
