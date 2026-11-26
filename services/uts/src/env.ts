import {
  UTS_ENDPOINTS,
  UtsEnvironmentSchema,
  type UtsEndpoints,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { UtsKeySetDO } from './dos/UtsKeySetDO';
import type { UtsSignerDO } from './dos/UtsSignerDO';
import type { UtsFeedDO } from './feed/UtsFeedDO';

/**
 * Production and staging keep every UTS Durable Object in the `eu` jurisdiction (design 5.7).
 * workerd enforces no residency, so `wrangler dev` and the test pool run unscoped.
 */
const EnvVarsSchema = z
  .object({
    UTS_ENVIRONMENT: UtsEnvironmentSchema,
    DO_JURISDICTION: z.enum(['eu', 'none']),
  })
  .refine(
    vars => (vars.UTS_ENVIRONMENT === 'development') === (vars.DO_JURISDICTION === 'none'),
    'production and staging pin Durable Objects to the eu jurisdiction; only development runs unscoped'
  );

export type UtsConfig = {
  environment: UtsEnvironment;
  endpoints: UtsEndpoints;
  jurisdiction: 'eu' | 'none';
};

export type Env = {
  UTS_ENVIRONMENT: string;
  DO_JURISDICTION: string;
  UTS_SIGNER_DO: DurableObjectNamespace<UtsSignerDO>;
  UTS_KEY_SET_DO: DurableObjectNamespace<UtsKeySetDO>;
  /**
   * The two revocation-feed objects. Only this Worker binds them, so only it writes entries; the
   * feed Worker reads heads and lists through the `FeedReads` entrypoint (src/feed/reads.ts).
   */
  UTS_FEED_DO: DurableObjectNamespace<UtsFeedDO>;
  /**
   * The identity store's primary Hyperdrive config, bound once the environment's identity store is
   * provisioned. `identityStoreBinding` (src/grants/binding.ts) is the only reader.
   */
  IDENTITY_STORE?: Hyperdrive;
};

/** The mint Worker's deployed name in each environment. */
export const MINT_DEPLOYMENTS: Readonly<Record<UtsEnvironment, string>> = {
  production: 'uts',
  staging: 'uts-staging',
  development: 'uts-local',
};

/**
 * The feed Worker's deployed name in each environment. It is the only caller the `SignerKeys`
 * entrypoint answers, and the `props.caller` its binding carries.
 */
export const FEED_DEPLOYMENTS: Readonly<Record<UtsEnvironment, string>> = {
  production: 'uts-feed',
  staging: 'uts-feed-staging',
  development: 'uts-feed-local',
};

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): UtsConfig {
  const vars = EnvVarsSchema.parse(env);
  return {
    environment: vars.UTS_ENVIRONMENT,
    endpoints: UTS_ENDPOINTS[vars.UTS_ENVIRONMENT],
    jurisdiction: vars.DO_JURISDICTION,
  };
}
