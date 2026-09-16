import { z } from 'zod';

export const TOKEN_ENDPOINT_PATH = '/token';

/** At least the provider's maximum grant lifetime (30 days). */
const REFRESH_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RefreshTokenParts = { userId: string; grantId: string };
export type IssuedRefreshToken = RefreshTokenParts & { current: boolean };

/** Strongly consistent DO SQLite state, not eventually consistent Workers KV. */
export type RefreshReuseStore = {
  getRefreshToken(hash: string, nowIso: string): Promise<IssuedRefreshToken | null>;
  rememberRefreshToken(hash: string, parts: RefreshTokenParts, expiresAt: string): Promise<void>;
};

export type RefreshReuseDeps = {
  store: RefreshReuseStore;
  revokeGrant(grantId: string, userId: string): Promise<void>;
};

const tokenPartsSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);
const refreshRequestSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
});
const issuedResponseSchema = z.object({ refresh_token: z.string().min(1) });

/** Used only on tokens issued by the library, never as proof of ownership. */
export function parseRefreshToken(token: string): RefreshTokenParts | null {
  const parsed = tokenPartsSchema.safeParse(token.split(':'));
  if (!parsed.success) return null;
  const [userId, grantId] = parsed.data;
  return { userId, grantId };
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

export async function detectRefreshTokenReuse(
  request: Request,
  deps: RefreshReuseDeps
): Promise<Response | null> {
  if (!isTokenRequest(request)) return null;
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return null;
  }
  const params = new URLSearchParams(await request.clone().text());
  // Match the library's duplicate-parameter rejection, rather than acting on
  // one interpretation of an ambiguous request.
  if ([...params.keys()].some(key => key !== 'resource' && params.getAll(key).length > 1)) {
    return null;
  }
  const parsed = refreshRequestSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return null;
  const issued = await deps.store.getRefreshToken(
    await hashRefreshToken(parsed.data.refresh_token),
    new Date().toISOString()
  );
  // A mismatch with the latest token is NOT proof of replay. Only a full hash
  // of a previously issued token authenticates the stored grant identity.
  if (!issued || issued.current) return null;
  await deps.revokeGrant(issued.grantId, issued.userId);
  return reuseDetectedResponse(request);
}

export async function rememberIssuedRefreshToken(
  response: Response,
  deps: Pick<RefreshReuseDeps, 'store'>
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
    new Date(Date.now() + REFRESH_HISTORY_TTL_MS).toISOString()
  );
}

/**
 * Instantiate ONCE in the named OAuth Durable Object. Its queue covers the
 * entire check → library rotation/revocation → durable history write, including
 * external awaits. An isolate-local queue in the Worker would not be sufficient.
 * Only token requests queue; MCP responses are never cloned or parsed here.
 */
export function createRefreshReuseHandler(deps: RefreshReuseDeps) {
  let pending: Promise<unknown> = Promise.resolve();
  return (
    request: Request,
    forward: (request: Request) => Promise<Response>
  ): Promise<Response> => {
    if (!isTokenRequest(request)) return forward(request);
    const response = pending.then(async () => {
      const rejected = await detectRefreshTokenReuse(request, deps);
      if (rejected) return rejected;
      const result = await forward(request);
      await rememberIssuedRefreshToken(result, deps);
      return result;
    });
    // A failed request must not poison the queue for subsequent retries.
    pending = response.catch(() => {});
    return response;
  };
}
