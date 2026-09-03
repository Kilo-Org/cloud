export type RuntimeCredentialProxyTargets = {
  backendBaseUrl: string;
  providerBaseUrl: string;
  sessionIngestBaseUrl: string;
};

export type RuntimeCredentialProxyRoute = 'backend' | 'provider' | 'ingest';

type ResolveRuntimeCredentialProxyRouteInput = {
  targets: RuntimeCredentialProxyTargets;
  route: RuntimeCredentialProxyRoute;
  method: string;
  pathname: string;
  search: string;
  kiloSessionId: string;
  organizationId?: string;
  contentType?: string | null;
  bodyText?: string;
};

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safePathname(value: string): string | null {
  if (!value.startsWith('/') || value.includes('\\') || /%(?:2f|5c)/i.test(value)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (
    decoded.includes('\\') ||
    decoded.includes('//') ||
    /%(?:2e|2f|5c)/i.test(decoded) ||
    decoded.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    return null;
  }
  return decoded;
}

function targetUrl(base: string, pathname: string, search: string): URL | null {
  try {
    const url = new URL(base);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${pathname}`;
    url.search = search;
    return url;
  } catch {
    return null;
  }
}

function isAllowedBackendRoute(
  method: string,
  path: string,
  organizationId: string | undefined
): boolean {
  if (method === 'GET') {
    if (
      [
        '/api/user',
        '/api/profile',
        '/api/profile/balance',
        '/api/defaults',
        '/api/users/notifications',
      ].includes(path)
    ) {
      return true;
    }
    const match = /^\/api\/organizations\/([A-Za-z0-9._-]+)\/(models|defaults|modes)$/.exec(path);
    return match !== null && match[1] === organizationId;
  }
  return (
    method === 'POST' &&
    organizationId !== undefined &&
    path === `/api/organizations/${organizationId}/models/validate`
  );
}

function isAllowedProviderRoute(method: string, path: string): boolean {
  if (path === '/models') return method === 'GET';
  if (path === '/models/validate') return method === 'POST';
  return (
    method === 'POST' &&
    ['/chat/completions', '/messages', '/responses', '/embeddings'].includes(path)
  );
}

function logicalProviderPath(pathname: string): string | null {
  const prefix = '/api/openrouter';
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const path = pathname.slice(prefix.length);
  return isAllowedProviderRoute('GET', path) || isAllowedProviderRoute('POST', path) ? path : null;
}

function providerTargetUrl(base: string, path: string, search: string): URL | null {
  let provider: URL;
  try {
    provider = new URL(base);
  } catch {
    return null;
  }
  if (
    (provider.protocol !== 'https:' && provider.protocol !== 'http:') ||
    provider.username ||
    provider.password ||
    provider.search ||
    provider.hash
  ) {
    return null;
  }

  if (provider.origin === 'https://api.kilo.ai' && provider.pathname === '/') {
    provider.pathname = `/api/gateway${path}`;
    provider.search = search;
    return provider;
  }
  return targetUrl(base, path, search);
}

function hasAuthorizedSessionBody(input: ResolveRuntimeCredentialProxyRouteInput): boolean {
  if (input.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    return false;
  if (input.bodyText === undefined || input.bodyText.length > 8192) return false;
  try {
    const body: unknown = JSON.parse(input.bodyText);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
    const sessionId = (body as Record<string, unknown>).sessionId;
    return (
      Object.keys(body).length === 1 &&
      typeof sessionId === 'string' &&
      ID.test(sessionId) &&
      sessionId === input.kiloSessionId
    );
  } catch {
    return false;
  }
}

function isAllowedIngestRoute(
  input: ResolveRuntimeCredentialProxyRouteInput,
  path: string
): boolean {
  if (path === '/api/session') return input.method === 'POST' && hasAuthorizedSessionBody(input);
  const match = /^\/api\/session\/([A-Za-z0-9_-]+)\/(export|ingest|title)$/.exec(path);
  if (!match || match[1] !== input.kiloSessionId) return false;
  return (
    (match[2] === 'export' && input.method === 'GET') ||
    (match[2] !== 'export' && input.method === 'POST')
  );
}

/** Resolves only exact credential-bearing routes; unrecognized input fails closed. */
export function resolveRuntimeCredentialProxyRoute(
  input: ResolveRuntimeCredentialProxyRouteInput
): URL | null {
  if (
    !ID.test(input.kiloSessionId) ||
    (input.organizationId !== undefined && !ORGANIZATION_ID.test(input.organizationId))
  ) {
    return null;
  }
  const path = safePathname(input.pathname);
  if (!path) return null;

  if (
    input.route === 'backend' &&
    isAllowedBackendRoute(input.method, path, input.organizationId)
  ) {
    return targetUrl(input.targets.backendBaseUrl, path, input.search);
  }
  if (input.route === 'provider') {
    const logicalPath = logicalProviderPath(path);
    if (logicalPath && isAllowedProviderRoute(input.method, logicalPath)) {
      return providerTargetUrl(input.targets.providerBaseUrl, logicalPath, input.search);
    }
  }
  if (input.route === 'ingest' && isAllowedIngestRoute(input, path)) {
    return targetUrl(input.targets.sessionIngestBaseUrl, path, input.search);
  }
  return null;
}
