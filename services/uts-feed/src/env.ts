import {
  UTS_ENDPOINTS,
  UtsEnvironmentSchema,
  type FeedReadsBinding,
  type SignerKeysBinding,
  type UtsEndpoints,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';

export type Env = {
  UTS_ENVIRONMENT: string;
  /**
   * The mint Worker's `SignerKeys` entrypoint, bound with this Worker's deployed name as
   * `props.caller`. Placement does not apply to a named entrypoint, so the read runs where this
   * Worker runs.
   */
  UTS_MINT: SignerKeysBinding;
  /**
   * The mint Worker's `FeedReads` entrypoint, bound the same way: the heads and lists of the two
   * feed objects, which only the mint Worker binds.
   */
  UTS_FEED_READS: FeedReadsBinding;
  /** This deployment's version; its id keeps the feed's cache entries private (src/revocation.ts). */
  CF_VERSION_METADATA: WorkerVersionMetadata;
};

export type FeedConfig = {
  environment: UtsEnvironment;
  endpoints: UtsEndpoints;
  /** A path segment no other Worker on the zone knows: this deployment's version id. */
  cacheSegment: string;
};

const EnvVarsSchema = z.object({
  UTS_ENVIRONMENT: UtsEnvironmentSchema,
  CF_VERSION_METADATA: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }),
});

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): FeedConfig {
  const vars = EnvVarsSchema.parse(env);
  return {
    environment: vars.UTS_ENVIRONMENT,
    endpoints: UTS_ENDPOINTS[vars.UTS_ENVIRONMENT],
    cacheSegment: vars.CF_VERSION_METADATA.id,
  };
}
