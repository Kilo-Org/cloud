import { env as runtimeEnv } from 'cloudflare:workers';
import { readConfig, type Env, type UtsConfig } from '../../src/env';
import type { SignerKeys } from '../../src/signer-keys';

/** The bindings `wrangler.test.jsonc` adds for the tests: the internal entrypoint as three callers. */
export type TestEnv = Env & {
  FEED_SIGNER_KEYS: Service<SignerKeys>;
  OTHER_SIGNER_KEYS: Service<SignerKeys>;
  PROPLESS_SIGNER_KEYS: Service<SignerKeys>;
};

// The runtime env is untyped here; this binds it to the bindings `wrangler.test.jsonc` declares
// (the pattern services/sts/test/worker/test-env.ts uses).
export const env = runtimeEnv as TestEnv;

export const config: UtsConfig = readConfig(env);
