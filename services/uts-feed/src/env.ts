import {
  UtsEnvironmentSchema,
  type SignerKeysBinding,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';

export type Env = {
  UTS_ENVIRONMENT: string;
  /** The mint Worker's `SignerKeys` entrypoint, bound with this Worker's name as `props.caller`. */
  UTS_SIGNER_KEYS: SignerKeysBinding;
};

export type FeedConfig = { environment: UtsEnvironment };

const EnvVarsSchema = z.object({ UTS_ENVIRONMENT: UtsEnvironmentSchema });

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): FeedConfig {
  return { environment: EnvVarsSchema.parse(env).UTS_ENVIRONMENT };
}
