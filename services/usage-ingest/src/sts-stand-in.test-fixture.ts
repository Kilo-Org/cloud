import { fileURLToPath } from 'node:url';

/** The opaque token the stand-in issues for every requested scope; never a real credential. */
export const STS_STAND_IN_TOKEN = 'sts-stand-in-token';

/**
 * A test harness worker entry for the STS service that the committed wrangler.jsonc binds in
 * `env` (queue-budget.test.ts pins both names). Add it beside the committed config. Its
 * `SecretsBroker` issues `STS_STAND_IN_TOKEN`, so an environment whose writer runs `sts` sends.
 */
export function stsStandIn(env?: string) {
  return {
    config: {
      name: env === 'staging' ? 'sts-staging' : 'sts',
      main: fileURLToPath(new URL('./sts-stand-in.runtime-fixture.ts', import.meta.url).href),
      compatibility_date: '2026-09-18',
      vars: { STAND_IN_TOKEN: STS_STAND_IN_TOKEN },
    },
  };
}
