import { containedKiloSessionIdSchema } from '@kilocode/session-ingest-contracts';

export type RuntimeCredentialProxyTargets = {
  backendBaseUrl: string;
  providerBaseUrl: string;
  sessionIngestBaseUrl: string;
};

export type RuntimeCredentialProxyRoute = 'backend' | 'provider' | 'ingest' | 'exa';

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

type ResolveRuntimeCredentialProxyScopedV2Input = Omit<
  ResolveRuntimeCredentialProxyRouteInput,
  'kiloSessionId'
>;

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
    [
      '/chat/completions',
      '/messages',
      '/responses',
      '/embeddings',
      '/v1/chat/completions',
      '/v1/responses',
    ].includes(path)
  );
}

function logicalProviderPath(pathname: string): string | null {
  const prefix = ['/api/openrouter', '/api/gateway'].find(value =>
    pathname.startsWith(`${value}/`)
  );
  if (!prefix) return null;
  const path = pathname.slice(prefix.length);
  if (path.startsWith('/v1/') && prefix !== '/api/gateway') return null;
  return isAllowedProviderRoute('GET', path) || isAllowedProviderRoute('POST', path) ? path : null;
}

export const EXA_PROXY_PATHS = [
  '/api/exa/search',
  '/api/exa/contents',
  '/api/exa/findSimilar',
  '/api/exa/answer',
  '/api/exa/context',
] as const;

const exaProxyPathSet: ReadonlySet<string> = new Set(EXA_PROXY_PATHS);

function isAllowedExaRoute(method: string, path: string): boolean {
  return method === 'POST' && exaProxyPathSet.has(path);
}

/** Identifies the facade plane only; the route resolver still enforces its allowlist. */
export function inferRuntimeCredentialProxyRoute(
  pathname: string
): RuntimeCredentialProxyRoute | null {
  if (pathname.startsWith('/api/openrouter/') || pathname.startsWith('/api/gateway/')) {
    return 'provider';
  }
  if (pathname.startsWith('/api/exa/')) {
    return 'exa';
  }
  if (
    pathname === '/api/session' ||
    /^\/api\/session\/[A-Za-z0-9_-]+\/(?:export|ingest|title)$/.test(pathname)
  ) {
    return 'ingest';
  }
  return pathname.startsWith('/api/') ? 'backend' : null;
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

function parseScopeCreateBody(input: {
  contentType?: string | null;
  bodyText?: string;
}): Record<string, unknown> | null {
  if (
    input.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' ||
    input.bodyText === undefined ||
    input.bodyText.length > 8192
  ) {
    return null;
  }
  try {
    const body: unknown = JSON.parse(input.bodyText);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const values = body as Record<string, unknown>;
    if (Object.keys(values).some(key => key !== 'sessionId' && key !== 'parentSessionId'))
      return null;
    return values;
  } catch {
    return null;
  }
}

export function resolveRuntimeCredentialProxyScopedIngestRoute(
  input: ResolveRuntimeCredentialProxyRouteInput
): URL | null {
  if (
    input.route !== 'ingest' ||
    input.method !== 'POST' ||
    !containedKiloSessionIdSchema.safeParse(input.kiloSessionId).success ||
    (input.organizationId !== undefined && !ORGANIZATION_ID.test(input.organizationId))
  ) {
    return null;
  }
  const path = safePathname(input.pathname);
  if (!path) return null;
  let sessionId: unknown;
  if (path === '/api/session') {
    const values = parseScopeCreateBody(input);
    if (values === null) return null;
    if (
      values.parentSessionId !== undefined &&
      !containedKiloSessionIdSchema.safeParse(values.parentSessionId).success
    ) {
      return null;
    }
    sessionId = values.sessionId;
  } else {
    sessionId = /^\/api\/session\/([A-Za-z0-9_-]+)\/ingest$/.exec(path)?.[1];
  }
  if (
    sessionId === input.kiloSessionId ||
    !containedKiloSessionIdSchema.safeParse(sessionId).success
  ) {
    return null;
  }
  return targetUrl(input.targets.sessionIngestBaseUrl, path, input.search);
}

/**
 * Resolves a child session-scope route for an adopted scope handle: the facade
 * forwards create, ingest, export and title on any non-member session id as a
 * v2 assertion. The path id is not required to differ from the handle's own
 * root; membership is the facade's decision.
 */
export function resolveRuntimeCredentialProxyScopedV2IngestRoute(
  input: ResolveRuntimeCredentialProxyScopedV2Input
): URL | null {
  if (input.route !== 'ingest') return null;
  const path = safePathname(input.pathname);
  if (!path) return null;

  if (path === '/api/session') {
    if (input.method !== 'POST') return null;
    const values = parseScopeCreateBody(input);
    if (values === null) return null;
    if (
      !containedKiloSessionIdSchema.safeParse(values.sessionId).success ||
      !containedKiloSessionIdSchema.safeParse(values.parentSessionId).success
    ) {
      return null;
    }
    return targetUrl(input.targets.sessionIngestBaseUrl, path, input.search);
  }

  const match = /^\/api\/session\/([A-Za-z0-9_-]+)\/(ingest|export|title)$/.exec(path);
  if (!match?.[1] || !match[2]) return null;
  if (!containedKiloSessionIdSchema.safeParse(match[1]).success) return null;
  const methodAllowed =
    (match[2] === 'ingest' && input.method === 'POST') ||
    (match[2] === 'export' && input.method === 'GET') ||
    (match[2] === 'title' && input.method === 'POST');
  if (!methodAllowed) return null;
  return targetUrl(input.targets.sessionIngestBaseUrl, path, input.search);
}

/**
 * Decides, for one adopted scope handle, whether an ingest-plane request is a
 * member-root request served on the public path or a child candidate forwarded
 * as a v2 assertion. This is the single owner of that decision: the caller
 * passes the current member roots and receives either the public URL or the
 * scoped URL. A `{sessionId}`-only create whose id is a current member root
 * stays public; every other create needs a `parentSessionId` and goes scoped.
 */
export function resolveRuntimeCredentialProxyScopeIngestRoute(input: {
  targets: RuntimeCredentialProxyTargets;
  route: RuntimeCredentialProxyRoute;
  method: string;
  pathname: string;
  search: string;
  memberRootKiloSessionIds: readonly string[];
  organizationId?: string;
  contentType?: string | null;
  bodyText?: string;
}): { kind: 'public'; upstream: URL } | { kind: 'scoped'; upstream: URL } | null {
  if (input.route !== 'ingest') return null;
  const path = safePathname(input.pathname);
  if (!path) return null;
  const memberRoots = new Set(input.memberRootKiloSessionIds);
  const shared = {
    targets: input.targets,
    route: 'ingest' as const,
    method: input.method,
    pathname: path,
    search: input.search,
    ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    ...(input.bodyText === undefined ? {} : { bodyText: input.bodyText }),
  };
  const publicUrl = (kiloSessionId: string): URL | null =>
    resolveRuntimeCredentialProxyRoute({ ...shared, kiloSessionId });
  const scopedUrl = (): URL | null => resolveRuntimeCredentialProxyScopedV2IngestRoute(shared);

  if (path === '/api/session') {
    if (input.method !== 'POST') return null;
    const values = parseScopeCreateBody(input);
    if (values === null) return null;
    const sessionId = values.sessionId;
    if (
      Object.keys(values).length === 1 &&
      typeof sessionId === 'string' &&
      memberRoots.has(sessionId)
    ) {
      const upstream = publicUrl(sessionId);
      return upstream === null ? null : { kind: 'public', upstream };
    }
    const upstream = scopedUrl();
    return upstream === null ? null : { kind: 'scoped', upstream };
  }

  const match = /^\/api\/session\/([A-Za-z0-9_-]+)\/(ingest|export|title)$/.exec(path);
  if (!match?.[1]) return null;
  if (memberRoots.has(match[1])) {
    const upstream = publicUrl(match[1]);
    return upstream === null ? null : { kind: 'public', upstream };
  }
  const upstream = scopedUrl();
  return upstream === null ? null : { kind: 'scoped', upstream };
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
  if (input.route === 'exa' && isAllowedExaRoute(input.method, path)) {
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
