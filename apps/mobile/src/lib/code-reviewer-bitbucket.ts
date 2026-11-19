// Bitbucket's organization connection as the app models it: the token field it
// accepts, the repair each readiness state needs, and the failure class its
// connect and refresh actions render. Pure so every branch is unit-tested
// without mounting a screen.

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { z } from 'zod';

import { classifyProviderErrorCode } from '@/lib/code-reviewer-status';
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
export type BitbucketIntegrationStatus = RouterOutputs['organizations']['bitbucket']['getStatus'];

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
 * The surface that submitted the token which Bitbucket refused. A first
 * connect pasted the very token that was refused, so the honest sentence names
 * the bad token; a stored-token surface submitted or re-read a token the
 * connection had already accepted, so the connection it sits on is what
 * expired.
 */
export type BitbucketTokenRefusal = 'first-connect' | 'replace-token';

/**
 * The copy the failure kinds that have exactly one sentence render, named so a
 * new kind cannot skip its sentence. Every key is one the catalogs already
 * carry: a refusal the user can act on names the connection that refused, and
 * a transport failure points at the connection rather than at Bitbucket's
 * reply. `token-refused` is the one kind with two truths — the same refusal
 * reads as a bad pasted token on a first connect but as an expired connection
 * once a stored token has been replaced or re-read — so its copy lives with
 * the axis above.
 */
const FAILURE_COPY_KEY = {
  // The same role rule the integration page states: an owner, admin or billing
  // manager is who can connect the workspace.
  'role-refused': 'prReview.connect.bitbucketAdminOnlyDescription',
  'connection-changed': 'prReview.connect.checkFailedTitleBitbucket',
  retryable: 'prReview.connect.providerCheckFailedMessage',
} as const satisfies Record<Exclude<BitbucketFailure['kind'], 'token-refused'>, string>;

/**
 * The two sentences a refused token renders. Kept side by side with the axis
 * above so a new refusal surface cannot be wired without naming its truth:
 * one is what a first connect needs (the pasted token is wrong), the other is
 * what a stored-token surface shows (the connection expired).
 */
const TOKEN_REFUSED_COPY_KEY = {
  'first-connect': 'codeReviewer.bitbucketConnect.tokenRefused',
  'replace-token': 'prReview.reconnectNotice.bitbucketTitle',
} as const satisfies Record<BitbucketTokenRefusal, string>;

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

/**
 * The failure copy a surface renders for one kind of connection failure. The
 * submitting surface names its side of the refusal axis: a token Bitbucket
 * refused has two honest sentences, and only the surface knows whether it
 * pasted a first token that never worked or sat on a connection whose token
 * has stopped working.
 */
export function bitbucketConnectionFailure(
  error: unknown,
  translate: (key: string) => string,
  tokenRefusal: BitbucketTokenRefusal
): BitbucketFailure {
  const kind = failureKind(error);
  return kind === 'token-refused'
    ? { kind, message: translate(TOKEN_REFUSED_COPY_KEY[tokenRefusal]) }
    : { kind, message: translate(FAILURE_COPY_KEY[kind]) };
}

/**
 * The organization's Bitbucket connection as the reviewer surfaces render it,
 * from both reads: the readiness the token form owns, and the integration
 * status that also sees an OAuth authorization. The readiness read alone
 * reports an OAuth-connected organization as not connected, so every surface
 * that used to read it alone showed "Not connected" beside an active
 * connection — classifier order encodes what outranks what.
 */
export type BitbucketConnection =
  | { kind: 'loading' }
  | {
      kind: 'error';
      permanent: boolean;
      variant: 'server' | 'permission' | 'not-found';
      refetch: () => void;
      isRetrying: boolean;
    }
  | { kind: 'token-connected'; readiness: BitbucketReadiness }
  /** The web page owns the connection; the app renders it read-only. */
  | { kind: 'oauth-connected'; workspace: { slug: string | null; displayName: string | null } }
  /** Authorized through Bitbucket OAuth but not yet usable — no token form. */
  | { kind: 'oauth-attention' }
  | { kind: 'not-connected'; readiness: BitbucketReadiness | undefined };

type ReadinessRead = {
  isLoading: boolean;
  isPending?: boolean;
  isError: boolean;
  isFetching: boolean;
  data: BitbucketReadiness | undefined;
  error?: unknown;
  refetch: () => void;
};

type IntegrationStatusRead = {
  isPending?: boolean;
  isLoading?: boolean;
  isError: boolean;
  isFetching: boolean;
  data: BitbucketIntegrationStatus | undefined;
  error?: unknown;
  refetch: () => void;
};

/**
 * Turn the two Bitbucket reads into the one connection a surface renders.
 * Precedence: a token connection wins over a (possibly stale) OAuth status;
 * an OAuth answer wins over the readiness read's "no integration"; loading and
 * error only apply when neither read names a connection.
 */
export function classifyBitbucketConnection(input: {
  readiness: ReadinessRead;
  status: IntegrationStatusRead;
}): BitbucketConnection {
  const { readiness, status } = input;

  // Rule 1 — the token integration wins: the status read may still carry an
  // OAuth answer from before the token was connected.
  if (readiness.data?.connected === true) {
    return { kind: 'token-connected', readiness: readiness.data };
  }

  // Rule 2/3 — an OAuth authorization answers for the whole organization.
  if (status.data?.method === 'oauth') {
    const oauthStatus = status.data.status;
    if (oauthStatus === 'connected') {
      return {
        kind: 'oauth-connected',
        workspace: {
          slug: status.data.workspace?.slug ?? null,
          displayName: status.data.workspace?.displayName ?? null,
        },
      };
    }
    if (oauthStatus === 'workspace_selection_required' || oauthStatus === 'reconnect_required') {
      return { kind: 'oauth-attention' };
    }
    // `not_connected` under `method: 'oauth'` cannot occur from the server
    // (an OAuth row answers only from an existing integration), but the
    // readiness data below still decides between not-connected and error.
  }

  // Rule 4 — loading: neither read holds a connection answer and one may still
  // land. `isPending` is a first fetch that has not decided yet; `isLoading`
  // adds `isFetching`, and neither reads as loading once the read has failed —
  // the same settled-on-failure shape the provider-state classifier keeps out
  // of the loading state.
  const readinessDeciding =
    !readiness.isError && (readiness.isLoading || readiness.isPending === true);
  const statusDeciding =
    !status.isError && (status.isLoading === true || status.isPending === true);
  if (
    readiness.data === undefined &&
    status.data === undefined &&
    (readinessDeciding || statusDeciding)
  ) {
    return { kind: 'loading' };
  }

  // Rule 5 — error: a read that failed without data decides the variant, the
  // readiness failure preferred when both failed. The two reads name one
  // connection, so a retry re-runs both: one re-read alone could leave the
  // other's stale answer on screen.
  const readinessFailed = readiness.data === undefined && readiness.isError;
  const statusFailed = status.data === undefined && status.isError;
  if (readinessFailed || statusFailed) {
    const failedRead = readinessFailed ? readiness : status;
    const { permanent, variant } = classifyProviderErrorCode(
      readTrpcErrorField(failedRead.error, 'code')
    );
    return {
      kind: 'error',
      permanent,
      variant,
      refetch: () => {
        readiness.refetch();
        status.refetch();
      },
      isRetrying: failedRead.isFetching,
    };
  }

  // Rule 6 — whatever readiness answered (or not) is the whole answer.
  return { kind: 'not-connected', readiness: readiness.data };
}

/**
 * Whether the web page owns this connection. An OAuth authorization has no
 * token the app can replace and no form the server would accept, so every
 * surface states that fact instead of offering an action.
 */
export function isWebManagedConnection(connection: BitbucketConnection): boolean {
  return connection.kind === 'oauth-connected' || connection.kind === 'oauth-attention';
}

/** The one word the platform list paints beside the Bitbucket row. */
export type BitbucketRowStatus =
  | 'checking'
  | 'status-unavailable'
  | 'connected'
  | 'needs-attention'
  | 'not-connected';

const ROW_STATUS_BY_CONNECTION = {
  loading: 'checking',
  error: 'status-unavailable',
  'token-connected': 'connected',
  'oauth-connected': 'connected',
  'oauth-attention': 'needs-attention',
  'not-connected': 'not-connected',
} as const satisfies Record<BitbucketConnection['kind'], BitbucketRowStatus>;

export function bitbucketRowStatus(connection: BitbucketConnection): BitbucketRowStatus {
  return ROW_STATUS_BY_CONNECTION[connection.kind];
}
