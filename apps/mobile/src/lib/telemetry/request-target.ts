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

/** A URL's scheme and its `//` authority marker, at the start of the string. */
const SCHEME_PREFIX = /^[a-z][\da-z+.-]*:\/\//iu;

/** The text before the first `?` or `#`. */
function cutAtQueryOrFragment(text: string): string {
  const cut = text.search(/[?#]/u);
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * Reduce a URL to its origin and path: drop the query string, the fragment and
 * any authority userinfo, which ends at its last `@` whatever characters it
 * carries. Fields built from this — the `network.url` context, the synthesized
 * message, the fingerprint path — carry origin and path. Returns empty string
 * on a non-string.
 */
export function stripQueryString(url: string): string {
  try {
    const scheme = SCHEME_PREFIX.exec(url);
    if (scheme === null) {
      return cutAtQueryOrFragment(url);
    }
    const schemeEnd = scheme[0].length;
    // A delimiter ends the authority once the userinfo is terminated, or when
    // the run since the scheme cannot be userinfo (it holds no ':'); otherwise
    // the delimiter sits inside the userinfo and the authority continues.
    //
    // One reading covers both shapes by design: a run before a delimiter that
    // already holds a ':' is read as userinfo, so a path after such a run
    // reduces to the text following its last `@`. This is the intended form of
    // the origin-and-path contract, not a reading to narrow toward a stricter
    // authority grammar.
    let lastAt = -1;
    let runHoldsColon = false;
    for (let i = schemeEnd; i < url.length; i += 1) {
      const c = url[i];
      if (c === '@') {
        lastAt = i;
      } else if (c === ':') {
        runHoldsColon = true;
      } else if ((c === '/' || c === '?' || c === '#') && (lastAt !== -1 || !runHoldsColon)) {
        break;
      }
    }
    if (lastAt === -1) {
      return cutAtQueryOrFragment(url);
    }
    return url.slice(0, schemeEnd) + cutAtQueryOrFragment(url.slice(lastAt + 1));
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
