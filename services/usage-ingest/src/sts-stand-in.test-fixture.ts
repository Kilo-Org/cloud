import { fileURLToPath } from 'node:url';

/** The prefix of every token the stand-in issues; never a real credential. */
export const STS_STAND_IN_TOKEN = 'sts-stand-in-token';

/**
 * The opaque token the stand-in issues for one requested audience and scope. It records the
 * request in the token, so a test reads from the writer's `Authorization` header which audience and
 * scope the Worker asked STS for.
 */
export function stsStandInToken(audience: string, scope: string): string {
  return `${STS_STAND_IN_TOKEN}|${audience}|${scope}`;
}

/**
 * A test harness worker entry for the STS service that the committed wrangler.jsonc binds in
 * `env` (queue-budget.test.ts pins both names). Add it beside the committed config. Its
 * `SecretsBroker` issues `stsStandInToken(audience, scope)`, so an environment whose writer runs
 * `sts` sends.
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
