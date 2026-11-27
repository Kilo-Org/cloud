import { env as runtimeEnv } from 'cloudflare:workers';
import type {
  FeedReadsBinding,
  PatLookupBinding,
  SignerKeysBinding,
} from '@kilocode/uts-contracts';
import { readConfig, type Env, type UtsConfig } from '../../src/env';

/**
 * The bindings `wrangler.test.jsonc` adds for the tests: the mint Worker's SignerKeys entrypoint
 * as three callers, its FeedReads entrypoint as the feed Worker and as another caller, its
 * default entrypoint with the feed Worker's props, and its PatLookup entrypoint as three callers.
 */
export type TestEnv = Env & {
  FEED_MINT: SignerKeysBinding;
  OTHER_MINT: SignerKeysBinding;
  PROPLESS_MINT: SignerKeysBinding;
  DEFAULT_MINT: Fetcher;
  VERIFIER_PAT_LOOKUP: PatLookupBinding;
  OTHER_PAT_LOOKUP: PatLookupBinding;
  PROPLESS_PAT_LOOKUP: PatLookupBinding;
  FEED_READS: FeedReadsBinding;
  OTHER_READS: FeedReadsBinding;
};

// The runtime env is untyped here; this binds it to the bindings `wrangler.test.jsonc` declares
// (the pattern services/sts/test/worker/test-env.ts uses).
export const env = runtimeEnv as TestEnv;

export const config: UtsConfig = readConfig(env);
