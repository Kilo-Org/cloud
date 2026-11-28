import { env as runtimeEnv } from 'cloudflare:workers';
import type {
  FeedReadsBinding,
  PatLookupBinding,
  SignerKeysBinding,
} from '@kilocode/uts-contracts';
import { readConfig, type Env, type UtsConfig } from '../../src/env';
import type { SignInMethods } from '../../src/signin/flows';
import { readSignInConfig } from '../../src/signin/providers/config';
import type { SubjectRevocation } from '../../src/subjects/entrypoint';
import type { TicketRedeemer } from '../../src/tickets/redeemer';
import { signInInput } from '../secrets-support';

/**
 * The bindings `wrangler.test.jsonc` adds for the tests: the mint Worker's SignerKeys entrypoint
 * as three callers, its FeedReads entrypoint as the feed Worker and as another caller, its
 * default entrypoint with the feed Worker's props, its PatLookup entrypoint as three callers, and
 * its SubjectRevocation entrypoint as three callers.
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
  TICKET_REDEEMER: Service<TicketRedeemer>;
  OTHER_REDEEMER: Service<TicketRedeemer>;
  SUBJECT_REVOCATION: Service<SubjectRevocation>;
  OTHER_SUBJECT_REVOCATION: Service<SubjectRevocation>;
  PROPLESS_SUBJECT_REVOCATION: Service<SubjectRevocation>;
};

// The runtime env is untyped here; this binds it to the bindings `wrangler.test.jsonc` declares
// (the pattern services/sts/test/worker/test-env.ts uses).
export const env = runtimeEnv as TestEnv;

export const config: UtsConfig = readConfig(env);

/** No provider, SSO or email sign-in: the deps of tests that reach none of them. */
export const noSignInMethods: SignInMethods = {
  config,
  settings: readSignInConfig(signInInput({}), config),
  store: async () => {
    throw new Error('unexpected sign-in method store call');
  },
  email: { status: 'off' },
};
