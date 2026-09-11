/**
 * The application `defaultHandler` for the library-backed OAuth flow (s3).
 *
 * `@cloudflare/workers-oauth-provider` owns the protocol endpoints (token,
 * registration, metadata) and the /mcp audience check; this handler owns the
 * browser-facing authorize UI:
 *
 *   GET  /authorize          -> consent page (parseAuthRequest + pairing)
 *   GET  /authorize/status   -> poll apps/web; pending/needs_org/denied/expired
 *   GET|POST /authorize/org  -> organization picker + completeAuthorization
 *   *                        -> 404
 *
 * apps/web stays the identity provider: /authorize opens a Kilo device-auth
 * pairing, the consent page links the user to sign-in, and the worker relays
 * the pairing outcome and the chosen org before the library mints the code via
 * `completeAuthorization`.
 *
 * The internal pending-authorization id (never the device-auth code) is the
 * `id` query parameter on /authorize/status and /authorize/org.
 */
import type {
  AuthRequest,
  AuthorizationError,
  ClientInfo,
} from '@cloudflare/workers-oauth-provider';
import {
  AUTH_PATHS,
  MCP_SCOPE,
  authJsonResponse,
  errorPage,
  redirectToClientError,
  withAuthCors,
} from '../auth/http';
import { orgPickerFormSchema, orgPickerQuerySchema, pairingStatusQuerySchema } from '../schemas';
import type { McpAnalytics } from '../analytics';
import type { OAuthStoreApi, PendingAuthorization } from '../store/oauth-store';
import { createKiloPairing, fetchOrgOptions, pollKiloPairing } from './kilo-pairing';
import { PERSONAL_ORG_ID, consentPage, orgPickerPage, type OrgOption } from './pages';

/** Pending records are short-lived: 10 minutes to complete sign-in. */
export const PENDING_TTL_SECONDS = 600;

export type ConsentDeps = {
  store: OAuthStoreApi;
  /** apps/web base URL — the user-identity provider. */
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Best-effort sign-in analytics; never awaited and never allowed to throw. */
  analytics?: McpAnalytics;
};

/** The consent page's status answer. */
export type PairingStatus =
  | { status: 'pending' }
  | { status: 'needs_org'; picker_url: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'unknown' };

/**
 * The s1 query schemas validate the same opaque non-empty value under their
 * `code` field; the s3 route carries it as `id`. Validate through the pinned
 * schema (never re-declaring the rule) and keep the caller's name.
 */
function parsePendingId(raw: string | null): string | null {
  const parsed = pairingStatusQuerySchema.safeParse({ code: raw ?? '' });
  return parsed.success ? parsed.data.code : null;
}

function parsePickerId(raw: string | null): string | null {
  const parsed = orgPickerQuerySchema.safeParse({ code: raw ?? '' });
  return parsed.success ? parsed.data.code : null;
}

/**
 * `parseAuthRequest` rejects an invalid request with the library's
 * `AuthorizationError`. Duck-type it (name + fields the library sets) so this
 * module needs no runtime import of the provider — important because the
 * provider eagerly imports `cloudflare:workers`.
 */
function isAuthorizationError(error: unknown): error is AuthorizationError {
  if (!(error instanceof Error) || error.name !== 'AuthorizationError') return false;
  const candidate = error as { code?: unknown; description?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.description === 'string';
}

function needsOrg(id: string): Response {
  return authJsonResponse({
    status: 'needs_org',
    picker_url: `${AUTH_PATHS.orgPicker}?id=${encodeURIComponent(id)}`,
  } satisfies PairingStatus);
}

/** A pending record whose pairing is approved but whose org is not chosen yet. */
function isPaired(record: PendingAuthorization): record is PendingAuthorization & {
  kiloUserId: string;
  kiloToken: string;
} {
  return (
    typeof record.kiloUserId === 'string' &&
    record.kiloUserId.length > 0 &&
    typeof record.kiloToken === 'string' &&
    record.kiloToken.length > 0
  );
}

/** Rebuild the client's original /authorize request from the stored library request. */
function restartAuthorizeUrl(authRequest: AuthRequest, origin: string): string {
  const url = new URL(AUTH_PATHS.authorize, origin);
  url.searchParams.set('client_id', authRequest.clientId);
  url.searchParams.set('redirect_uri', authRequest.redirectUri);
  url.searchParams.set('response_type', authRequest.responseType);
  if (authRequest.codeChallenge) {
    url.searchParams.set('code_challenge', authRequest.codeChallenge);
  }
  if (authRequest.codeChallengeMethod) {
    url.searchParams.set('code_challenge_method', authRequest.codeChallengeMethod);
  }
  const resource = Array.isArray(authRequest.resource)
    ? authRequest.resource[0]
    : authRequest.resource;
  if (resource) url.searchParams.set('resource', resource);
  if (authRequest.scope.length > 0) url.searchParams.set('scope', authRequest.scope.join(' '));
  if (authRequest.state) url.searchParams.set('state', authRequest.state);
  return url.toString();
}

/** Redirect to the client with the RFC 6749 §4.1.2.1 error params plus `iss` (RFC 9207). */
function errorRedirect(error: AuthorizationError): Response {
  // Presence of `redirectUri` is the library's guarantee the client and exact
  // redirect URI were validated; without it the caller renders locally.
  const response = redirectToClientError(
    error.redirectUri as string,
    error.code,
    error.description,
    error.state ?? null
  );
  if (error.issuer) {
    const location = new URL(response.headers.get('Location') as string);
    location.searchParams.set('iss', error.issuer);
    response.headers.set('Location', location.toString());
  }
  return response;
}

async function handleAuthorize(
  request: Request,
  env: Env,
  deps: ConsentDeps
): Promise<Response> {
  if (request.method !== 'GET') {
    return errorPage('invalid_request', 'Use GET for /authorize.');
  }
  const clientId = new URL(request.url).searchParams.get('client_id');

  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!isAuthorizationError(error)) throw error;
    deps.analytics?.oauthSignIn({
      phase: 'failed',
      identity: null,
      ...(clientId !== null ? { clientId } : {}),
      reason: error.code,
    });
    // A rejected request never produced an identity: render unknown clients
    // and invalid redirects locally and never redirect there (phishing vector).
    return error.redirectUri ? errorRedirect(error) : errorPage(error.code, error.description);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) {
    deps.analytics?.oauthSignIn({
      phase: 'failed',
      identity: null,
      clientId: authRequest.clientId,
      reason: 'invalid_request',
    });
    return errorPage('invalid_request', 'Unknown OAuth client.');
  }

  const pairing = await createKiloPairing(deps, request);
  if (!pairing.ok) {
    // Retryable unhappy path: nothing was created; tell the user exactly what
    // to do (wait vs check connection) and send them back to the client.
    deps.analytics?.oauthSignIn({
      phase: 'failed',
      identity: null,
      clientId: authRequest.clientId,
      reason: pairing.kind,
    });
    const description =
      pairing.kind === 'rate_limited'
        ? 'Too many pending Kilo sign-in requests from your network right now. Wait a few minutes, then retry from your MCP client.'
        : 'Kilo sign-in could not be reached. Check your connection, then retry from your MCP client.';
    return errorPage('temporarily_unavailable', description, 503);
  }

  const now = deps.now?.() ?? new Date();
  const id = crypto.randomUUID();
  await deps.store.createPendingAuthorization({
    id,
    authRequest,
    deviceAuthCode: pairing.pairingCode,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_TTL_SECONDS * 1000).toISOString(),
  });

  // The user has not signed in yet: this pre-auth start event is anonymous.
  deps.analytics?.oauthSignIn({
    phase: 'started',
    identity: null,
    clientId: authRequest.clientId,
  });

  return consentPage({
    clientName: client.clientName ?? 'your MCP client',
    scope: MCP_SCOPE,
    webSignInUrl: `${deps.webBaseUrl.replace(/\/$/, '')}/device-auth?code=${encodeURIComponent(pairing.pairingCode)}`,
    statusUrl: `${AUTH_PATHS.pairingStatus}?id=${encodeURIComponent(id)}`,
    restartUrl: request.url,
  });
}

async function handlePairingStatus(request: Request, deps: ConsentDeps): Promise<Response> {
  if (request.method !== 'GET') {
    return authJsonResponse({ error: 'invalid_request' }, 405);
  }
  const url = new URL(request.url);
  const id = parsePendingId(url.searchParams.get('id'));
  if (id === null) {
    return authJsonResponse({ status: 'unknown' } satisfies PairingStatus);
  }

  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const record = await deps.store.getPendingAuthorization(id);
  if (!record || record.expiresAt <= nowIso || record.status === 'completed') {
    return authJsonResponse({ status: 'unknown' } satisfies PairingStatus);
  }
  const clientId = record.authRequest.clientId;
  if (record.status === 'denied') {
    // Terminal, and the transition already recorded the failure once. A later
    // poll of the same record must answer denied without re-emitting.
    return authJsonResponse({ status: 'denied' } satisfies PairingStatus);
  }
  if (record.status === 'expired') {
    return authJsonResponse({ status: 'expired' } satisfies PairingStatus);
  }
  if (record.status === 'approved') {
    // The org was chosen and /authorize/org owns the redirect; a status poll
    // past this point must not send the browser back to the picker.
    return authJsonResponse({ status: 'unknown' } satisfies PairingStatus);
  }
  // The pairing is approved but the org is not chosen (status stays 'pending'
  // until /authorize/org): send the page to the picker.
  if (isPaired(record)) {
    return needsOrg(id);
  }

  const upstream = await pollKiloPairing(deps, record.deviceAuthCode);
  switch (upstream.status) {
    case 'pending':
    case 'unreachable':
      // Transient upstream failure keeps the page waiting; its next poll retries.
      return authJsonResponse({ status: 'pending' } satisfies PairingStatus);
    case 'denied': {
      // Emit only when THIS request won the pending -> denied transition.
      const transitioned = await deps.store.denyPendingAuthorization(record.deviceAuthCode, nowIso);
      if (transitioned) {
        deps.analytics?.oauthSignIn({
          phase: 'failed',
          identity: null,
          clientId,
          reason: 'denied',
        });
      }
      return authJsonResponse({ status: 'denied' } satisfies PairingStatus);
    }
    case 'expired': {
      const transitioned = await deps.store.expirePendingAuthorization(
        record.deviceAuthCode,
        nowIso
      );
      if (transitioned) {
        deps.analytics?.oauthSignIn({
          phase: 'failed',
          identity: null,
          clientId,
          reason: 'expired',
        });
      }
      return authJsonResponse({ status: 'expired' } satisfies PairingStatus);
    }
    case 'approved': {
      // Persist BEFORE any further poll: the upstream answer is single-use.
      await deps.store.recordPairingApproval(
        record.deviceAuthCode,
        { kiloUserId: upstream.userId, kiloToken: upstream.token },
        nowIso
      );
      const updated = await deps.store.getPendingAuthorization(id);
      if (updated && isPaired(updated)) {
        return needsOrg(id);
      }
      if (updated?.status === 'denied') {
        return authJsonResponse({ status: 'denied' } satisfies PairingStatus);
      }
      return authJsonResponse({ status: 'unknown' } satisfies PairingStatus);
    }
  }
}

async function handleOrgPicker(
  request: Request,
  env: Env,
  deps: ConsentDeps
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorPage('invalid_request', 'Use GET or POST for /authorize/org.');
  }
  const url = new URL(request.url);
  const id = parsePickerId(url.searchParams.get('id'));
  if (id === null) {
    return errorPage('invalid_request', 'Missing authorization id.');
  }

  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const record = await deps.store.getPendingAuthorization(id);
  if (
    !record ||
    record.expiresAt <= nowIso ||
    record.status === 'denied' ||
    record.status === 'expired' ||
    record.status === 'completed' ||
    record.status === 'approved'
  ) {
    return errorPage(
      'invalid_request',
      'This request is no longer valid. Close this tab and retry from your MCP client.'
    );
  }

  const client: ClientInfo | null = await env.OAUTH_PROVIDER.lookupClient(
    record.authRequest.clientId
  );
  const clientName = client?.clientName ?? 'your MCP client';
  const actionUrl = `${AUTH_PATHS.orgPicker}?id=${encodeURIComponent(id)}`;

  if (!isPaired(record)) {
    // Kilo sign-in not finished for this record: send the user back through
    // the consent page for the SAME pairing (the device-auth code is stored).
    return consentPage({
      clientName,
      scope: MCP_SCOPE,
      webSignInUrl: `${deps.webBaseUrl.replace(/\/$/, '')}/device-auth?code=${encodeURIComponent(record.deviceAuthCode)}`,
      statusUrl: `${AUTH_PATHS.pairingStatus}?id=${encodeURIComponent(id)}`,
      restartUrl: restartAuthorizeUrl(record.authRequest, url.origin),
    });
  }
  const kiloToken = record.kiloToken;

  /** Render the picker offering only the personal context with a retry message. */
  const personalOnlyPage = (error: string) =>
    orgPickerPage({
      clientName,
      actionUrl,
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error,
    });

  /** Bind the chosen context and complete the authorize; stops on a lost race. */
  const approveAndRedirect = async (organizationId: string | null): Promise<Response> => {
    const approved = await deps.store.approvePendingAuthorization(
      record.deviceAuthCode,
      { kiloUserId: record.kiloUserId, organizationId },
      nowIso
    );
    if (!approved) {
      // Lost the race to a concurrent submit or an expiry: stop, do not
      // complete. The store's pending->approved guard makes a re-completion
      // impossible.
      return errorPage(
        'invalid_request',
        'This request is no longer valid. Close this tab and retry from your MCP client.'
      );
    }
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: record.authRequest,
      userId: record.kiloUserId,
      metadata: { clientName },
      scope: [MCP_SCOPE],
      props: {
        kiloUserId: record.kiloUserId,
        organizationId,
        kiloToken: record.kiloToken,
        clientId: record.authRequest.clientId,
      },
    });
    await deps.store.completePendingAuthorization(id, nowIso);
    // The library owns the token endpoint, so its tokenExchangeCallback hook
    // runs without deps and cannot see this per-request emitter (index.ts wires
    // it with no ProviderHookDeps). Emit the one sign-in success here, after the
    // approved guard, so a repeated submit neither completes nor emits again.
    deps.analytics?.oauthSignIn({
      phase: 'succeeded',
      identity: { kiloUserId: record.kiloUserId, organizationId },
      clientId: record.authRequest.clientId,
    });
    // Plain 302 (not Response.redirect) so withAuthCors can extend the headers.
    return withAuthCors(new Response(null, { status: 302, headers: { Location: redirectTo } }));
  };

  if (request.method === 'GET') {
    let options: OrgOption[];
    try {
      options = await fetchOrgOptions(deps, kiloToken);
    } catch {
      // Retryable unhappy: the org list is a live read, so the personal context
      // stays selectable and the same submit completes the flow on retry.
      return personalOnlyPage(
        'Could not load your organizations right now — only the personal account is offered. Choose it, or retry.'
      );
    }
    return orgPickerPage({ clientName, actionUrl, options, error: null });
  }

  // POST. The personal context is always valid for an approved Kilo login, so
  // it must not depend on the live membership read.
  const form = await request.formData().catch(() => null);
  const parsedForm = orgPickerFormSchema.safeParse({
    organization_id: form?.get('organization_id') ?? '',
  });
  if (!parsedForm.success) {
    // Missing or malformed selection: re-render the picker with a prompt when
    // the org list is reachable, else offer the (still valid) personal context.
    let options: OrgOption[] | null = null;
    try {
      options = await fetchOrgOptions(deps, kiloToken);
    } catch {
      options = null;
    }
    return options
      ? orgPickerPage({ clientName, actionUrl, options, error: 'Choose an account to continue.' })
      : personalOnlyPage('Choose an account to continue.');
  }
  const submitted = parsedForm.data.organization_id;
  if (submitted === PERSONAL_ORG_ID) {
    return approveAndRedirect(null);
  }
  // Concrete orgs stay validated against the freshly-fetched membership list:
  // a client cannot authorize an org it is not a member of by editing the form.
  let options: OrgOption[];
  try {
    options = await fetchOrgOptions(deps, kiloToken);
  } catch {
    return personalOnlyPage(
      'Could not load your organizations right now — only the personal account is offered. Choose it, or retry.'
    );
  }
  const chosen = options.find(option => option.id === submitted);
  if (!chosen) {
    return orgPickerPage({
      clientName,
      actionUrl,
      options,
      error: 'That organization is not available for this account.',
    });
  }
  return approveAndRedirect(chosen.id === PERSONAL_ORG_ID ? null : chosen.id);
}

/**
 * Build the application `defaultHandler` for the OAuth provider. The provider
 * routes its own protocol endpoints (token/registration/metadata) here first;
 * every other path 404s.
 */
export function createDefaultHandler(deps: ConsentDeps): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      switch (url.pathname) {
        case AUTH_PATHS.authorize:
          return handleAuthorize(request, env, deps);
        case AUTH_PATHS.pairingStatus:
          return handlePairingStatus(request, deps);
        case AUTH_PATHS.orgPicker:
          return handleOrgPicker(request, env, deps);
        default:
          return withAuthCors(new Response('Not found', { status: 404 }));
      }
    },
  };
}
