/**
 * Access service-token credentials for the e2e Worker's requests to its own
 * origin. e2e-only: referenced from `src/e2e-entry.ts`, never from production.
 *
 * The deployed e2e Worker has no public address; its only hostname sits behind
 * a Cloudflare Access application whose policy is Service Auth. Sandbox
 * containers reach the Worker at `WORKER_URL` (runtime artifacts, the
 * credential proxy facade, sandbox control), and their egress leaves through
 * `ContainersOutbound` with a global `fetch`. Under `global_fetch_strictly_public`
 * that request re-enters Cloudflare's front door like any Internet request, so
 * Access challenges it unless it carries the service token.
 */

const CLIENT_ID_HEADER = 'CF-Access-Client-Id';
const CLIENT_SECRET_HEADER = 'CF-Access-Client-Secret';

export type SelfAccessEnv = {
  WORKER_URL?: string;
  E2E_ACCESS_CLIENT_ID?: string;
  E2E_ACCESS_CLIENT_SECRET?: string;
};

/** `ws:`/`wss:` and `http:`/`https:` URLs of one host share an origin here. */
function isSelfOrigin(url: string, workerUrl: string): boolean {
  const origin = (value: string) => new URL(value.replace(/^ws(s?):/i, 'http$1:')).origin;
  return origin(url) === origin(workerUrl);
}

/**
 * Stamp the Worker's Access service token on a request to its own origin, and
 * only there: a request to any other origin is returned unchanged, and without
 * both credentials or a `WORKER_URL` nothing is added. A sandbox-supplied value
 * for either header on a self-origin request is replaced.
 */
export function withSelfAccessCredentials(request: Request, env: SelfAccessEnv): Request {
  const clientId = env.E2E_ACCESS_CLIENT_ID;
  const clientSecret = env.E2E_ACCESS_CLIENT_SECRET;
  if (!env.WORKER_URL || !clientId || !clientSecret) return request;
  if (!isSelfOrigin(request.url, env.WORKER_URL)) return request;
  const headers = new Headers(request.headers);
  headers.set(CLIENT_ID_HEADER, clientId);
  headers.set(CLIENT_SECRET_HEADER, clientSecret);
  // A redirect would carry the token to the redirect target; the sandbox sees
  // the 3xx instead and its next request is judged on its own origin.
  return new Request(request, { headers, redirect: 'manual' });
}

/**
 * Drop `Set-Cookie` from a response of the Worker's own origin before it
 * reaches the sandbox, so an Access session cookie (`CF_Authorization`) issued
 * for the stamped token never lands in sandbox hands. Other origins' responses
 * are returned unchanged.
 */
export function withoutSelfOriginCookies(
  request: Request,
  response: Response,
  env: SelfAccessEnv
): Response {
  if (!env.WORKER_URL || !isSelfOrigin(request.url, env.WORKER_URL)) return response;
  if (!response.headers.has('Set-Cookie')) return response;
  const headers = new Headers(response.headers);
  headers.delete('Set-Cookie');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
}
