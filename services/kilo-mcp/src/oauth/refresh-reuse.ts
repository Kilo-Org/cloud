/**
 * Strict refresh-token reuse detection on top of the OAuth provider library.
 *
 * `@cloudflare/workers-oauth-provider` rotates refresh tokens on every use but
 * deliberately keeps the IMMEDIATELY PREVIOUS token valid ("one-step grace") so
 * a client that lost the refresh response can retry once. RFC 9700 (OAuth 2.0
 * Security BCP) instead requires the authorization server to treat a replayed,
 * superseded refresh token as a breach of the grant: reject it AND revoke every
 * token for that grant.
 *
 * This module adds that strict policy in front of the library's token endpoint:
 * it remembers the most recently issued refresh token's HASH per grant (never
 * the token itself) and, when a refresh request presents a different token for
 * a grant that already has a record, revokes the whole grant and answers
 * `invalid_grant`. The first refresh after a code exchange has no record yet,
 * so it is allowed and becomes the baseline.
 */

/** The library's token endpoint (`tokenEndpoint: '/token'` in src/index.ts). */
export const TOKEN_ENDPOINT_PATH = '/token';

/** KV key prefix for the most recently issued refresh token hash per grant. */
const LATEST_REFRESH_PREFIX = 'refresh-latest:';

/** Bookkeeping lifetime; matches the configured refreshTokenTTL (30 days). */
const LATEST_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The KV surface this module needs; `KVNamespace` satisfies it structurally. */
export type RefreshReuseKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type RefreshReuseDeps = {
  kv: RefreshReuseKv;
  /** Revoke every token for the grant; wired to OAuthHelpers.revokeGrant. */
  revokeGrant(grantId: string, userId: string): Promise<void>;
};

/** The pieces encoded in the library's `userId:grantId:secret` refresh token. */
export type RefreshTokenParts = { userId: string; grantId: string };

/**
 * Split the library's refresh token format. Tokens that do not match are left
 * to the library to reject; this guard only ever adds strictness for tokens it
 * can attribute to a grant.
 */
export function parseRefreshToken(token: string): RefreshTokenParts | null {
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [userId, grantId] = parts;
  if (!userId || !grantId) return null;
  return { userId, grantId };
}

/** Hex SHA-256 of a token. The token itself is never stored in KV. */
export async function hashRefreshToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function latestRefreshKey(userId: string, grantId: string): string {
  return `${LATEST_REFRESH_PREFIX}${userId}:${grantId}`;
}

/**
 * The token-endpoint error for a detected replay. Mirrors the library's own
 * error shape (`{error, error_description}`), no-cache headers, and CORS echo
 * so a browser-based public client can read it.
 */
function reuseDetectedResponse(request: Request): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  };
  const origin = request.headers.get('Origin');
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = '*';
    headers['Access-Control-Allow-Headers'] = 'Authorization, *';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return new Response(
    JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Refresh token reuse detected; the grant has been revoked.',
    }),
    { status: 400, headers }
  );
}

/**
 * Reject a refresh request whose token is not the one this server most recently
 * issued for its grant, revoking the grant first. Returns null when the request
 * is not a refresh exchange, carries no attributable token, or presents the
 * latest token (or the first token seen, before any record exists).
 */
export async function detectRefreshTokenReuse(
  request: Request,
  deps: RefreshReuseDeps
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== TOKEN_ENDPOINT_PATH) return null;

  const params = new URLSearchParams(await request.clone().text());
  if (params.get('grant_type') !== 'refresh_token') return null;
  const token = params.get('refresh_token');
  if (!token) return null;
  const parts = parseRefreshToken(token);
  if (!parts) return null;

  const latest = await deps.kv.get(latestRefreshKey(parts.userId, parts.grantId));
  if (latest === null) return null;
  if ((await hashRefreshToken(token)) === latest) return null;

  await deps.revokeGrant(parts.grantId, parts.userId);
  return reuseDetectedResponse(request);
}

/**
 * Remember the refresh token the library just issued so the next refresh can be
 * checked against it. Only successful token responses that carry a refresh
 * token are recorded; the stored value is a hash, never the token.
 */
export async function rememberIssuedRefreshToken(
  response: Response,
  deps: Pick<RefreshReuseDeps, 'kv'>
): Promise<void> {
  if (!response.ok) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  if (typeof body !== 'object' || body === null) return;
  const token = (body as Record<string, unknown>)['refresh_token'];
  if (typeof token !== 'string' || token.length === 0) return;
  const parts = parseRefreshToken(token);
  if (!parts) return;
  await deps.kv.put(latestRefreshKey(parts.userId, parts.grantId), await hashRefreshToken(token), {
    expirationTtl: LATEST_REFRESH_TTL_SECONDS,
  });
}

/**
 * Wrap the library's token endpoint with the strict reuse policy: reject a
 * replayed superseded token, otherwise forward and remember the new one.
 */
export async function forwardWithRefreshReuseDetection(
  request: Request,
  forward: (request: Request) => Promise<Response>,
  deps: RefreshReuseDeps
): Promise<Response> {
  const rejected = await detectRefreshTokenReuse(request, deps);
  if (rejected) return rejected;
  const response = await forward(request);
  await rememberIssuedRefreshToken(response, deps);
  return response;
}
