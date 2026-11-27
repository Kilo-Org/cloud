/**
 * Access service-token credentials for the e2e Worker's requests to the two
 * Access-protected e2e origins: its own (`WORKER_URL`) and the fake LLM's
 * (`E2E_FAKE_LLM_URL`). e2e-only: referenced from `src/e2e-entry.ts`, never from
 * production.
 *
 * Neither e2e Worker has a public address; each hostname sits behind its own
 * Cloudflare Access application whose policy is Service Auth for the same
 * service token. Requests to those
 * origins come from sandbox egress (`ContainersOutbound`: runtime artifacts, the
 * credential proxy facade, sandbox control, model traffic) and from the Worker
 * itself (callback delivery, model validation). Under
 * `global_fetch_strictly_public` each re-enters Cloudflare's front door like any
 * Internet request, so Access challenges it unless it carries the service token.
 */

const CLIENT_ID_HEADER = 'CF-Access-Client-Id';
const CLIENT_SECRET_HEADER = 'CF-Access-Client-Secret';

export type AccessEnv = {
  WORKER_URL?: string;
  E2E_FAKE_LLM_URL?: string;
  E2E_ACCESS_CLIENT_ID?: string;
  E2E_ACCESS_CLIENT_SECRET?: string;
};

/** `ws:`/`wss:` and `http:`/`https:` URLs of one host share an origin here. */
function originOf(value: string): string | undefined {
  try {
    return new URL(value.replace(/^ws(s?):/i, 'http$1:')).origin;
  } catch {
    return undefined;
  }
}

/**
 * The origins that receive the service token. Both hostnames must be
 * configured; with either missing there is none, and the e2e entry refuses
 * every request anyway.
 */
function accessOrigins(env: AccessEnv): string[] {
  if (!env.WORKER_URL || !env.E2E_FAKE_LLM_URL) return [];
  const worker = originOf(env.WORKER_URL);
  const fakeLlm = originOf(env.E2E_FAKE_LLM_URL);
  return worker === undefined || fakeLlm === undefined ? [] : [worker, fakeLlm];
}

function isAccessOrigin(url: string, env: AccessEnv): boolean {
  const origin = originOf(url);
  return origin !== undefined && accessOrigins(env).includes(origin);
}

/**
 * Stamp the Worker's Access service token on a request to one of the two e2e
 * origins, and only there: a request to any other origin is returned unchanged,
 * and without both credentials and both hostnames nothing is added. A
 * caller-supplied value for either header on such a request is replaced.
 */
export function withAccessCredentials(request: Request, env: AccessEnv): Request {
  const clientId = env.E2E_ACCESS_CLIENT_ID;
  const clientSecret = env.E2E_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret || !isAccessOrigin(request.url, env)) return request;
  const headers = new Headers(request.headers);
  headers.set(CLIENT_ID_HEADER, clientId);
  headers.set(CLIENT_SECRET_HEADER, clientSecret);
  // A redirect would carry the token to the redirect target; the caller sees
  // the 3xx instead and its next request is judged on its own origin.
  return new Request(request, { headers, redirect: 'manual' });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wrap `fetch` so the Worker's own requests to the two e2e origins carry the
 * service token, with `withAccessCredentials`' rules. Every other request
 * reaches `base` with its original arguments untouched. `env` is read per call.
 */
export function withAccessFetch(base: typeof fetch, env: () => AccessEnv): typeof fetch {
  return (input, init) => {
    const current = env();
    if (!isAccessOrigin(requestUrl(input), current)) return base(input, init);
    const request = new Request(input, init);
    const stamped = withAccessCredentials(request, current);
    return base(stamped);
  };
}

/**
 * Drop `Set-Cookie` from a response of either e2e origin before it reaches the
 * sandbox, so an Access session cookie (`CF_Authorization`) issued for the
 * stamped token never lands in sandbox hands. Other origins' responses are
 * returned unchanged.
 */
export function withoutAccessOriginCookies(
  request: Request,
  response: Response,
  env: AccessEnv
): Response {
  if (!isAccessOrigin(request.url, env)) return response;
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
