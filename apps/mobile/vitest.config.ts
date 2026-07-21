import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'cloud-agent-sdk/message-id': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/message-id.ts', import.meta.url)
      ),
      'cloud-agent-sdk/context-usage': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/context-usage.ts', import.meta.url)
      ),
      'cloud-agent-sdk/cli-model': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/cli-model.ts', import.meta.url)
      ),
      'cloud-agent-sdk/remote-model-order': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/remote-model-order.ts', import.meta.url)
      ),
      'cloud-agent-sdk/remote-command-catalog': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/remote-command-catalog.ts', import.meta.url)
      ),
      // kilocode_change - K1/C2: narrow subpaths for the `kilo remote` spawn
      // hook. These two files have a self-contained import graph (schemas,
      // base-connection, runtime, types — no `@/...` web-app-alias imports),
      // unlike the full barrel (`cloud-agent-sdk` below), which transitively
      // pulls in `cloud-agent-connection.ts` -> `cloud-agent-transport.ts` ->
      // `@/lib/cloud-agent-next/event-types`, a web-only `@` alias that does
      // not resolve under the mobile app's own `@` alias. Runtime imports of
      // `CommandDeliveredError`/`UserWebCommandError`/`createRemoteSessionOnConnection`
      // must go through these subpaths, not the barrel.
      'cloud-agent-sdk/user-web-connection': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/user-web-connection.ts', import.meta.url)
      ),
      'cloud-agent-sdk/create-session': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/create-session.ts', import.meta.url)
      ),
      'cloud-agent-sdk/preparation-attempts': fileURLToPath(
        new URL('../../apps/web/src/lib/cloud-agent-sdk/preparation-attempts.ts', import.meta.url)
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
      'src/lib/agent-attachments/**/*.test.ts',
      'src/lib/auth/**/*.test.ts',
      'src/lib/apple-iap/**/*.test.ts',
      'src/lib/apple-iap/**/*.test.tsx',
      'src/lib/hooks/**/*.test.ts',
      'src/lib/kilo-pass/**/*.test.ts',
      'src/lib/kilo-pass/**/*.test.tsx',
      'src/lib/onboarding/**/*.test.ts',
      'src/lib/pr-review/**/*.test.ts',
      'src/lib/voice-input/**/*.test.ts',
      'src/components/**/*.test.ts',
    ],
  },
});
