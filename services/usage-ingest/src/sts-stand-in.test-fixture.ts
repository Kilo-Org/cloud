import { fileURLToPath } from 'node:url';

/**
 * A test harness worker entry for the STS service that the committed wrangler.jsonc binds in
 * `env` (queue-budget.test.ts pins both names). Add it beside the committed config.
 */
export function stsStandIn(env?: string) {
  return {
    config: {
      name: env === 'staging' ? 'sts-staging' : 'sts',
      main: fileURLToPath(new URL('./sts-stand-in.runtime-fixture.ts', import.meta.url).href),
      compatibility_date: '2026-09-18',
    },
  };
}
