import { env as runtimeEnv } from 'cloudflare:workers';
import type { SignerKeysBinding } from '@kilocode/uts-contracts';
import { readConfig, type Env, type UtsConfig } from '../../src/env';
import type { TicketRedeemer } from '../../src/tickets/redeemer';

/**
 * The bindings `wrangler.test.jsonc` adds for the tests: the mint Worker's SignerKeys entrypoint
 * as three callers, and its default entrypoint with the feed Worker's props.
 */
export type TestEnv = Env & {
  FEED_MINT: SignerKeysBinding;
  OTHER_MINT: SignerKeysBinding;
  PROPLESS_MINT: SignerKeysBinding;
  DEFAULT_MINT: Fetcher;
  TICKET_REDEEMER: Service<TicketRedeemer>;
  OTHER_REDEEMER: Service<TicketRedeemer>;
};

// The runtime env is untyped here; this binds it to the bindings `wrangler.test.jsonc` declares
// (the pattern services/sts/test/worker/test-env.ts uses).
export const env = runtimeEnv as TestEnv;

export const config: UtsConfig = readConfig(env);
