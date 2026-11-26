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
};

export type FeedConfig = { environment: UtsEnvironment; endpoints: UtsEndpoints };

const EnvVarsSchema = z.object({ UTS_ENVIRONMENT: UtsEnvironmentSchema });

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): FeedConfig {
  const environment = EnvVarsSchema.parse(env).UTS_ENVIRONMENT;
  return { environment, endpoints: UTS_ENDPOINTS[environment] };
}
