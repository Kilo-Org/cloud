/**
 * Origin checks for request admission.
 *
 * Each check compares the browser-sent `Origin` with the host the request
 * addressed, rather than a configured URL: the dev server binds 0.0.0.0 and a
 * local browser may use 127.0.0.1, which a configured origin rejects.
 */

/**
 * Whether the request's `Origin` names the host it addressed.
 *
 * Answers `undefined` when the request carries no `Origin`, so the caller can
 * fall back to Fetch Metadata.
 */
function originMatchesAddressedHost(request: Request): boolean | undefined {
  const origin = request.headers.get('origin');
  if (!origin) return undefined;

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Whether a state-changing request came from a page the app itself served.
 *
 * The Origin header carries its own scheme and host, so this compares it to the
 * request's forwarded host rather than a configured URL: the dev server binds
 * 0.0.0.0 and a local browser may use 127.0.0.1, which a configured origin
 * rejects. SameSite cookies already keep a cross-site POST from carrying the
 * pending-link cookie; this keeps the posture uniform across the route family.
 */
export function isSameOrigin(request: Request): boolean {
  return originMatchesAddressedHost(request) ?? false;
}

/**
 * Whether a form submission came from the app origin: `Origin`, which the
 * browser sends on every form POST, names the host it addressed, or
 * `Sec-Fetch-Site` reports this origin. A request that carries neither signal is
 * refused.
 */
export function isSameOriginSubmission(request: Request): boolean {
  const originMatches = originMatchesAddressedHost(request);
  if (originMatches !== undefined) return originMatches;

  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * Whether a top-level navigation was started by the app itself, or is a
 * deliberate direct navigation (a typed URL or a bookmark).
 *
 * `Sec-Fetch-Site` is the signal a browser sends on a navigation, because a
 * top-level GET usually carries no `Origin`. Only `same-origin` and `none` pass:
 * every other value names a page outside this origin, and such a navigation
 * carries the session cookie. When the request carries both signals they must
 * agree, so an `Origin` that names this host does not admit a navigation that
 * Fetch Metadata reports from elsewhere. A request with neither signal is
 * refused.
 */
export function isSameOriginNavigation(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  const fetchMetadataAdmits = fetchSite === 'same-origin' || fetchSite === 'none';

  const originMatches = originMatchesAddressedHost(request);
  if (originMatches === undefined) return fetchMetadataAdmits;

  return originMatches && (fetchSite === null || fetchMetadataAdmits);
}
