/**
 * GET /authorize — the OAuth authorization endpoint for THIS MCP.
 *
 * The worker has no user session of its own: apps/web stays the user-identity
 * provider. So /authorize validates the request strictly (registered client,
 * exact redirect_uri, mandatory S256 PKCE, RFC 8707 resource indicator,
 * scope), creates a short-lived single-use pairing record, opens a Kilo
 * device-auth pairing via apps/web, and returns the consent page (rendered by
 * src/oauth-pages/authorize-page.ts) that links the user to
 * `{WEB_BASE_URL}/device-auth?code=<pairingCode>` and polls this worker for
 * pairing status until the user signs in, picks an org, and the client is
 * redirected with the code (s6).
 */
import { base64UrlEncode, isValidCodeChallenge } from './pkce';
import { mcpResourceUrl } from './metadata';
import {
  MCP_SCOPE,
  errorPage,
  redirectToClientError,
  normalizeScope,
  onlyMcpScope,
  scopeTokens,
} from './http';
import { consentPage } from '../oauth-pages/authorize-page';
import type { OAuthStoreApi, StoredClient } from '../store/oauth-store';

export type AuthorizeDeps = {
  store: OAuthStoreApi;
  /** apps/web base URL — the user-identity provider (sign-in-with-Kilo page). */
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/** Pairing records are short-lived: 10 minutes to complete sign-in. */
export const CODE_TTL_SECONDS = 600;
const MAX_STATE_LENGTH = 512;

/** Redirect-with-error for failures after client + redirect_uri are trusted (RFC 6749 §4.1.2.1). */
class AuthorizeRedirectError extends Error {
  constructor(
    readonly redirectUri: string,
    readonly error: string,
    readonly description: string,
    readonly state: string | null
  ) {
    super(error);
    this.name = 'AuthorizeRedirectError';
  }
}

/** Non-redirectable validation failure — rendered as an error page. */
class AuthorizePageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizePageError';
  }
}

export type ValidatedAuthorizeRequest = {
  client: StoredClient;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string | null;
};

/**
 * Validate an authorization request. Client_id / redirect_uri failures return
 * an error page (never a redirect — an unvalidated redirect target is a
 * phishing vector, RFC 6749 §4.1.2.1); protocol failures after the client is
 * trusted throw AuthorizeRedirectError so the caller can send the client home
 * with `?error=`.
 */
export async function validateAuthorizeRequest(
  url: URL,
  store: OAuthStoreApi,
  issuer: string
): Promise<ValidatedAuthorizeRequest> {
  const params = url.searchParams;
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');

  if (!clientId) {
    throw new AuthorizePageError(
      'Missing client_id. Register this client through /register first.'
    );
  }
  const client = await store.getClient(clientId);
  if (!client) {
    throw new AuthorizePageError(
      'Unknown client_id. Register this client through /register before starting sign-in.'
    );
  }
  if (!redirectUri) {
    throw new AuthorizePageError('Missing redirect_uri.');
  }
  if (!client.redirectUris.includes(redirectUri)) {
    throw new AuthorizePageError(
      "redirect_uri does not exactly match one of this client's registered redirect URIs."
    );
  }
  // From here on the redirect target is trusted: errors ride the redirect.
  const fail = (error: string, description: string): never => {
    throw new AuthorizeRedirectError(redirectUri, error, description, state);
  };

  if (params.get('response_type') !== 'code') {
    fail('unsupported_response_type', 'Only response_type=code is supported.');
  }
  const codeChallenge = params.get('code_challenge');
  if (!isValidCodeChallenge(codeChallenge) || params.get('code_challenge_method') !== 'S256') {
    // PKCE is mandatory and S256 is the only accepted method (requirement 16).
    fail(
      'invalid_request',
      'PKCE is required: send code_challenge (43..128 base64url chars) with code_challenge_method=S256.'
    );
  }
  const resource = mcpResourceUrl(issuer);
  const requestedResource = params.get('resource');
  if (requestedResource !== null && !sameResource(requestedResource, resource)) {
    fail('invalid_target', 'The resource indicator must identify this MCP server.');
  }
  const scope = params.get('scope');
  if (scope !== null && !onlyMcpScope(scopeTokens(scope))) {
    fail('invalid_scope', `Only the "${MCP_SCOPE}" scope is available.`);
  }
  if (state !== null && state.length > MAX_STATE_LENGTH) {
    fail('invalid_request', `state must be at most ${MAX_STATE_LENGTH} characters.`);
  }

  return {
    client,
    redirectUri,
    codeChallenge: codeChallenge as string,
    resource,
    scope: scope !== null && scope.trim().length > 0 ? normalizeScope(scope) : MCP_SCOPE,
    state,
  };
}

/** Trailing-slash-tolerant comparison against the canonical resource URL. */
export function sameResource(candidate: string, canonical: string): boolean {
  if (candidate === canonical) return true;
  try {
    const a = new URL(candidate);
    const b = new URL(canonical);
    if (
      a.origin !== b.origin ||
      a.search !== '' ||
      a.hash !== '' ||
      b.search !== '' ||
      b.hash !== ''
    ) {
      return false;
    }
    return a.pathname === b.pathname || a.pathname === `${b.pathname}/`;
  } catch {
    return false;
  }
}

export type KiloPairingFailure = 'rate_limited' | 'unreachable';

/**
 * Create the Kilo device-auth pairing on apps/web
 * (`POST /api/device-auth/codes`, apps/web/src/app/api/device-auth/codes/route.ts).
 * apps/web rate-limits pending pairings per IP and requires the client IP in
 * production, so the incoming request's IP and user-agent are forwarded.
 */
export async function createKiloPairing(
  deps: AuthorizeDeps,
  request: Request
): Promise<{ ok: true; pairingCode: string } | { ok: false; kind: KiloPairingFailure }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.webBaseUrl.replace(/\/$/, '')}/api/device-auth/codes`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const clientIp =
    request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for');
  if (clientIp) headers['x-forwarded-for'] = clientIp;
  const userAgent = request.headers.get('user-agent');
  if (userAgent) headers['user-agent'] = userAgent;

  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body: '{}' });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (response.status === 429) return { ok: false, kind: 'rate_limited' };
  if (!response.ok) return { ok: false, kind: 'unreachable' };

  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, kind: 'unreachable' };
  }
  return { ok: true, pairingCode: code };
}

/** GET /authorize — consent page for a valid authorization request. */
export async function handleAuthorize(request: Request, deps: AuthorizeDeps): Promise<Response> {
  if (request.method !== 'GET') {
    return errorPage('invalid_request', 'Use GET for /authorize.');
  }
  const url = new URL(request.url);
  const issuer = url.origin;

  let validated: ValidatedAuthorizeRequest;
  try {
    validated = await validateAuthorizeRequest(url, deps.store, issuer);
  } catch (error) {
    if (error instanceof AuthorizePageError) {
      return errorPage('invalid_request', error.message);
    }
    if (error instanceof AuthorizeRedirectError) {
      return redirectToClientError(error.redirectUri, error.error, error.description, error.state);
    }
    throw error;
  }

  const pairing = await createKiloPairing(deps, request);
  if (!pairing.ok) {
    // Retryable unhappy path: nothing was created; tell the user exactly what
    // to do (wait vs check connection) and send them back to the client.
    const description =
      pairing.kind === 'rate_limited'
        ? 'Too many pending Kilo sign-in requests from your network right now. Wait a few minutes, then retry from your MCP client.'
        : 'Kilo sign-in could not be reached. Check your connection, then retry from your MCP client.';
    return errorPage('temporarily_unavailable', description, 503);
  }

  const now = deps.now?.() ?? new Date();
  const code = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  await deps.store.createCode({
    code,
    clientId: validated.client.clientId,
    redirectUri: validated.redirectUri,
    codeChallenge: validated.codeChallenge,
    resource: validated.resource,
    scope: validated.scope,
    state: validated.state,
    deviceAuthCode: pairing.pairingCode,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString(),
  });

  return consentPage({
    clientName: validated.client.clientName,
    scope: validated.scope,
    webSignInUrl: `${deps.webBaseUrl.replace(/\/$/, '')}/device-auth?code=${encodeURIComponent(pairing.pairingCode)}`,
    statusUrl: `/authorize/status?code=${encodeURIComponent(code)}`,
    // Restarting means re-running this exact authorization request: it mints
    // a fresh pairing and a fresh consent page.
    restartUrl: request.url,
  });
}
