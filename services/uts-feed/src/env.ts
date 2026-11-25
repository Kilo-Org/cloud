import { UtsEnvironmentSchema, type UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';

export type Env = {
  UTS_ENVIRONMENT: string;
  /**
   * The mint Worker's default entrypoint, bound with this Worker's deployed name as
   * `props.caller`. A fetch to it runs in the mint Worker's placed fetch handler.
   */
  UTS_MINT: Fetcher;
};

export type FeedConfig = { environment: UtsEnvironment };

const EnvVarsSchema = z.object({ UTS_ENVIRONMENT: UtsEnvironmentSchema });

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): FeedConfig {
  return { environment: EnvVarsSchema.parse(env).UTS_ENVIRONMENT };
}
