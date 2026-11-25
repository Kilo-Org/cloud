import { env as runtimeEnv } from 'cloudflare:workers';
import { readConfig, type Env, type UtsConfig } from '../../src/env';

/** The bindings `wrangler.test.jsonc` adds for the tests: the mint Worker itself as three callers. */
export type TestEnv = Env & {
  FEED_MINT: Fetcher;
  OTHER_MINT: Fetcher;
  PROPLESS_MINT: Fetcher;
};

// The runtime env is untyped here; this binds it to the bindings `wrangler.test.jsonc` declares
// (the pattern services/sts/test/worker/test-env.ts uses).
export const env = runtimeEnv as TestEnv;

export const config: UtsConfig = readConfig(env);
