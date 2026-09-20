import type { ForwardedAuth, GrantProps } from './types';

/**
 * Organization header name. Mirrors ORGANIZATION_ID_HEADER in
 * apps/web/src/lib/constants.ts:19 — apps/web reads it to scope identity to an
 * org (apps/web/src/lib/user/server.ts). Keep in sync if the web constant ever
 * changes.
 */
export const ORGANIZATION_ID_HEADER = 'x-kilocode-organizationid';

/**
 * Build the credentials to forward to apps/web from the props the OAuth
 * provider resolved for this request (see `src/index.ts`). The library
 * authenticated the bearer before the API handler runs — either by decrypting a
 * grant it issued, or by resolving a signed-in app's session token through
 * `verifyKiloSessionToken` — so the props are the only source of identity: a
 * caller-supplied bearer or organization header is never consulted.
 *
 * Never log the returned value; `authorization` embeds a live Kilo token.
 */
export function forwardedAuthFromProps(props: GrantProps): ForwardedAuth {
  return {
    authorization: `Bearer ${props.kiloToken}`,
    organizationId: props.organizationId ?? undefined,
    kiloUserId: props.kiloUserId,
    clientId: props.clientId,
  };
}

/** How long to wait for apps/web to answer before treating a token as unresolved. */
const VERIFY_TOKEN_TIMEOUT_MS = 5_000;

/** Options for `verifyKiloSessionToken`; `fetchImpl` is injectable for tests. */
export type VerifyKiloSessionTokenOptions = {
  /** Base URL of apps/web, e.g. `https://app.kilo.ai` (the worker's WEB_BASE_URL). */
  webBaseUrl: string;
  /** The raw Kilo session token the signed-in app holds. Never logged. */
  token: string;
  /** Injectable fetch; defaults to the runtime's global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Verify a Kilo session token the signed-in app already holds — no key pasted
 * and no URL typed — by asking apps/web's `GET /api/user`
 * (apps/web/src/app/api/user/route.ts), which runs the same `getUserFromAuth`
 * the rest of the API uses. apps/web is the only trust anchor: a 2xx JSON body
 * with a non-empty string `id` is the identity, and everything else — a
 * non-2xx response, a malformed body, a timeout, or a network error — is
 * `null`.
 *
 * The token is never logged, and the thrown cause is swallowed into `null`
 * rather than put on the wire, so the worker's error responses stay generic.
 */
export async function verifyKiloSessionToken(
  options: VerifyKiloSessionTokenOptions
): Promise<{ kiloUserId: string } | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${options.webBaseUrl}/api/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
      // The identity must come from apps/web itself; a redirect would be a
      // different host answering for the token.
      redirect: 'manual',
      signal: AbortSignal.timeout(VERIFY_TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const id = (body as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.length === 0) return null;
    return { kiloUserId: id };
  } catch {
    // Non-2xx, malformed body, timeout and transport errors all answer the same
    // way. Swallow the cause: it could carry the request (and so the bearer).
    return null;
  }
}
