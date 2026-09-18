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
import type { AuthenticatorEnrollmentApi } from '../types';
import {
  createKiloPairing,
  fetchOrgOptions,
  fetchUserIsAdmin,
  pollKiloPairing,
} from './kilo-pairing';
import {
  PERSONAL_ORG_ID,
  consentPage,
  orgPickerPage,
  type AuthenticatorView,
  type OrgOption,
} from './pages';

/** Pending records are short-lived: 10 minutes to complete sign-in. */
export const PENDING_TTL_SECONDS = 600;

/** Operator-facing copy for a record that can no longer be acted on. */
const STALE_REQUEST_MESSAGE =
  'This request is no longer valid. Close this tab and retry from your MCP client.';

/** Shown when the paired identity's admin check could not be reached (fail-closed). */
const ADMIN_CHECK_NOTICE =
  'We could not check admin access for this account. Reload this page to try again.';

/** Retryable copy for a membership read that failed (the personal context stays). */
const ORG_LIST_UNAVAILABLE_MESSAGE =
  'Could not load your organizations right now — only the personal account is offered. Choose it, or retry.';

/** The opt-in was submitted with no code: ask for it again, mint nothing. */
const OTP_REQUIRED_MESSAGE = 'Enter the code from your authenticator app.';

/** The code did not verify against the admin's registered authenticator. */
const OTP_INVALID_MESSAGE = 'That code is not valid. Check your authenticator app and try again.';

export type ConsentDeps = {
  /**
   * The OAuth pending records plus the admin authenticator enrolment the opt-in
   * subsection reads (`ensureAuthenticator`/`confirmAuthenticator`).
   */
  store: OAuthStoreApi & AuthenticatorEnrollmentApi;
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

async function handleAuthorize(request: Request, env: Env, deps: ConsentDeps): Promise<Response> {
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

async function handleOrgPicker(request: Request, env: Env, deps: ConsentDeps): Promise<Response> {
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
    return errorPage('invalid_request', STALE_REQUEST_MESSAGE);
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

  // Admin eligibility is fail-closed and derived per request from the paired
  // identity's live `user.getMe`, never from the submitted checkbox. A thrown
  // check is 'not eligible'; on the GET it also explains why the option is
  // missing so the reload is an informed retry. The authenticator read is part
  // of the same option: read on the POST too (not just the GET) so every render
  // for an eligible admin carries the subsection, and a throw fails closed
  // exactly like a thrown admin check — no checkbox, no subsection, org list
  // and Connect intact. A throw is an internal failure of the admin option,
  // never a reason to block a plain connection.
  let adminEligible = false;
  let adminCheckFailed = false;
  let adminNotice: string | null = null;
  let authenticator: AuthenticatorView | null = null;
  try {
    adminEligible = await fetchUserIsAdmin(deps, kiloToken);
    if (adminEligible) {
      authenticator = await deps.store.ensureAuthenticator(record.kiloUserId, nowIso);
    }
  } catch {
    // Fail closed, and remember the failure: the POST below must not drop a
    // submitted opt-in silently when this check could not run.
    adminEligible = false;
    authenticator = null;
    adminCheckFailed = true;
    if (request.method === 'GET') adminNotice = ADMIN_CHECK_NOTICE;
  }

  /** One picker render carrying the admin option and its authenticator subsection. */
  const renderPicker = (config: {
    options: OrgOption[];
    error: string | null;
    /** Reveal the subsection (a refused admin submit must not lose its prompt). */
    revealed?: boolean;
    /** Overrides the GET-only admin-check notice when a branch must show it. */
    notice?: string | null;
  }): Response =>
    orgPickerPage({
      clientName,
      actionUrl,
      options: config.options,
      error: config.error,
      showAdminOption: adminEligible,
      authenticator,
      ...(config.revealed ? { authenticatorRevealed: true } : {}),
      adminNotice: config.notice === undefined ? adminNotice : config.notice,
    });

  /** Render the picker offering only the personal context with a retry message. */
  const personalOnlyPage = (error: string): Response =>
    renderPicker({
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error,
    });

  /**
   * Render with the live org list; when the read fails the personal context
   * (always valid for a Kilo login) stays selectable with the same message.
   * `notice` overrides the GET-only admin-check notice when a branch must show it.
   */
  const orgListPage = async (
    error: string | null,
    revealed = false,
    notice?: string | null
  ): Promise<Response> => {
    const render = (options: OrgOption[]): Response =>
      renderPicker({
        options,
        error,
        revealed,
        ...(notice === undefined ? {} : { notice }),
      });
    try {
      return render(await fetchOrgOptions(deps, kiloToken));
    } catch {
      return renderPicker({
        options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
        error: error ?? ORG_LIST_UNAVAILABLE_MESSAGE,
        revealed,
        ...(notice === undefined ? {} : { notice }),
      });
    }
  };

  /** Bind the chosen context and complete the authorize; stops on a lost race. */
  const approveAndRedirect = async (
    organizationId: string | null,
    adminEnabled: boolean,
    renderRetry: (message: string) => Response
  ): Promise<Response> => {
    const approved = await deps.store.approvePendingAuthorization(
      record.deviceAuthCode,
      { kiloUserId: record.kiloUserId, organizationId },
      nowIso
    );
    if (!approved) {
      // Lost the race to a concurrent submit or an expiry: stop, do not
      // complete. The store's pending->approved guard makes a re-completion
      // impossible.
      return errorPage('invalid_request', STALE_REQUEST_MESSAGE);
    }
    let redirectTo: string;
    try {
      // The DCR client record's TTL is anchored at registration, but the grant
      // this authorization is about to mint can start much later. Re-put the
      // record here so `client:<id>` is anchored to the grant it serves and its
      // session+margin lifetime (session-lifetime.ts) always outlives the
      // session: without this a sign-in that starts more than the margin after
      // registration would outlive its own record and be refused as
      // `401 invalid_client`, which no MCP client re-authorizes on. Renewing
      // before the code is minted keeps a renewal failure retryable, exactly
      // like a failed completion.
      await env.OAUTH_PROVIDER.updateClient(record.authRequest.clientId, {});
      ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: record.authRequest,
        userId: record.kiloUserId,
        metadata: { clientName },
        scope: [MCP_SCOPE],
        props: {
          kiloUserId: record.kiloUserId,
          organizationId,
          kiloToken: record.kiloToken,
          clientId: record.authRequest.clientId,
          adminEnabled,
          // Whether the owner was an admin when this grant was minted. Fail-
          // closed: an unreachable/failed check left it false, and grants minted
          // before this key existed carry no key at all (also treated as false).
          adminEligible,
          // The connection identity every grant carries, admin or not: a
          // protected request binds to the session that created it, so another
          // session can never submit its OTP. Minted fresh on every grant.
          sessionId: crypto.randomUUID(),
        },
      }));
    } catch {
      // The library could not mint the code, or the client record could not be
      // renewed. The record is 'approved' and would reject every future picker
      // submit, so release it back to retryable 'pending' (keeping the paired
      // identity) and let the same user retry. A concurrent
      // completion/denial/expiry wins the guard: then the request really is
      // over and the terminal error page is correct.
      const released = await deps.store.releasePendingAuthorization(id, nowIso);
      return released
        ? renderRetry(
            'Could not finish connecting to Kilo right now. Choose the account again to retry.'
          )
        : errorPage('invalid_request', STALE_REQUEST_MESSAGE);
    }
    const completed = await deps.store.completePendingAuthorization(id, nowIso);
    if (!completed) {
      // The terminal transition (approved -> completed) was rejected: the
      // record expired or a concurrent submit completed it first. Never
      // redirect or emit a success event for a transition that did not happen.
      return errorPage('invalid_request', STALE_REQUEST_MESSAGE);
    }
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
    // Retryable unhappy: the org list is a live read, so the personal context
    // stays selectable and the same submit completes the flow on retry.
    return orgListPage(null);
  }

  // POST. The personal context is always valid for an approved Kilo login, so
  // it must not depend on the live membership read.
  const form = await request.formData().catch(() => null);
  // Read the opt-in and the code tolerantly: only a string is inspected, so a
  // non-text form value cannot fail the whole parse.
  const adminField = form?.get('admin_enabled');
  const otpField = form?.get('otp_code');
  const parsedForm = orgPickerFormSchema.safeParse({
    organization_id: form?.get('organization_id') ?? '',
    admin_enabled: typeof adminField === 'string' ? adminField : undefined,
    otp_code: typeof otpField === 'string' ? otpField : undefined,
  });
  if (!parsedForm.success) {
    // Missing or malformed selection: re-render the picker with a prompt when
    // the org list is reachable, else offer the (still valid) personal context.
    return orgListPage('Choose an account to continue.');
  }
  // The operator ticked the admin opt-in but the eligibility check could not
  // run: honoring it is impossible (fail-closed) and silently completing with
  // `adminEnabled: false` would merge a retryable failure into the happy path.
  // Re-render the picker with the same reload notice as the GET instead of
  // connecting. `approvePendingAuthorization` has not run, so the pending
  // record is untouched and this exact submit can be retried after a reload;
  // `approveAndRedirect` is never reached on this branch. A POST without the
  // box never lands here: leaving it unticked always connects.
  if (parsedForm.data.admin_enabled === 'on' && adminCheckFailed) {
    return orgListPage(null, false, ADMIN_CHECK_NOTICE);
  }
  // The POST re-derives admin eligibility above instead of trusting the
  // submitted checkbox, the same way it re-checks the org membership: a client
  // could otherwise grant itself admin procedures by editing the form, and only
  // the literal `on` from an eligible identity counts.
  const wantsAdmin = parsedForm.data.admin_enabled === 'on' && adminEligible;
  const submitted = parsedForm.data.organization_id;

  // The per-request authenticator read above is the gate's truth: an admin
  // whose authenticator is already verified sees the ticked checkbox and no
  // code field, so a ticked box mints with no code at all.
  const verifiedAuthenticator = authenticator?.verified === true;

  // The OTP gate for a ticked opt-in, and only before the authenticator is
  // verified. Once it is, the checkbox alone toggles the feature: `otp_code` is
  // never read and `confirmAuthenticator` is never called, so an enrolled
  // admin connects on the tick alone. For the unverified admin a missing code
  // or one that fails to verify re-renders the picker with the enrolment
  // subsection revealed and mints nothing — no `approvePendingAuthorization`,
  // no `completeAuthorization` — so the same submit can be retried with the
  // right code; the accepted code there is what marks the authenticator
  // verified. `otp_code` is ignored entirely when the box is not ticked.
  if (wantsAdmin && !verifiedAuthenticator) {
    const code = (parsedForm.data.otp_code ?? '').trim();
    if (code.length === 0) {
      return orgListPage(OTP_REQUIRED_MESSAGE, true);
    }
    if (!(await deps.store.confirmAuthenticator(record.kiloUserId, code, nowIso))) {
      return orgListPage(OTP_INVALID_MESSAGE, true);
    }
  }

  if (submitted === PERSONAL_ORG_ID) {
    return approveAndRedirect(null, wantsAdmin, message => personalOnlyPage(message));
  }
  // Concrete orgs stay validated against the freshly-fetched membership list:
  // a client cannot authorize an org it is not a member of by editing the form.
  let options: OrgOption[];
  try {
    options = await fetchOrgOptions(deps, kiloToken);
  } catch {
    return personalOnlyPage(ORG_LIST_UNAVAILABLE_MESSAGE);
  }
  const chosen = options.find(option => option.id === submitted);
  if (!chosen) {
    return renderPicker({ options, error: 'That organization is not available for this account.' });
  }
  return approveAndRedirect(
    chosen.id === PERSONAL_ORG_ID ? null : chosen.id,
    wantsAdmin,
    (message: string) => renderPicker({ options, error: message })
  );
}

/**
 * Build the application `defaultHandler` for the OAuth provider. The provider
 * routes its own protocol endpoints (token/registration/metadata) here first;
 * every other path 404s.
 */
export function createDefaultHandler(deps: ConsentDeps): ExportedHandler<Env> {
  return {
    async fetch(request, env, _ctx): Promise<Response> {
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
