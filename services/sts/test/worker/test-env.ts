import { env as runtimeEnv } from 'cloudflare:workers';
import { readConfig, type Env, type StsConfig } from '../../src/env';

/** Test-side binding of the runtime env to this worker's hand-written Env (same pattern as session-sync). */
export const env = runtimeEnv as Env;

export const config: StsConfig = readConfig(env);
