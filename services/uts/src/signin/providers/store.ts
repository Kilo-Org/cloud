import type { UtsEnvironment, UtsOAuthProvider } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../../db/client';
import type { NetworkContext } from '../store';

/**
 * The provider, SSO and email sign-in statements (migration `0009_provider_sign_in.sql`). Each call
 * is one SQL statement, a SECURITY DEFINER function that writes its rows and audit rows together.
 * Results arrive as one row whose `outcome` column picks the shape.
 */

/** A provider in the identity store's terms: an OAuth or OpenID Connect provider, or WorkOS. */
export type FlowProvider = UtsOAuthProvider | 'workos';

export type FlowIntent =
  | { kind: 'sign_in' }
  /** Adds the method to the session's account; consumes the session's tier A pass. */
  | { kind: 'link'; sessionTokenHash: Uint8Array; gatePassId: string };

export type StartFlowInput = {
  environment: UtsEnvironment;
  stateHash: Uint8Array;
  binderHash: Uint8Array;
  provider: FlowProvider;
  intent: FlowIntent;
  /** The domain of the address an SSO sign-in starts with; null for other providers. */
  ssoDomain: string | null;
  returnTo: string;
};

export type StartFlowResult =
  | { outcome: 'started'; workosConnectionId: string | null }
  | { outcome: 'no_session' | 'gate_required' | 'no_sso_connection' };

/** What the provider said about the user, after UTS checked it. */
export type ProviderIdentity = {
  /** The provider's stable user id (`sub`, GitHub's or Discord's numeric id, WorkOS's profile id). */
  subject: string;
  /** Lower case; null when the provider gave none. */
  email: string | null;
  /** The provider proved control of `email` (src/signin/providers/specs.ts). */
  emailProven: boolean;
  /** The WorkOS connection an SSO profile names; null for other providers. */
  workosConnectionId: string | null;
};

export type CompleteFlowInput = {
  environment: UtsEnvironment;
  stateHash: Uint8Array;
  binderHash: Uint8Array;
  provider: FlowProvider;
  identity: ProviderIdentity;
  sessionTokenHash: Uint8Array;
  network: NetworkContext;
};

/** A sign-in that ended in a new browser session. */
export type SignedIn = {
  sessionId: string;
  accountId: string;
  accountCreated: boolean;
  methodLinked: boolean;
};

/** Refusals of a sign-in that the account settlement decides (`uts.settle_new_method`). */
export type AccountRefusal =
  | 'link_required'
  | 'email_required'
  | 'email_unverified'
  | 'sso_required'
  | 'account_blocked';

export type CompleteFlowResult =
  | { outcome: 'signed_in'; returnTo: string; signedIn: SignedIn }
  | { outcome: 'linked'; returnTo: string }
  | { outcome: 'invalid_state' }
  | {
      outcome: AccountRefusal | 'sso_refused' | 'no_session' | 'gate_required' | 'method_in_use';
      returnTo: string;
    };

export type StartEmailInput = {
  email: string;
  emailHash: Uint8Array;
  linkHash: Uint8Array;
  codeHash: Uint8Array;
  returnTo: string;
};

export type StartEmailResult =
  | { outcome: 'stored'; withCode: boolean; expiresAt: Date }
  | { outcome: 'sso_required' };

export type VerifyCodeInput = {
  environment: UtsEnvironment;
  emailHash: Uint8Array;
  codeHash: Uint8Array;
  sessionTokenHash: Uint8Array;
  network: NetworkContext;
};

export type VerifyCodeResult =
  | { outcome: 'signed_in'; returnTo: string; signedIn: SignedIn }
  | { outcome: 'invalid_code'; entriesLeft: number; returnTo: string | null }
  | { outcome: 'code_locked'; returnTo: string }
  | { outcome: AccountRefusal; returnTo: string };

export type EmailLinkInput = {
  environment: UtsEnvironment;
  linkHash: Uint8Array;
  sessionTokenHash: Uint8Array;
  network: NetworkContext;
};

export type EmailLinkResult =
  | { outcome: 'signed_in'; returnTo: string; signedIn: SignedIn }
  | { outcome: 'invalid_link' }
  | { outcome: AccountRefusal; returnTo: string };

export type ProviderSignInStore = {
  startFlow(input: StartFlowInput): Promise<StartFlowResult>;
  completeFlow(input: CompleteFlowInput): Promise<CompleteFlowResult>;
  startEmail(input: StartEmailInput): Promise<StartEmailResult>;
  verifyEmailCode(input: VerifyCodeInput): Promise<VerifyCodeResult>;
  completeEmailLink(input: EmailLinkInput): Promise<EmailLinkResult>;
};

/** Runs `work` with the statements of one request's identity-store connection. */
export type ProviderSignInAccess = <Result>(
  work: (store: ProviderSignInStore) => Promise<Result>
) => Promise<Result>;

export function providerSignInAccess(
  connectionString: string,
  context: WaitUntil
): ProviderSignInAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreProviderSignIn(store)));
}

const ACCOUNT_REFUSALS = [
  'link_required',
  'email_required',
  'email_unverified',
  'sso_required',
  'account_blocked',
] as const;

const SignedInColumns = {
  session_id: z.uuid(),
  session_account: z.string(),
  account_created: z.boolean(),
};

const StartFlowRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('started'), workos_connection_id: z.string().nullable() }),
  z.object({ outcome: z.enum(['no_session', 'gate_required', 'no_sso_connection']) }),
]);

const CompleteFlowRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('signed_in'),
    flow_return_to: z.string(),
    ...SignedInColumns,
    method_linked: z.boolean(),
  }),
  z.object({ outcome: z.literal('invalid_state') }),
  z.object({
    outcome: z.enum([
      'linked',
      ...ACCOUNT_REFUSALS,
      'sso_refused',
      'no_session',
      'gate_required',
      'method_in_use',
    ]),
    flow_return_to: z.string(),
  }),
]);

const StartEmailRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('stored'), with_code: z.boolean(), email_expires_at: z.date() }),
  z.object({ outcome: z.literal('sso_required') }),
]);

const VerifyCodeRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('signed_in'), code_return_to: z.string(), ...SignedInColumns }),
  z.object({
    outcome: z.literal('invalid_code'),
    entries_left: z.number().int().min(0),
    code_return_to: z.string().nullable(),
  }),
  z.object({ outcome: z.enum(['code_locked', ...ACCOUNT_REFUSALS]), code_return_to: z.string() }),
]);

const EmailLinkRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('signed_in'), link_return_to: z.string(), ...SignedInColumns }),
  z.object({ outcome: z.literal('invalid_link') }),
  z.object({ outcome: z.enum(ACCOUNT_REFUSALS), link_return_to: z.string() }),
]);

function signedInOf(
  row: z.output<z.ZodObject<typeof SignedInColumns>>,
  methodLinked = false
): SignedIn {
  return {
    sessionId: row.session_id,
    accountId: row.session_account,
    accountCreated: row.account_created,
    methodLinked,
  };
}

function networkValues(network: NetworkContext): unknown[] {
  return [network.userAgent, network.clientIp, network.asn, network.country, network.city];
}

export function identityStoreProviderSignIn(store: IdentityStore): ProviderSignInStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('a sign-in function returned no row');
    return result;
  }

  return {
    async startFlow(input) {
      const link = input.intent.kind === 'link' ? input.intent : null;
      const row = await one(
        'SELECT * FROM uts.start_sign_in_flow($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          input.environment,
          input.stateHash,
          input.provider,
          input.binderHash,
          input.intent.kind,
          link?.sessionTokenHash ?? null,
          link?.gatePassId ?? null,
          input.ssoDomain,
          input.returnTo,
        ],
        StartFlowRowSchema
      );
      if (row.outcome !== 'started') return { outcome: row.outcome };
      return { outcome: 'started', workosConnectionId: row.workos_connection_id };
    },

    async completeFlow(input) {
      const row = await one(
        'SELECT * FROM uts.complete_provider_sign_in($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
        [
          input.environment,
          input.stateHash,
          input.binderHash,
          input.provider,
          input.identity.subject,
          input.identity.email,
          input.identity.emailProven,
          input.identity.workosConnectionId,
          input.sessionTokenHash,
          ...networkValues(input.network),
        ],
        CompleteFlowRowSchema
      );
      if (row.outcome === 'signed_in') {
        return {
          outcome: 'signed_in',
          returnTo: row.flow_return_to,
          signedIn: signedInOf(row, row.method_linked),
        };
      }
      if (row.outcome === 'invalid_state') return { outcome: 'invalid_state' };
      return { outcome: row.outcome, returnTo: row.flow_return_to };
    },

    async startEmail(input) {
      const row = await one(
        'SELECT * FROM uts.start_email_sign_in($1, $2, $3, $4, $5)',
        [input.email, input.emailHash, input.linkHash, input.codeHash, input.returnTo],
        StartEmailRowSchema
      );
      if (row.outcome === 'sso_required') return { outcome: 'sso_required' };
      return { outcome: 'stored', withCode: row.with_code, expiresAt: row.email_expires_at };
    },

    async verifyEmailCode(input) {
      const row = await one(
        'SELECT * FROM uts.verify_email_code($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          input.environment,
          input.emailHash,
          input.codeHash,
          input.sessionTokenHash,
          ...networkValues(input.network),
        ],
        VerifyCodeRowSchema
      );
      if (row.outcome === 'signed_in') {
        return { outcome: 'signed_in', returnTo: row.code_return_to, signedIn: signedInOf(row) };
      }
      if (row.outcome === 'invalid_code') {
        return {
          outcome: 'invalid_code',
          entriesLeft: row.entries_left,
          returnTo: row.code_return_to,
        };
      }
      return { outcome: row.outcome, returnTo: row.code_return_to };
    },

    async completeEmailLink(input) {
      const row = await one(
        'SELECT * FROM uts.complete_email_link($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          input.environment,
          input.linkHash,
          input.sessionTokenHash,
          ...networkValues(input.network),
        ],
        EmailLinkRowSchema
      );
      if (row.outcome === 'signed_in') {
        return { outcome: 'signed_in', returnTo: row.link_return_to, signedIn: signedInOf(row) };
      }
      if (row.outcome === 'invalid_link') return { outcome: 'invalid_link' };
      return { outcome: row.outcome, returnTo: row.link_return_to };
    },
  };
}
