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
 * One cookie per pending record (the name carries the record id): two
 * authorizations running side by side in one browser keep separate cookies
 * instead of overwriting each other. The binding is the token value; the id
 * in the name only addresses the right cookie, so a known id without the
 * token still matches nothing.
 *
 * The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/` with the same
 * lifetime as the pending record. Deliberately no `__Host-` prefix: the local
 * dev worker serves plain http, where browsers discard prefixed (and Secure)
 * cookies — the binding strength is the random token, not the name.
 */

/** Pending records are short-lived: 10 minutes to complete sign-in. */
export const PENDING_TTL_SECONDS = 600;

/** The shared prefix of every per-record flow cookie name. */
const FLOW_COOKIE_PREFIX = 'kilo_mcp_flow_';

/** The cookie name for one pending record's flow binding. */
export function flowCookieName(id: string): string {
  return `${FLOW_COOKIE_PREFIX}${id}`;
}

/** `Set-Cookie` value for a fresh flow, lifetime matched to the pending record. */
export function flowCookieHeader(id: string, token: string): string {
  return `${flowCookieName(id)}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${PENDING_TTL_SECONDS}`;
}

/** The record's cookie token from an untrusted `Cookie` header, or null. */
export function flowCookieToken(cookieHeader: string | null, id: string): string | null {
  if (cookieHeader === null) return null;
  const name = `${flowCookieName(id)}=`;
  for (const part of cookieHeader.split(';')) {
    const candidate = part.trim();
    if (candidate.startsWith(name)) {
      const value = candidate.slice(name.length).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
