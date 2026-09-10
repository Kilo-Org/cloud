/**
 * POST /token — the OAuth token endpoint for THIS MCP (RFC 6749 + RFC 8707).
 *
 * `authorization_code` grant: single-use code (atomically consumed), PKCE
 * S256 verifier check, client_id + redirect_uri match against the stored
 * record, resource-indicator binding. Issues an HMAC-signed JWT access token
 * bound to user + org + this MCP (requirement 18):
 * `{ iss, sub, org, aud, client_id, exp, jti }`.
 *
 * `refresh_token` grant: the opaque refresh token is stored only as a
 * SHA-256 hash and rotated on every use (the old row is revoked atomically).
 * Replaying a rotated-away token revokes the whole grant (RFC 9700 §2.2.2).
 *
 * Errors follow RFC 6749 §5.2: `invalid_request`, `invalid_client`,
 * `invalid_grant`, `unsupported_grant_type`, plus `invalid_target` (RFC 8707)
 * for a wrong resource indicator. Responses are `Cache-Control: no-store`.
 * Never log a token from this module.
 */
import { signJwt } from './jwt';
import { base64UrlEncode, isValidCodeVerifier, verifyPkceS256 } from './pkce';
import { MCP_SCOPE, oauthErrorResponse, authJsonResponse } from './http';
import type { OAuthStoreApi } from '../store/oauth-store';

export type TokenDeps = {
  store: OAuthStoreApi;
  /** HMAC secret for signing access tokens (wrangler secret, never logged). */
  tokenSecret: string;
  /** This worker's origin for the current request — the JWT `iss`. */
  issuer: string;
  now?: () => Date;
};

/** Access tokens are short-lived; revocation is via the jti registry. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
/** Refresh tokens live for 30 days and rotate on every use. */
export const REFRESH_TOKEN_TTL_DAYS = 30;

type GrantParams = Record<string, string>;

/** Accept RFC 6749 form-encoding; tolerate JSON bodies from spec-lax clients. */
export async function parseTokenRequest(request: Request): Promise<GrantParams | null> {
  const text = await request.text();
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const body: unknown = JSON.parse(text);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
      const params: GrantParams = {};
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (typeof value === 'string') params[key] = value;
      }
      return params;
    } catch {
      return null;
    }
  }
  try {
    const form = new URLSearchParams(text);
    if (![...form.keys()].some(key => key === 'grant_type')) return null;
    const params: GrantParams = {};
    for (const [key, value] of form.entries()) params[key] = value;
    return params;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function opaqueToken(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

type IssuedTokenPair = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

type TokenGrant = {
  kiloUserId: string;
  organizationId: string | null;
  /** The Kilo credential this grant forwards as (s6); carried across rotations. */
  kiloToken: string | null;
  clientId: string;
  resource: string;
  scope: string;
};

/** Mint the HMAC-signed MCP access token (claims per requirement 18). */
async function signAccessToken(deps: TokenDeps, grant: TokenGrant, now: Date): Promise<string> {
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  return signJwt(
    {
      iss: deps.issuer,
      sub: grant.kiloUserId,
      org: grant.organizationId,
      aud: grant.resource,
      client_id: grant.clientId,
      exp: Math.floor(expiresAt.getTime() / 1000),
      jti: opaqueToken(16),
    },
    deps.tokenSecret
  );
}

/** Store the opaque refresh token (hashed) and build the client-facing pair. */
async function issueTokenPair(
  deps: TokenDeps,
  grant: TokenGrant,
  refreshToken: string,
  now: Date
): Promise<IssuedTokenPair> {
  await deps.store.saveRefreshToken({
    id: opaqueToken(16),
    tokenHash: await sha256Hex(refreshToken),
    clientId: grant.clientId,
    kiloUserId: grant.kiloUserId,
    organizationId: grant.organizationId,
    kiloToken: grant.kiloToken,
    resource: grant.resource,
    scope: grant.scope,
    createdAt: now.toISOString(),
    expiresAt: refreshExpiresAt(now),
  });
  return {
    access_token: await signAccessToken(deps, grant, now),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: grant.scope,
  };
}

function refreshExpiresAt(now: Date): string {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** `resource` must equal the stored indicator when present (RFC 8707). */
function checkResourceBinding(params: GrantParams, boundResource: string): Response | null {
  const requested = params['resource'];
  if (requested !== undefined && requested !== boundResource) {
    return oauthErrorResponse(
      400,
      'invalid_target',
      'The resource indicator does not match the resource this grant was bound to.'
    );
  }
  return null;
}

async function exchangeAuthorizationCode(
  deps: TokenDeps,
  params: GrantParams,
  now: Date
): Promise<Response> {
  const code = params['code'];
  const clientId = params['client_id'];
  const redirectUri = params['redirect_uri'];
  const verifier = params['code_verifier'];
  if (!code || !clientId || !redirectUri || !verifier) {
    return oauthErrorResponse(
      400,
      'invalid_request',
      'code, client_id, redirect_uri and code_verifier are all required for the authorization_code grant.'
    );
  }
  const client = await deps.store.getClient(clientId);
  if (!client) {
    return oauthErrorResponse(400, 'invalid_client', 'Unknown client_id.');
  }

  const record = await deps.store.getCode(code);
  if (!record) {
    return oauthErrorResponse(400, 'invalid_grant', 'Unknown authorization code.');
  }
  if (record.clientId !== clientId) {
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This authorization code was issued to a different client.'
    );
  }
  const resourceError = checkResourceBinding(params, record.resource);
  if (resourceError) return resourceError;
  if (record.redirectUri !== redirectUri) {
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'redirect_uri does not match the authorization request.'
    );
  }
  if (record.status === 'pending') {
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'The user has not completed sign-in for this request yet. Retry after the user approves.'
    );
  }
  if (record.status === 'denied') {
    return oauthErrorResponse(400, 'invalid_grant', 'The user denied this authorization request.');
  }
  const nowIso = now.toISOString();
  if (record.status === 'used') {
    // Retryable unhappy path: the client must run a fresh /authorize.
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This authorization code has already been used. Start a new authorization.'
    );
  }
  if (record.expiresAt <= nowIso) {
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This authorization code has expired. Start a new authorization.'
    );
  }
  if (!isValidCodeVerifier(verifier) || !(await verifyPkceS256(verifier, record.codeChallenge))) {
    return oauthErrorResponse(400, 'invalid_grant', 'PKCE verification failed.');
  }
  if (!record.kiloUserId) {
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This authorization code has no approved identity.'
    );
  }
  if (!record.kiloToken) {
    // s6: the pairing approval always records the Kilo credential; without it
    // the issued token could never forward, so refuse to mint it.
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This authorization code is missing its Kilo session. Start a new authorization.'
    );
  }

  // Atomic single-use consumption; a concurrent exchange loses here.
  const consumed = await deps.store.consumeCode(code, nowIso);
  if (!consumed) {
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This authorization code has already been used. Start a new authorization.'
    );
  }

  const pair = await issueTokenPair(
    deps,
    {
      kiloUserId: consumed.kiloUserId ?? record.kiloUserId,
      organizationId: consumed.organizationId,
      clientId,
      kiloToken: consumed.kiloToken ?? record.kiloToken,
      resource: consumed.resource,
      scope: consumed.scope,
    },
    opaqueToken(48),
    now
  );
  return authJsonResponse(pair, 200, { 'Cache-Control': 'no-store' });
}

async function redeemRefreshToken(
  deps: TokenDeps,
  params: GrantParams,
  now: Date
): Promise<Response> {
  const refreshToken = params['refresh_token'];
  const clientId = params['client_id'];
  if (!refreshToken || !clientId) {
    return oauthErrorResponse(
      400,
      'invalid_request',
      'refresh_token and client_id are required for the refresh_token grant.'
    );
  }
  const client = await deps.store.getClient(clientId);
  if (!client) {
    return oauthErrorResponse(400, 'invalid_client', 'Unknown client_id.');
  }
  const record = await deps.store.getRefreshTokenByHash(await sha256Hex(refreshToken));
  if (!record || record.clientId !== clientId) {
    return oauthErrorResponse(400, 'invalid_grant', 'Unknown refresh token.');
  }
  const resourceError = checkResourceBinding(params, record.resource);
  if (resourceError) return resourceError;
  const scope = params['scope'];
  if (scope !== undefined) {
    const wanted = scope.split(' ').filter(token => token.length > 0);
    const granted = record.scope.split(' ').filter(token => token.length > 0);
    if (wanted.length === 0 || !wanted.every(token => granted.includes(token))) {
      return oauthErrorResponse(
        400,
        'invalid_scope',
        `Requested scope exceeds the granted "${MCP_SCOPE}" scope.`
      );
    }
  }
  const nowIso = now.toISOString();
  if (record.revokedAt || record.expiresAt <= nowIso) {
    // Rotated-away-with or expired token: retryable only with a fresh login.
    // A replayed rotated-away token is evidence the grant was stolen (the
    // legitimate client only ever holds the newest rotation), so RFC 9700
    // §2.2.2 requires revoking the whole grant: the thief's newer tokens die
    // with the replay, and resolveKiloToken finds no live grant left. A merely
    // expired token is not theft evidence, so the family stays intact.
    if (record.revokedAt) {
      await deps.store.revokeGrant(
        {
          clientId: record.clientId,
          kiloUserId: record.kiloUserId,
          organizationId: record.organizationId,
          resource: record.resource,
        },
        nowIso
      );
    }
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This refresh token is no longer valid. Reconnect to start a new authorization.'
    );
  }

  const newRefreshToken = opaqueToken(48);
  const rotated = await deps.store.rotateRefreshToken(
    record.id,
    {
      id: opaqueToken(16),
      tokenHash: await sha256Hex(newRefreshToken),
      clientId: record.clientId,
      kiloUserId: record.kiloUserId,
      organizationId: record.organizationId,
      // The forward credential survives rotation (s6).
      kiloToken: record.kiloToken,
      resource: record.resource,
      scope: record.scope,
      createdAt: nowIso,
      expiresAt: new Date(
        now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
      ).toISOString(),
    },
    nowIso
  );
  if (!rotated) {
    return oauthErrorResponse(
      400,
      'invalid_grant',
      'This refresh token was already rotated. Use the latest token.'
    );
  }

  // rotateRefreshToken already stored the new refresh row; only the access
  // token is minted here.
  const pair: IssuedTokenPair = {
    access_token: await signAccessToken(
      deps,
      {
        kiloUserId: record.kiloUserId,
        organizationId: record.organizationId,
        kiloToken: record.kiloToken,
        clientId: record.clientId,
        resource: record.resource,
        scope: record.scope,
      },
      now
    ),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefreshToken,
    scope: record.scope,
  };
  return authJsonResponse(pair, 200, { 'Cache-Control': 'no-store' });
}

/** POST /token. */
export async function handleToken(request: Request, deps: TokenDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthErrorResponse(405, 'invalid_request', 'Use POST for /token.');
  }
  const params = await parseTokenRequest(request);
  if (!params) {
    return oauthErrorResponse(
      400,
      'invalid_request',
      'Body must be a form-encoded (or JSON) OAuth parameter set.'
    );
  }
  const now = deps.now?.() ?? new Date();
  switch (params['grant_type']) {
    case 'authorization_code':
      return exchangeAuthorizationCode(deps, params, now);
    case 'refresh_token':
      return redeemRefreshToken(deps, params, now);
    default:
      return oauthErrorResponse(
        400,
        'unsupported_grant_type',
        'Only authorization_code and refresh_token grants are supported.'
      );
  }
}
