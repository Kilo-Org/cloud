const SENSITIVE_QUERY_PARAMS = new Set(['callbackurl', 'code', 'email', 'state', 'token']);
const SENSITIVE_PATHS = new Set(['/auth/verify-magic-link']);

export function sanitizeAnalyticsUrl(
  origin: string,
  pathname: string,
  searchParams: string
): string {
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
