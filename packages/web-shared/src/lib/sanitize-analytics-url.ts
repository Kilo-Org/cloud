const SENSITIVE_QUERY_PARAMS = new Set(['callbackurl', 'code', 'email', 'state', 'token']);
const SENSITIVE_PATHS = new Set(['/auth/verify-magic-link']);
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

function sanitizeSearchParams(searchParams: string): string {
  const sanitizedParams = new URLSearchParams();
  new URLSearchParams(searchParams).forEach((value, key) => {
    if (!SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      sanitizedParams.append(key, value);
    }
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
