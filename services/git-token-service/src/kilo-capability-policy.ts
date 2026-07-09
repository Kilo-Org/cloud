import type { KiloSessionCapabilityTargets } from './kilo-session-capability.js';

export type KiloCapabilityRouteClass =
  | 'provider_model'
  | 'organization_models'
  | 'backend_api'
  | 'session_ingest';

export type KiloCapabilityRouteClassification =
  | { success: true; routeClass: KiloCapabilityRouteClass }
  | { success: false; reason: 'invalid_upstream_url' | 'upstream_not_allowed' };

export type KiloCapabilityRequestIdentity = {
  requestMethod?: string;
  bootstrapKiloSessionId?: string;
};

type ParsedTarget = {
  origin: string;
  basePath: string;
};

function hasUnsafeEncodedPath(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth < 4; depth++) {
    if (/%(?:2f|5c)/i.test(decoded) || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(decoded)) {
      return true;
    }
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded);
}

function isAllowedProtocol(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname)
  );
}

function parseTarget(value: string): ParsedTarget | null {
  if (hasUnsafeEncodedPath(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!isAllowedProtocol(url) || url.username || url.password || url.hash || url.search) {
    return null;
  }
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, basePath };
}

export function areValidKiloCapabilityTargets(targets: KiloSessionCapabilityTargets): boolean {
  return Object.values(targets).every(target => parseTarget(target) !== null);
}

function isWithinTarget(url: URL, target: ParsedTarget): boolean {
  return (
    url.origin === target.origin &&
    (target.basePath === '' ||
      url.pathname === target.basePath ||
      url.pathname.startsWith(`${target.basePath}/`))
  );
}

function appendPath(basePath: string, suffix: string): string {
  return `${basePath}${suffix}` || '/';
}

function providerPrefixes(basePath: string): string[] {
  if (/\/api\/(?:openrouter|gateway)$/.test(basePath)) return [basePath];
  if (basePath.endsWith('/api')) {
    return [appendPath(basePath, '/openrouter'), appendPath(basePath, '/gateway')];
  }
  return [appendPath(basePath, '/api/openrouter'), appendPath(basePath, '/api/gateway')];
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isProviderRoute(pathname: string, basePath: string): boolean {
  return providerPrefixes(basePath).some(prefix => matchesPrefix(pathname, prefix));
}

function isOrganizationModelsRoute(pathname: string, basePath: string): boolean {
  const organizationsPrefix = basePath.endsWith('/api')
    ? `${basePath}/organizations/`
    : `${basePath}/api/organizations/`;
  if (!pathname.startsWith(organizationsPrefix)) return false;
  const relativePath = pathname.slice(organizationsPrefix.length);
  return /^[^/]+\/models(?:\/|$)/.test(relativePath);
}

function isSessionIngestRoute(pathname: string, basePath: string, kiloSessionId: string): boolean {
  const sessionPrefix = appendPath(basePath, `/api/session/${encodeURIComponent(kiloSessionId)}`);
  return (
    pathname === `${sessionPrefix}/export` ||
    pathname === `${sessionPrefix}/import` ||
    pathname === `${sessionPrefix}/ingest`
  );
}

function isSessionBootstrapRoute(pathname: string, basePath: string): boolean {
  return pathname === appendPath(basePath, '/api/session');
}

function isSessionIngestShapedRoute(pathname: string, basePath: string): boolean {
  if (pathname === appendPath(basePath, '/api/session')) return true;
  const sessionsPrefix = appendPath(basePath, '/api/session/');
  if (!pathname.startsWith(sessionsPrefix)) return false;
  return /^[^/]+\/(?:export|import|ingest)$/.test(pathname.slice(sessionsPrefix.length));
}

export function classifyKiloCapabilityRequest(
  requestUrl: string,
  targets: KiloSessionCapabilityTargets,
  kiloSessionId: string,
  requestIdentity: KiloCapabilityRequestIdentity = {}
): KiloCapabilityRouteClassification {
  // requestUrl is only compile-time typed at the WorkerEntrypoint RPC boundary; a
  // caller can still send a non-string, which must fail closed like every other
  // branch instead of throwing from the .split below.
  if (typeof requestUrl !== 'string') {
    return { success: false, reason: 'invalid_upstream_url' };
  }
  // Only the path is subject to the traversal/encoding guard; query strings may
  // legitimately carry percent-encoded slashes and dots.
  if (hasUnsafeEncodedPath(requestUrl.split(/[?#]/, 1)[0])) {
    return { success: false, reason: 'invalid_upstream_url' };
  }

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { success: false, reason: 'invalid_upstream_url' };
  }
  if (!isAllowedProtocol(url) || url.username || url.password || url.hash) {
    return { success: false, reason: 'invalid_upstream_url' };
  }

  const backend = parseTarget(targets.backendBaseUrl);
  const provider = parseTarget(targets.providerBaseUrl);
  const sessionIngest = parseTarget(targets.sessionIngestBaseUrl);
  if (!backend || !provider || !sessionIngest) {
    return { success: false, reason: 'invalid_upstream_url' };
  }

  if (isWithinTarget(url, provider) && isProviderRoute(url.pathname, provider.basePath)) {
    return { success: true, routeClass: 'provider_model' };
  }
  if (isWithinTarget(url, backend) && isOrganizationModelsRoute(url.pathname, backend.basePath)) {
    return { success: true, routeClass: 'organization_models' };
  }
  if (
    isWithinTarget(url, sessionIngest) &&
    isSessionIngestRoute(url.pathname, sessionIngest.basePath, kiloSessionId)
  ) {
    return { success: true, routeClass: 'session_ingest' };
  }
  if (
    isWithinTarget(url, sessionIngest) &&
    isSessionBootstrapRoute(url.pathname, sessionIngest.basePath)
  ) {
    if (
      requestIdentity.requestMethod?.toUpperCase() === 'POST' &&
      requestIdentity.bootstrapKiloSessionId === kiloSessionId
    ) {
      return { success: true, routeClass: 'session_ingest' };
    }
    return { success: false, reason: 'upstream_not_allowed' };
  }
  // Backend is the catch-all for its origin, so it must exclude provider- and
  // session-ingest-shaped paths. Otherwise a shared backend/session-ingest origin
  // would let this branch serve another session's ingest route as backend_api,
  // bypassing the bound-session guard above.
  if (isWithinTarget(url, backend)) {
    if (
      isProviderRoute(url.pathname, backend.basePath) ||
      (url.origin === sessionIngest.origin &&
        isSessionIngestShapedRoute(url.pathname, sessionIngest.basePath))
    ) {
      return { success: false, reason: 'upstream_not_allowed' };
    }
    return { success: true, routeClass: 'backend_api' };
  }
  return { success: false, reason: 'upstream_not_allowed' };
}
