const SENSITIVE_QUERY_PARAMS = new Set(['callbackurl', 'code', 'email', 'state', 'token']);
const SENSITIVE_PATHS = new Set(['/auth/verify-magic-link']);

function sanitizeUrlParts(origin: string, pathname: string, searchParams: string): string {
  const baseUrl = `${origin}${pathname}`;
  if (SENSITIVE_PATHS.has(pathname) || !searchParams) {
    return baseUrl;
  }

  const sanitizedParams = new URLSearchParams();
  new URLSearchParams(searchParams).forEach((value, key) => {
    if (!SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      sanitizedParams.append(key, value);
    }
  });

  const sanitizedSearch = sanitizedParams.toString();
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

  if (!value.startsWith('http://') && !value.startsWith('https://') && !value.startsWith('/')) {
    return value;
  }

  try {
    const baseOrigin = typeof window === 'undefined' ? 'http://localhost' : window.origin;
    const url = new URL(value, baseOrigin);
    return sanitizeUrlParts(url.origin, url.pathname, url.searchParams.toString());
  } catch {
    return value;
  }
}
