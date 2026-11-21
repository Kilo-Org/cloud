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

/**
 * A URL's scheme, then the run of `/` and `\` that starts its authority. A
 * parser reads an authority for these schemes even without `//`, and skips any
 * run of separators when it finds one.
 */
const SCHEME_PREFIX = /^([a-z][\da-z+.-]*):([/\\]*)/iu;

/** The schemes a URL parser reads as always carrying an authority. */
const SPECIAL_SCHEME = /^(?:https?|wss?|ftp)$/iu;

/** Leading control characters and spaces, which a URL parser ignores. */
const LEADING_IGNORED = /^[\u0000-\u0020]+/u; // eslint-disable-line no-control-regex

/** The text before the first `?` or `#`. */
function cutAtQueryOrFragment(text: string): string {
  const cut = text.search(/[?#]/u);
  return cut === -1 ? text : text.slice(0, cut);
}

/** A bracketed IPv6 literal, with an optional `:port`. */
const IPV6_LITERAL = /^\[[\da-f:.]+\](?::\d{1,5})?$/iu;

/** `localhost`, with an optional `:port`. */
const LOCALHOST = /^localhost(?::\d{1,5})?$/iu;

/** A dotted-quad IPv4 literal, with an optional `:port`. */
const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/u;

/** A registered name, with at least one dot and an optional `:port`. */
const REGISTERED_NAME =
  /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d{1,5})?$/iu;

/**
 * Whether an authority segment reads as a host: a bracketed IPv6 literal, an
 * IPv4 literal, `localhost`, or a dotted registered name, each with an optional
 * port. A single label, with or without a numeric port, is not a host here: it
 * reads as a userinfo pair just as easily, so the authority keeps the reading
 * that removes the userinfo rather than the one that reports it.
 */
function isHostLike(text: string): boolean {
  return (
    IPV6_LITERAL.test(text) ||
    IPV4_LITERAL.test(text) ||
    LOCALHOST.test(text) ||
    REGISTERED_NAME.test(text)
  );
}

/** A single label, the shape a host takes when it holds no dot and no colon. */
const SINGLE_LABEL = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu;

/** The index of the first `/`, `?` or `#` at or after `from`, else the length. */
function nextDelimiter(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === '/' || c === '?' || c === '#') {
      return i;
    }
  }
  return text.length;
}

/**
 * Reduce a URL to its origin and path: drop the query string, the fragment and
 * any authority userinfo, which ends at its last `@` whatever characters it
 * carries. Fields built from this — the `network.url` context, the synthesized
 * message, the fingerprint path — carry origin and path. Returns empty string
 * on a non-string.
 *
 * The value reported after that last `@` must read as a host, since it stands
 * for the authority's host, port and path. When it does not, the result is the
 * scheme alone.
 *
 * A single label with a numeric port is not read as a host, though: `api:3000`
 * is the same text as a userinfo pair whose value starts with digits. Such a
 * run is read as userinfo, so a later `@` ends the value at the scheme alone
 * when the text after it is not a host, and at that host when it is. A dotted
 * name, `localhost`, an IPv4 literal and a bracketed IPv6 authority never take
 * that reading and keep their own origin, port and path.
 */
export function stripQueryString(url: string): string {
  try {
    // A parser skips leading control characters and spaces, so the same value is
    // read from the trimmed text; its indices match the original's from the
    // scheme on, which is all this walk consults.
    const text = url.replace(LEADING_IGNORED, '');
    const scheme = SCHEME_PREFIX.exec(text);
    if (scheme === null) {
      return cutAtQueryOrFragment(text);
    }
    // A special scheme carries an authority even with no `//` separator, and a
    // run of separators is skipped when one is present: `https:`, `https:/` and
    // `https:///` all reach the same authority. Any other scheme reads its
    // authority only after `//`, as the format requires.
    const isSpecial = SPECIAL_SCHEME.test(scheme[1] ?? '');
    if (!isSpecial && (scheme[2] ?? '') === '') {
      return cutAtQueryOrFragment(text);
    }
    const schemeEnd = scheme[0].length;
    // A reported authority keeps the scheme and the `//` a parser normalizes to.
    const prefix = `${scheme[1] ?? ''}://`;
    // A delimiter ends the authority once the userinfo is terminated, or when
    // the run since the scheme carries no ':' and so cannot be userinfo: then
    // the text is a plain origin and path.
    //
    // A run that carries a ':' may be either userinfo or an authority with a
    // port. The first delimiter decides which: a run that reads as a host there
    // closes the authority at every delimiter, and any other run is userinfo, so
    // the authority continues past the delimiter and ends at its last `@`.
    let lastAt = -1;
    let colonBefore = false;
    for (let i = schemeEnd; i < text.length; i += 1) {
      const c = text[i];
      if (c === '@') {
        lastAt = i;
      } else if (c === ':') {
        colonBefore = true;
      } else if (
        (c === '/' || c === '?' || c === '#') &&
        (lastAt !== -1 || !colonBefore || isHostLike(text.slice(schemeEnd, i)))
      ) {
        break;
      }
    }
    if (lastAt === -1) {
      return cutAtQueryOrFragment(text);
    }
    // The text after the last `@` stands for the authority's host, port and path,
    // so it must read as a host. A single label with no colon qualifies, because
    // nothing after the last `@` can be userinfo — unless the `@` sits after a
    // query or fragment, where a single label is that text rather than a host.
    const tailStart = lastAt + 1;
    const tail = text.slice(tailStart, nextDelimiter(text, tailStart));
    const queryStart = text.search(/[?#]/u);
    const crossedQuery = queryStart !== -1 && queryStart < lastAt;
    if (isHostLike(tail) || (!crossedQuery && SINGLE_LABEL.test(tail))) {
      return prefix + cutAtQueryOrFragment(text.slice(tailStart));
    }
    if (!crossedQuery) {
      return prefix;
    }
    // The `@` belongs to the query or fragment. A path before it settles that the
    // authority ended at the first delimiter, so the text before the query is
    // kept only when it reads as a host: otherwise it may still be userinfo.
    const run = text.slice(schemeEnd, nextDelimiter(text, schemeEnd));
    return isHostLike(run) ? prefix + run : prefix;
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
