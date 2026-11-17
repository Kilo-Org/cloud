// Bitbucket's organization connection as the app models it: the token field it
// accepts, the repair each readiness state needs, and the failure class its
// connect and refresh actions render. Pure so every branch is unit-tested
// without mounting a screen.

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { z } from 'zod';

import { readTrpcErrorField } from '@/lib/trpc-error';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

export type BitbucketReadiness =
  RouterOutputs['organizations']['reviewAgent']['getBitbucketReadiness'];

/** The longest token the server's `AccessTokenSchema` accepts. */
export const BITBUCKET_TOKEN_MAX_LENGTH = 8_192;

/**
 * What the token field holds. `empty` is the form's first state and disables
 * its submit; `too-long` is the only value the server would refuse for its
 * length alone, so the field says so before a round trip.
 */
type BitbucketTokenField =
  | { readonly kind: 'empty' }
  | { readonly kind: 'too-long' }
  | { readonly kind: 'ready'; readonly token: string };

const tokenSchema = z.string().trim().min(1).max(BITBUCKET_TOKEN_MAX_LENGTH);

export function readBitbucketToken(value: string): BitbucketTokenField {
  const parsed = tokenSchema.safeParse(value);
  if (parsed.success) {
    return { kind: 'ready', token: parsed.data };
  }
  return value.trim().length === 0 ? { kind: 'empty' } : { kind: 'too-long' };
}

/**
 * The organization's Bitbucket integration as `organizations.bitbucket.getStatus`
 * reports it: the workspace access token this app connects, or the OAuth
 * authorization the web page owns. The readiness read above models the token
 * alone, so this is the only read that can name an OAuth connection.
 */
type BitbucketIntegrationStatus = RouterOutputs['organizations']['bitbucket']['getStatus'];

/**
 * The one fact a repair needs from an existing integration: which method
 * authorized it. A workspace access token is what this app replaces; an OAuth
 * authorization is not a connection the token form can touch.
 */
export type BitbucketExistingIntegration = Pick<BitbucketIntegrationStatus, 'method'>;

/**
 * The one repair a not-ready Bitbucket workspace needs. A workspace with no
 * integration needs a token; one whose integration exists but whose token was
 * rejected or lacks a required permission needs a replacement token; one whose
 * token reads fine but whose repository cache has not loaded only needs the
 * cache refreshed.
 *
 * A workspace authorized through Bitbucket OAuth reads as one with no
 * integration, because the readiness read only describes workspace access
 * tokens, but `organizations.bitbucket.connect` refuses a second integration
 * (`credential_conflict`). The app cannot change that connection — its OAuth
 * flow lives on the web — so the repair names the connection itself instead of
 * offering a form that cannot succeed.
 */
type BitbucketRepair =
  | { readonly kind: 'connect' }
  | { readonly kind: 'replace-token' }
  | { readonly kind: 'refresh-repositories'; readonly integrationId: string }
  | { readonly kind: 'manage-connection' };

export function bitbucketRepair(
  readiness: BitbucketReadiness,
  existingIntegration: BitbucketExistingIntegration | null = null
): BitbucketRepair {
  const integrationId = readiness.integrationId;
  if (!readiness.connected || readiness.missingRequiredScopes.length > 0) {
    if (integrationId !== null) {
      return { kind: 'replace-token' };
    }
    return existingIntegration?.method === 'oauth'
      ? { kind: 'manage-connection' }
      : { kind: 'connect' };
  }
  // A connected workspace always names its integration; the fallback keeps a
  // response that contradicts itself on the path that can still succeed.
  return integrationId === null
    ? { kind: 'connect' }
    : { kind: 'refresh-repositories', integrationId };
}

/**
 * Why a connection-changing call failed, and the sentence that explains it.
 * `kind` decides whether asking again can help and which repair the surface
 * offers beside the message.
 */
export type BitbucketFailure =
  | { readonly kind: 'token-refused'; readonly message: string }
  | { readonly kind: 'role-refused'; readonly message: string }
  | { readonly kind: 'connection-changed'; readonly message: string }
  | { readonly kind: 'retryable'; readonly message: string };

/**
 * The copy each failure renders, named so a new kind cannot skip its sentence.
 * Every key is one the catalogs already carry: a refusal the user can act on
 * names the connection that refused, and a transport failure points at the
 * connection rather than at Bitbucket's reply.
 */
const FAILURE_COPY_KEY = {
  // Bitbucket refused the saved token: the connection behind it is expired and
  // only a replacement token revives it.
  'token-refused': 'prReview.reconnectNotice.bitbucketTitle',
  // The same role rule the integration page states: an owner, admin or billing
  // manager is who can connect the workspace.
  'role-refused': 'prReview.connect.bitbucketAdminOnlyDescription',
  'connection-changed': 'prReview.connect.checkFailedTitleBitbucket',
  retryable: 'prReview.connect.providerCheckFailedMessage',
} as const satisfies Record<BitbucketFailure['kind'], string>;

/**
 * The server's denial sentences for a caller who may not manage organization
 * billing. `organizationBillingProcedure` refuses with `UNAUTHORIZED` for both
 * (unlike the token procedures, which answer `UNAUTHORIZED`/`FORBIDDEN` for a
 * token Bitbucket itself refused), so the sentence is what separates a lost
 * role from a bad token. The third sentence is the membership re-check the
 * connect transaction runs, which refuses the same way when a role changed
 * between the gate and the write.
 */
const ROLE_REFUSAL_MESSAGES = {
  'You do not have the required organizational role to access this feature': true,
  'You do not have access to this organization': true,
  'The current user cannot manage this organization integration': true,
} satisfies Record<string, true>;

/** Whether the sentence is one of the denials above. */
function isRoleRefusal(message: string): boolean {
  return Object.hasOwn(ROLE_REFUSAL_MESSAGES, message);
}

function failureKind(error: unknown): BitbucketFailure['kind'] {
  const code = readTrpcErrorField(error, 'code');
  if (code === 'CONFLICT' || code === 'NOT_FOUND') {
    return 'connection-changed';
  }
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    const message = readTrpcErrorField(error, 'message');
    return message !== undefined && isRoleRefusal(message) ? 'role-refused' : 'token-refused';
  }
  if (code === 'BAD_REQUEST' || code === 'UNPROCESSABLE_CONTENT') {
    // `invalid_token_format`, an unusable token payload, or a workspace the
    // token cannot describe: all of them mean this token will never work.
    return 'token-refused';
  }
  // Rate limits, timeouts, a Bitbucket outage and a lost connection are all
  // worth another attempt with the same token.
  return 'retryable';
}

/** The failure copy a surface renders for one kind of connection failure. */
export function bitbucketConnectionFailure(
  error: unknown,
  translate: (key: string) => string
): BitbucketFailure {
  const kind = failureKind(error);
  return { kind, message: translate(FAILURE_COPY_KEY[kind]) };
}
