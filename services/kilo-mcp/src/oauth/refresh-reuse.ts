import { z } from 'zod';
/**
 * The history has to outlive the grant it describes. The provider accepts the
 * current and the immediately previous refresh token, and the guard forwards
 * both; a hash older than that is a replay the guard revokes. A replay that
 * arrives late in a dormant session must still be recognised, so the window is
 * tied to the session bound (one month), not a shorter fixed one.
 */
import { REFRESH_HISTORY_TTL_MS } from './session-lifetime';
import { REFRESH_TOKEN_REUSE_DETAIL } from '../analytics';
import type { McpAnalytics } from '../analytics';

export const TOKEN_ENDPOINT_PATH = '/token';

/** Size limit for a form-encoded token request body. */
export const TOKEN_REQUEST_MAX_BYTES = 16 * 1024;

export type RefreshTokenParts = { userId: string; grantId: string };
export type IssuedRefreshToken = RefreshTokenParts & { current: boolean; previous: boolean };

/** Request-scoped facts the guard hands to the provider handler it forwards to. */
export type TokenRequestContext = {
  /** The account id in the presented refresh token's prefix; unauthenticated. */
  tokenUserId: string | null;
};

/** Strongly consistent DO SQLite state, not eventually consistent Workers KV. */
export type RefreshReuseStore = {
  getRefreshToken(hash: string, nowIso: string): Promise<IssuedRefreshToken | null>;
  /**
   * Records a newly issued hash. `presentedHash` is the hash the client sent in
   * a `refresh_token` exchange (null for an authorization-code exchange): the
   * provider accepts that token once more after rotating, so it becomes the
   * grant's previous token.
   */
  rememberRefreshToken(
    hash: string,
    parts: RefreshTokenParts,
    expiresAt: string,
    presentedHash: string | null
  ): Promise<void>;
  /**
   * Drop every hash recorded for a grant. The revoke path owns this cleanup, so
   * a revoked grant does not hold DO rows until the history TTL expires.
   */
  forgetRefreshTokens(parts: RefreshTokenParts): Promise<void>;
};

export type RefreshReuseDeps = {
  store: RefreshReuseStore;
  revokeGrant(grantId: string, userId: string): Promise<void>;
  /**
   * Sign-in telemetry, created lazily because only a reuse rejection emits.
   * The rejection answers from the Durable Object before the provider runs, so
   * it never reaches the provider's `onError` hook; without this the one path
   * that destroys a session is the only one invisible in production logs.
   */
  analytics?: () => McpAnalytics;
};

const tokenPartsSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);
const issuedResponseSchema = z.object({ refresh_token: z.string().min(1) });

type TokenBody =
  | { kind: 'too_large' }
  | { kind: 'form'; params: URLSearchParams; body: Uint8Array }
  | { kind: 'other'; body: Uint8Array };

const isFormEncoded = (request: Request): boolean =>
  (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ===
  'application/x-www-form-urlencoded';

/**
 * Reads a token request body under `TOKEN_REQUEST_MAX_BYTES`. The bytes come from
 * the request itself; `forwardable` rebuilds the request from them.
 */
export async function readTokenBody(request: Request): Promise<TokenBody> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > TOKEN_REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => {});
    return { kind: 'too_large' };
  }
  const reader = request.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > TOKEN_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: 'too_large' };
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return isFormEncoded(request)
    ? { kind: 'form', params: new URLSearchParams(new TextDecoder().decode(body)), body }
    : { kind: 'other', body };
}

/** The request to hand on after `readTokenBody` took its body. */
export function forwardable(request: Request, body: Uint8Array): Request {
  return new Request(request, { body });
}

/** Used only on tokens issued by the library, never as proof of ownership. */
export function parseRefreshToken(token: string): RefreshTokenParts | null {
  const parsed = tokenPartsSchema.safeParse(token.split(':'));
  if (!parsed.success) return null;
  const [userId, grantId] = parsed.data;
  return { userId, grantId };
}

/** Bound on the account id telemetry may carry; a real id is far shorter. */
const TOKEN_USER_ID_MAX_LENGTH = 128;
const tokenUserIdSchema = z.string().min(1).max(TOKEN_USER_ID_MAX_LENGTH);

/**
 * The account id in a presented token's prefix, for attributing a failed
 * refresh. The prefix is unauthenticated input: it is never proof of anything,
 * and a missing, malformed, or over-long id yields null rather than a value.
 */
export function parseTokenUserId(token: string): string | null {
  const parsed = tokenUserIdSchema.safeParse(parseRefreshToken(token)?.userId);
  return parsed.success ? parsed.data : null;
}

export function isTokenRequest(request: Request): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === TOKEN_ENDPOINT_PATH;
}

/** The token itself is never persisted by the reuse guard. */
export async function hashRefreshToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function tokenErrorHeaders(request: Request): Record<string, string> {
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
  return headers;
}

function reuseDetectedResponse(request: Request): Response {
  return new Response(
    JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Refresh token reuse detected; the grant has been revoked.',
    }),
    { status: 400, headers: tokenErrorHeaders(request) }
  );
}

export function bodyTooLargeResponse(request: Request): Response {
  return new Response(
    JSON.stringify({
      error: 'invalid_request',
      error_description: `Request body must be at most ${TOKEN_REQUEST_MAX_BYTES} bytes.`,
    }),
    { status: 413, headers: tokenErrorHeaders(request) }
  );
}

/**
 * Decides from the form the client sent. A repeated parameter other than
 * `resource` is left to the library, which owns the duplicate-parameter
 * rejection.
 *
 * The library accepts the current and the immediately previous refresh token:
 * two clients can race a rotation, and a rotation response can be lost, so the
 * previous token is legitimate. Only a known token older than that is the
 * replay the library itself refuses; that is the one case revoked here.
 */
export async function detectRefreshTokenReuse(
  request: Request,
  params: URLSearchParams,
  deps: RefreshReuseDeps
): Promise<Response | null> {
  if ([...params.keys()].some(key => key !== 'resource' && params.getAll(key).length > 1)) {
    return null;
  }
  if (params.get('grant_type') !== 'refresh_token') return null;
  const refreshToken = params.get('refresh_token');
  if (!refreshToken) return null;
  const issued = await deps.store.getRefreshToken(
    await hashRefreshToken(refreshToken),
    new Date().toISOString()
  );
  // A mismatch with the latest token is NOT proof of replay. Only a full hash
  // of a previously issued token authenticates the stored grant identity, and
  // the provider still accepts the one it rotated away from last.
  if (!issued || issued.current || issued.previous) return null;
  await deps.revokeGrant(issued.grantId, issued.userId);
  // The grant is revoked now, so no hash of it can authenticate another replay:
  // forget the history rather than leaving it for the history TTL.
  await deps.store.forgetRefreshTokens({ userId: issued.userId, grantId: issued.grantId });
  // The provider never sees this request, so this event is the only record that
  // a live session was destroyed and why. It carries the account the grant
  // belonged to, never the grant id or either token.
  deps.analytics?.().oauthSignIn({
    phase: 'failed',
    identity: { kiloUserId: issued.userId, organizationId: null },
    reason: 'invalid_grant',
    detail: REFRESH_TOKEN_REUSE_DETAIL,
  });
  return reuseDetectedResponse(request);
}

/**
 * Records the rotation the library just performed. `presentedToken` is the
 * refresh token the client sent (null for an authorization-code exchange): the
 * provider keeps it acceptable as the previous token, so the history must too.
 */
export async function rememberIssuedRefreshToken(
  response: Response,
  deps: Pick<RefreshReuseDeps, 'store'>,
  presentedToken: string | null = null
): Promise<void> {
  if (!response.ok) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  const parsed = issuedResponseSchema.safeParse(body);
  if (!parsed.success) return;
  const token = parsed.data.refresh_token;
  const parts = parseRefreshToken(token);
  if (!parts) return;
  await deps.store.rememberRefreshToken(
    await hashRefreshToken(token),
    parts,
    new Date(Date.now() + REFRESH_HISTORY_TTL_MS).toISOString(),
    presentedToken === null ? null : await hashRefreshToken(presentedToken)
  );
}

/**
 * Instantiate ONCE in the named OAuth Durable Object. Its queue covers the
 * entire check → library rotation/revocation → durable history write, including
 * external awaits. An isolate-local queue in the Worker would not be sufficient.
 * Only token requests queue; MCP responses are never cloned or parsed here.
 *
 * `forward` receives the request-scoped context the provider hook needs to
 * attribute a failed refresh; nothing about it is persisted.
 */
export function createRefreshReuseHandler(deps: RefreshReuseDeps) {
  let pending: Promise<unknown> = Promise.resolve();
  return async (
    request: Request,
    forward: (request: Request, context: TokenRequestContext) => Promise<Response>
  ): Promise<Response> => {
    if (!isTokenRequest(request)) return forward(request, { tokenUserId: null });
    const body = await readTokenBody(request);
    if (body.kind === 'too_large') return bodyTooLargeResponse(request);
    const forwarded = forwardable(request, body.body);
    const presentedToken =
      body.kind === 'form' && body.params.get('grant_type') === 'refresh_token'
        ? (body.params.get('refresh_token') ?? null)
        : null;
    const context: TokenRequestContext = {
      tokenUserId: presentedToken ? parseTokenUserId(presentedToken) : null,
    };
    const response = pending.then(async () => {
      if (body.kind === 'form') {
        const rejected = await detectRefreshTokenReuse(request, body.params, deps);
        if (rejected) return rejected;
      }
      const result = await forward(forwarded, context);
      await rememberIssuedRefreshToken(result, deps, presentedToken);
      return result;
    });
    // A failed request must not poison the queue for subsequent retries.
    pending = response.catch(() => {});
    return response;
  };
}
