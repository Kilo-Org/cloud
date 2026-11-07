import { resolveSecret } from './auth.js';
import {
  inferRuntimeCredentialProxyRoute,
  resolveRuntimeCredentialProxyScopeIngestRoute,
  resolveRuntimeCredentialProxyScopedIngestRoute,
  type RuntimeCredentialProxyRoute,
} from './kilo/runtime-credential-proxy-routes.js';
import { deriveKiloSandboxTargets, deriveLoopbackFacadeTargets } from './kilo/kilo-targets.js';
import {
  encodeCloudAgentSessionScopeV2ViewHeaders,
  forwardCloudAgentSessionScopeRequest,
  forwardCloudAgentSessionScopeV2Request,
} from './cloud-agent-session-scope-proxy.js';
import type { ScopeGrantView } from './control-plane/sandbox/scope-view.js';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
  type RuntimeProxyAttestationAudience,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import { isControlSession } from './session-identity.js';
import { requestMethodAllowsBody } from './shared/http-proxy.js';
import { withDORetry } from './utils/do-retry.js';
import { readBoundedBody } from './utils/read-bounded-body.js';
import {
  runtimeCredentialProxyClientBaseUrl,
  runtimeCredentialProxyUpstream,
  verifyRuntimeCredentialProxyHandle,
  type RuntimeProxyHandleClaims,
} from './runtime-credential-proxy.js';
import {
  VERCEL_RUNTIME_PROXY_OIDC_HEADER,
  type RuntimeCredentialProxyOrigin,
} from './runtime-credential-proxy-origin.js';
import {
  logRuntimeProxyRequestFailed,
  readUpstreamFailureEvidence,
} from './runtime-credential-proxy-diagnostics.js';
import type { Env } from './types.js';

/** Stable public denial for a request without a trusted provider origin. */
export const RUNTIME_PROXY_ORIGIN_REQUIRED = 'runtime_proxy_origin_required';

export function runtimeProxyOriginRequiredResponse(): Response {
  return new Response(RUNTIME_PROXY_ORIGIN_REQUIRED, { status: 403 });
}

/**
 * The route and path a runtime proxy request addresses. `search` comes from the
 * original request, which for Vercel is reconstructed from its forward headers.
 */
export type RuntimeCredentialProxyRequestTarget = {
  route: RuntimeCredentialProxyRoute;
  path: string;
  search: string;
};

function routeTarget(pathname: string, search: string): RuntimeCredentialProxyRequestTarget | null {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const route = inferRuntimeCredentialProxyRoute(path);
  return route === null ? null : { route, path, search };
}

function rootPath(root: URL): string {
  return root.pathname === '/' ? '' : root.pathname.replace(/\/+$/, '');
}

function matchRoot(url: URL, root: URL): { path: string } | null {
  if (
    url.protocol !== root.protocol ||
    url.host !== root.host ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return null;
  }
  const prefix = rootPath(root);
  if (!prefix) return { path: url.pathname };
  if (url.pathname === prefix) return { path: '/' };
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  return { path: url.pathname.slice(prefix.length) };
}

/**
 * Recognizes only traffic addressed to the configured runtime facade authority.
 * Native containers reach the facade directly (production) or through the
 * reserved default-port client authority (local HTTP Worker); nothing else is a
 * runtime proxy request. This never exempts the request from authentication.
 */
export async function matchRuntimeCredentialProxyRequest(
  request: Request,
  env: Pick<Env, 'WORKER_URL'>
): Promise<RuntimeCredentialProxyRequestTarget | null> {
  if (!env.WORKER_URL) return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const configuredRoot = runtimeCredentialProxyClientBaseUrl(env.WORKER_URL);
  if (!configuredRoot) return null;
  const matched = matchRoot(url, new URL(configuredRoot));
  return matched ? routeTarget(matched.path, url.search) : null;
}

function connectionHeaders(headers: Headers): string[] {
  return (headers.get('connection') ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function runtimeProxyHeaders(request: Request, token: string, organizationId?: string): Headers {
  const headers = new Headers(request.headers);
  const connection = connectionHeaders(headers);
  for (const name of [
    'Authorization',
    'X-API-Key',
    'API-Key',
    'X-Auth-Token',
    'Cookie',
    'Host',
    'Connection',
    'Proxy-Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'X-Kilocode-OrganizationId',
    VERCEL_RUNTIME_PROXY_OIDC_HEADER,
    RUNTIME_PROXY_ATTESTATION_HEADER,
  ]) {
    headers.delete(name);
  }
  const attributionHeaders = new Set([
    'x-kilocode-feature',
    'x-kilocode-editorname',
    'x-kilocode-mode',
    'x-kilocode-machineid',
    'x-kilocode-taskid',
    'x-kilocode-projectid',
    'x-kilocode-version',
    'x-kilo-session',
    'x-kilo-request',
  ]);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith('proxy-') ||
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('x-vercel-') ||
      lower.startsWith('vercel-') ||
      lower.startsWith('x-internal-') ||
      connection.includes(lower) ||
      ((lower.startsWith('x-kilo-') || lower.startsWith('x-kilocode-')) &&
        !attributionHeaders.has(lower)) ||
      lower === 'forwarded' ||
      lower === 'x-real-ip' ||
      lower === 'x-kilocode-organizationid'
    ) {
      headers.delete(name);
    }
  }
  headers.set('Authorization', `Bearer ${token}`);
  if (organizationId) headers.set('X-Kilocode-OrganizationId', organizationId);
  return headers;
}

function sanitizeRuntimeProxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const connection = connectionHeaders(headers);
  for (const name of [
    'Set-Cookie',
    'Connection',
    'Proxy-Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    ...connection,
  ]) {
    headers.delete(name);
  }
  headers.delete(RUNTIME_PROXY_ATTESTATION_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createSanitizedForwardRequest(
  request: Request,
  url: string | URL,
  headers: Headers,
  body?: BodyInit
): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if ((body !== undefined || request.body) && requestMethodAllowsBody(request.method)) {
    init.body = body ?? request.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function runtimeProxyAuthorization(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  const match = authorization ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization) : null;
  return match?.[1] ?? null;
}

type RuntimeProxyCredential = {
  token: string;
  organizationId?: string;
  runtimeAuthorization: { userId: string; authorizationId: string; resourceId: string };
  scopeView?: ScopeGrantView;
};

async function resolveRuntimeProxyCredential(
  env: Env,
  handle: string,
  claims: RuntimeProxyHandleClaims,
  origin: RuntimeCredentialProxyOrigin
): Promise<RuntimeProxyCredential | null> {
  return withDORetry(
    () => getSandboxSessionStub(env, claims.userId, claims.sessionId),
    session => session.resolveOriginBoundRuntimeCredentialProxyGrant({ handle, origin }),
    'resolveOriginBoundRuntimeCredentialProxyGrant'
  );
}

function upstreamTarget(
  env: Env,
  credential: RuntimeProxyCredential
): {
  backendBaseUrl: string;
  providerBaseUrl: string;
  sessionIngestBaseUrl: string;
} | null {
  const derived = deriveKiloSandboxTargets(env, credential.token, { requireHttps: true });
  return derived.success ? derived.targets : deriveLoopbackFacadeTargets(env);
}

/**
 * Authenticated forwarding shared by the native containers outbound handler and
 * the Vercel runtime route. The provider adapter supplies the origin proof; the
 * Session DO admits it before any credential is resolved. There is deliberately
 * no unbound fallback.
 */
export async function forwardRuntimeCredentialProxy(
  request: Request,
  env: Env,
  target: RuntimeCredentialProxyRequestTarget,
  origin: RuntimeCredentialProxyOrigin
): Promise<Response> {
  const handle = runtimeProxyAuthorization(request);
  if (!handle) return new Response('Unauthorized', { status: 401 });
  const claims = await verifyRuntimeCredentialProxyHandle(env, handle);
  if (!claims || !isControlSession(claims.sessionId)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let bodyText: string | undefined;
  if (target.route === 'ingest' && target.path === '/api/session' && request.method === 'POST') {
    bodyText = (await readBoundedBody(request, 8192)) ?? undefined;
    if (bodyText === undefined) return new Response('Not found', { status: 404 });
  }

  let credential: RuntimeProxyCredential | null;
  try {
    credential = await resolveRuntimeProxyCredential(env, handle, claims, origin);
  } catch {
    return new Response('Credential unavailable', { status: 503 });
  }
  if (!credential) return new Response('Unauthorized', { status: 401 });
  const targets = upstreamTarget(env, credential);
  if (!targets) return new Response('Not found', { status: 404 });

  const { route, path, search } = target;
  const scopeView = route === 'ingest' ? credential.scopeView : undefined;
  let scopedV1 = false;
  let scopedV2Headers: Record<string, string> | null = null;
  let upstream: URL | null;
  if (scopeView !== undefined) {
    const adopted = resolveRuntimeCredentialProxyScopeIngestRoute({
      targets,
      route,
      method: request.method,
      pathname: path,
      search,
      memberRootKiloSessionIds: scopeView.memberRootKiloSessionIds,
      organizationId: credential.organizationId,
      contentType: request.headers.get('content-type'),
      bodyText,
    });
    if (adopted === null) return new Response('Not found', { status: 404 });
    upstream = adopted.upstream;
    if (adopted.kind === 'scoped') {
      const v2Headers = encodeCloudAgentSessionScopeV2ViewHeaders(scopeView);
      if (v2Headers === null) return new Response('Credential unavailable', { status: 503 });
      scopedV2Headers = v2Headers;
    }
  } else {
    const scopedUpstream = resolveRuntimeCredentialProxyScopedIngestRoute({
      targets,
      route,
      method: request.method,
      pathname: path,
      search,
      kiloSessionId: claims.kiloSessionId,
      organizationId: credential.organizationId,
      contentType: request.headers.get('content-type'),
      bodyText,
    });
    scopedV1 = scopedUpstream !== null;
    upstream =
      scopedUpstream ??
      runtimeCredentialProxyUpstream(
        targets,
        route,
        request.method,
        path,
        search,
        claims.kiloSessionId,
        credential.organizationId,
        request.headers.get('content-type'),
        bodyText
      );
  }
  if (!upstream) return new Response('Not found', { status: 404 });

  try {
    // The route allowlist is resolved above before a proof is issued.
    const audience: RuntimeProxyAttestationAudience =
      route === 'backend' ? 'kilo-api' : route === 'ingest' ? 'session-ingest' : 'kilo-gateway';
    const proof = await issueRuntimeProxyAttestation({
      secret: await resolveSecret(env.NEXTAUTH_SECRET).then(value => {
        if (!value) throw new Error('Authentication unavailable');
        return value;
      }),
      audience,
      bearer: credential.token,
      ...credential.runtimeAuthorization,
    });
    const headers = runtimeProxyHeaders(request, credential.token, credential.organizationId);
    headers.set(RUNTIME_PROXY_ATTESTATION_HEADER, proof);
    const forwardRequest = createSanitizedForwardRequest(request, upstream, headers, bodyText);
    const response =
      scopedV2Headers !== null
        ? await forwardCloudAgentSessionScopeV2Request(forwardRequest, env, {
            authorization: `Bearer ${credential.token}`,
            scopeHeaders: scopedV2Headers,
            runtimeProxyAttestation: proof,
          })
        : scopedV1
          ? await forwardCloudAgentSessionScopeRequest(forwardRequest, env, {
              authorization: `Bearer ${credential.token}`,
              sessionIngestScope: {
                cloudAgentSessionId: claims.sessionId,
                rootKiloSessionId: claims.kiloSessionId,
              },
              runtimeProxyAttestation: proof,
            })
          : await fetch(forwardRequest, { redirect: 'manual' });
    if (!response.ok) {
      logRuntimeProxyRequestFailed({
        upstreamAttempted: true,
        upstreamStatus: response.status,
        evidence: await readUpstreamFailureEvidence(response),
        sessionId: claims.sessionId,
        kiloSessionId: claims.kiloSessionId,
      });
    }
    return sanitizeRuntimeProxyResponse(response);
  } catch {
    return new Response('Upstream unavailable', { status: 502 });
  }
}
