/**
 * Browser binding for the library-backed OAuth flow (s3).
 *
 * The pending-authorization `id` is handed to and polled by the user agent
 * that opened /authorize, so it cannot by itself prove that the requests to
 * /authorize/status and /authorize/org come from that same browser. The flow
 * cookie closes that gap: GET /authorize sets an unpredictable token as an
 * HttpOnly cookie and stores it on the pending record; the status and picker
 * routes refuse a record whose cookie does not match.
 *
 * The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/` with the same
 * lifetime as the pending record. Deliberately no `__Host-` prefix: the local
 * dev worker serves plain http, where browsers discard prefixed (and Secure)
 * cookies — the binding strength is the random token, not the name.
 */

import { PENDING_TTL_SECONDS } from './consent';

/** The cookie that binds the consent flow to the browser that started it. */
export const FLOW_COOKIE_NAME = 'kilo_mcp_flow';

/** `Set-Cookie` value for a fresh flow, lifetime matched to the pending record. */
export function flowCookieHeader(token: string): string {
  return `${FLOW_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${PENDING_TTL_SECONDS}`;
}

/** The cookie's token from an untrusted `Cookie` header, or null when absent. */
export function flowCookieToken(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === FLOW_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
