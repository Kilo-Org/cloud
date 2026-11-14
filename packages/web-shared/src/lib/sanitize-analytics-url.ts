export const SENSITIVE_QUERY_PARAMS = new Set(['callbackurl', 'code', 'email', 'state', 'token']);
export const SENSITIVE_PATHS = new Set(['/auth/verify-magic-link']);
/**
 * Query params whose value is itself a path with a query. Sign-in keeps the
 * page a person was going to in `callbackPath`, so a sensitive param of that
 * page rides along inside it.
 */
const NESTED_PATH_QUERY_PARAMS = new Set(['callbackpath']);
const SESSION_SHARE_SEGMENT = 's/:share_token';
const LEGACY_SHARE_SEGMENT = 'share/:share_id';
const SHARE_PATH_SEGMENT = /(^|\/)(s|share)\/[^/?#\s"']+/g;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_URL = /^https?:\/\//i;

export function isSharedSessionPath(pathname: string): boolean {
  return (
    pathname === '/s' ||
    pathname.startsWith('/s/') ||
    pathname === '/share' ||
    pathname.startsWith('/share/')
  );
}

function redactSharePaths(value: string): string {
  return value.replace(
    SHARE_PATH_SEGMENT,
    (_match, prefix: string, route: string) =>
      `${prefix}${route === 's' ? SESSION_SHARE_SEGMENT : LEGACY_SHARE_SEGMENT}`
  );
}

export function sanitizeAnalyticsPathname(pathname: string): string {
  return redactSharePaths(pathname);
}

export function sanitizeAnalyticsText(value: string): string {
  return redactSharePaths(value);
}

/** A path with its own query sanitized; the path and fragment are kept. */
function sanitizeNestedPath(value: string): string {
  const queryStart = value.indexOf('?');
  if (queryStart === -1) return value;
  const fragmentStart = value.indexOf('#', queryStart);
  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart;
  const path = value.slice(0, queryStart);
  const fragment = value.slice(queryEnd);
  const query = sanitizeSearchParams(value.slice(queryStart + 1, queryEnd), false);
  return `${path}${query ? `?${query}` : ''}${fragment}`;
}

function sanitizeSearchParams(searchParams: string, sanitizeNested = true): string {
  const sanitizedParams = new URLSearchParams();
  new URLSearchParams(searchParams).forEach((value, key) => {
    const name = key.toLowerCase();
    if (SENSITIVE_QUERY_PARAMS.has(name)) return;
    const nested = sanitizeNested && NESTED_PATH_QUERY_PARAMS.has(name);
    sanitizedParams.append(key, nested ? sanitizeNestedPath(value) : value);
  });
  return sanitizedParams.toString();
}

function sanitizeUrlParts(origin: string, pathname: string, searchParams: string): string {
  const sanitizedPathname = redactSharePaths(pathname);
  const baseUrl = `${origin}${sanitizedPathname}`;
  if (SENSITIVE_PATHS.has(sanitizedPathname) || !searchParams) {
    return baseUrl;
  }

  const sanitizedSearch = sanitizeSearchParams(searchParams);
  return sanitizedSearch ? `${baseUrl}?${sanitizedSearch}` : baseUrl;
}

export function sanitizeAnalyticsUrl(
  origin: string,
  pathname: string,
  searchParams: string
): string {
  return sanitizeUrlParts(origin, pathname, searchParams);
}

export function sanitizeAnalyticsUrlValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const isHttp = HTTP_URL.test(value);
  const isRootRelative = value.startsWith('/');
  const isAbsolute = ABSOLUTE_URL.test(value);
  if (!isHttp && !isRootRelative && !isAbsolute) {
    return value;
  }

  try {
    const baseOrigin = typeof window === 'undefined' ? 'http://localhost' : window.origin;
    const url = new URL(value, baseOrigin);
    if (isHttp || isRootRelative) {
      return sanitizeUrlParts(url.origin, url.pathname, url.searchParams.toString());
    }

    const sanitizedPathname = redactSharePaths(url.pathname);
    const sanitizedSearch = sanitizeSearchParams(url.searchParams.toString());
    if (sanitizedPathname === url.pathname && sanitizedSearch === url.searchParams.toString()) {
      return value;
    }

    return `${url.protocol}//${url.host}${sanitizedPathname}${
      sanitizedSearch ? `?${sanitizedSearch}` : ''
    }`;
  } catch {
    return value;
  }
}
