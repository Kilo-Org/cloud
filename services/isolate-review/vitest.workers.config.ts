import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { unstable_readConfig, type Unstable_Config } from 'wrangler';

process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
process.env.WRANGLER_SEND_METRICS = 'false';

const config = unstable_readConfig({
  config: fileURLToPath(new URL('./wrangler.test.jsonc', import.meta.url)),
}) as Unstable_Config;

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: config.main,
      remoteBindings: false,
      miniflare: {
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        modulesRules: config.rules.map(({ type, globs, fallthrough }) => ({
          type,
          include: globs,
          fallthrough,
        })),
        bindings: config.vars,
        durableObjects: Object.fromEntries(
          config.durable_objects.bindings.map(({ name, class_name }) => [
            name,
            { className: class_name, useSQLite: true },
          ])
        ),
        outboundService: () => {
          throw new Error('Unexpected outbound request in isolate-review tests');
        },
      },
    }),
  ],
  test: {
    name: 'isolate-review',
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
