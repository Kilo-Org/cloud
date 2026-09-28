import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Worker-runtime tests for the deployed fake LLM: the Worker entry, the
// FakeLlmState Durable Object and the shared core, running in Miniflare.
// The Node-runtime semantics are covered by `test/unit` instead.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './test/fake-llm/wrangler.test.jsonc',
      },
    }),
  ],
  test: {
    name: 'fake-llm',
    include: ['test/fake-llm/**/*.test.ts'],
  },
});
