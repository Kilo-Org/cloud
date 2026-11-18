/**
 * The request target both telemetry wrappers read: the URL a `fetch` call
 * addresses, and the tRPC procedure text a `/api/trpc/<procs>` URL names.
 *
 * Pure and total: no SDK, network or React import, so the node vitest project
 * can import it — the same discipline as `network-errors.ts` and
 * `request-latency.ts`. A plain string walk, not `new URL`, whose React Native
 * polyfill does not implement every component.
 */

/** The path prefix a tRPC HTTP call is served under. */
export const TRPC_PATH = '/api/trpc/';

/** A URL authority's userinfo prefix, the part before the host. */
const URL_USERINFO_PATTERN = /^([a-z][\da-z+.-]*:\/\/)[^/?#]*@/iu;

/**
 * Reduce a URL to its origin and path: drop the query string, the fragment,
 * and the authority's userinfo prefix. Fields built from this — the
 * `network.url` context, the synthesized message, the fingerprint path — carry
 * origin and path. Returns empty string on a non-string.
 * Total: a plain string walk, not `new URL`, whose React Native polyfill does
 * not implement every component.
 */
export function stripQueryString(url: string): string {
  try {
    const cut = url.search(/[?#]/u);
    const originAndPath = cut === -1 ? url : url.slice(0, cut);
    return originAndPath.replace(URL_USERINFO_PATTERN, '$1');
  } catch {
    return '';
  }
}

/** The URL a `fetch` call addresses, whichever shape the caller passed. */
export function requestUrlString(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.href;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return input;
}

/**
 * Extract `<procs>` from a `/api/trpc/<procs>` URL. This is the one rule both
 * telemetry producers report by: the query string, the fragment and the
 * authority's userinfo never reach the procedure text, so the error reporter
 * and the latency sampler cannot disagree about the same request. Undefined
 * when the URL names no tRPC procedure.
 */
export function trpcProcedureText(url: string): string | undefined {
  try {
    const pathOnly = stripQueryString(url);
    const index = pathOnly.indexOf(TRPC_PATH);
    if (index === -1) {
      return undefined;
    }
    const procedure = pathOnly.slice(index + TRPC_PATH.length);
    return procedure.length > 0 ? procedure : undefined;
  } catch {
    return undefined;
  }
}
