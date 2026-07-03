import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'cloud-agent-sdk/message-id': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/message-id.ts', import.meta.url)
      ),
      'cloud-agent-sdk/cli-model': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/cli-model.ts', import.meta.url)
      ),
      'cloud-agent-sdk': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    name: 'mobile-onboarding',
    environment: 'node',
    include: [
      'src/lib/*.test.ts',
      'src/lib/apple-iap/**/*.test.ts',
      'src/lib/apple-iap/**/*.test.tsx',
      'src/lib/kilo-pass/**/*.test.ts',
      'src/lib/kilo-pass/**/*.test.tsx',
      'src/lib/onboarding/**/*.test.ts',
      'src/components/**/*.test.ts',
    ],
  },
});
