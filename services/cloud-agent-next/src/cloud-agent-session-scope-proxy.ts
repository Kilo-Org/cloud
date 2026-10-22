import {
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeProtocolVersion,
  cloudAgentSessionScopeProtocolVersionV2,
  cloudAgentSessionScopeV2Headers,
  cloudAgentWorktreeIdSchema,
  encodeCloudAgentSessionScopeV2Headers,
  MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_BYTES,
  MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS,
  measureCloudAgentSessionScopeV2HeaderBytes,
} from '@kilocode/session-ingest-contracts';
import { RUNTIME_PROXY_ATTESTATION_HEADER } from '@kilocode/worker-utils/runtime-proxy-attestation';
import type { ScopeGrantView } from './control-plane/sandbox/scope-view.js';

type ScopeProxyEnv = Pick<Cloudflare.Env, 'INTERNAL_API_SECRET_PROD' | 'SESSION_INGEST'>;

function getCloudAgentSessionScopeInternalUrl(requestUrl: string): URL | null {
  const url = new URL(requestUrl);
  if (url.pathname.endsWith('/api/session')) {
    url.pathname = '/internal/cloud-agent/v1/session';
    return url;
  }
  if (/\/api\/session\/[^/]+\/ingest$/.test(url.pathname)) {
    const sessionId = url.pathname.split('/').at(-2);
    if (!sessionId) return null;
    url.pathname = `/internal/cloud-agent/v1/session/${encodeURIComponent(sessionId)}/ingest`;
    return url;
  }
  return null;
}

function getCloudAgentSessionScopeV2InternalUrl(requestUrl: string): URL | null {
  const url = new URL(requestUrl);
  if (url.pathname.endsWith('/api/session')) {
    url.pathname = '/internal/cloud-agent/v1/session';
    return url;
  }
  const match = /\/api\/session\/([^/]+)\/(ingest|export|title)$/.exec(url.pathname);
  if (!match?.[1] || !match[2]) return null;
  url.pathname = `/internal/cloud-agent/v1/session/${encodeURIComponent(match[1])}/${match[2]}`;
  return url;
}

/** Strips every caller-supplied scope and credential header before the facade sets its own. */
function stripCallerScopeHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  headers.delete('X-Internal-Secret');
  for (const headerName of [...headers.keys()]) {
    if (headerName.toLowerCase().startsWith('x-kilo-')) headers.delete(headerName);
  }
  return headers;
}

/**
 * Encodes the scope view as the v2 header block, or null when the receiver
 * would reject it or it exceeds the contract limits: a non-worktree scope id, an
 * empty member-root list, more than 32 roots, or an encoded block over 4096
 * bytes. The facade maps null to its 503; it never truncates an authorized root.
 */
export function encodeCloudAgentSessionScopeV2ViewHeaders(
  view: ScopeGrantView
): Record<string, string> | null {
  if (view.memberRootKiloSessionIds.length === 0) return null;
  if (view.memberRootKiloSessionIds.length > MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS)
    return null;
  if (!cloudAgentWorktreeIdSchema.safeParse(view.scopeId).success) return null;
  const encoded = encodeCloudAgentSessionScopeV2Headers({
    worktreeId: view.scopeId,
    organizationId: view.expectedOrganizationId,
    memberRootKiloSessionIds: view.memberRootKiloSessionIds,
  });
  if (
    measureCloudAgentSessionScopeV2HeaderBytes(encoded) > MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_BYTES
  ) {
    return null;
  }
  return {
    [cloudAgentSessionScopeV2Headers.worktreeId]: encoded.worktreeId,
    [cloudAgentSessionScopeV2Headers.expectedOrganization]: encoded.expectedOrganization,
    [cloudAgentSessionScopeV2Headers.memberRootKiloSessionIds]: encoded.memberRootKiloSessionIds,
    [cloudAgentSessionScopeHeaders.protocolVersion]: cloudAgentSessionScopeProtocolVersionV2,
  };
}

export async function forwardCloudAgentSessionScopeRequest(
  request: Request,
  env: ScopeProxyEnv,
  result: {
    authorization: string;
    sessionIngestScope: { cloudAgentSessionId: string; rootKiloSessionId: string };
    runtimeProxyAttestation?: string;
  }
): Promise<Response> {
  const url = getCloudAgentSessionScopeInternalUrl(request.url);
  if (!url || request.method !== 'POST')
    throw new Error('Unsupported Cloud Agent session scope route');

  const internalSecret = await env.INTERNAL_API_SECRET_PROD.get();
  if (!internalSecret) throw new Error('Session Ingest internal secret unavailable');

  const headers = stripCallerScopeHeaders(request);
  headers.set('Authorization', result.authorization);
  headers.set('X-Internal-Secret', internalSecret);
  headers.set(
    cloudAgentSessionScopeHeaders.cloudAgentSessionId,
    result.sessionIngestScope.cloudAgentSessionId
  );
  headers.set(
    cloudAgentSessionScopeHeaders.rootKiloSessionId,
    result.sessionIngestScope.rootKiloSessionId
  );
  headers.set(cloudAgentSessionScopeHeaders.protocolVersion, cloudAgentSessionScopeProtocolVersion);
  if (result.runtimeProxyAttestation) {
    headers.set(RUNTIME_PROXY_ATTESTATION_HEADER, result.runtimeProxyAttestation);
  }

  const internalRequest = new Request(url, request);
  return env.SESSION_INGEST.fetch(
    new Request(internalRequest, {
      headers,
      redirect: 'manual',
    })
  );
}

export async function forwardCloudAgentSessionScopeV2Request(
  request: Request,
  env: ScopeProxyEnv,
  result: {
    authorization: string;
    scopeHeaders: Record<string, string>;
    runtimeProxyAttestation?: string;
  }
): Promise<Response> {
  const url = getCloudAgentSessionScopeV2InternalUrl(request.url);
  if (!url) throw new Error('Unsupported Cloud Agent session scope v2 route');

  const internalSecret = await env.INTERNAL_API_SECRET_PROD.get();
  if (!internalSecret) throw new Error('Session Ingest internal secret unavailable');

  const headers = stripCallerScopeHeaders(request);
  headers.set('Authorization', result.authorization);
  headers.set('X-Internal-Secret', internalSecret);
  for (const [name, value] of Object.entries(result.scopeHeaders)) headers.set(name, value);
  if (result.runtimeProxyAttestation) {
    headers.set(RUNTIME_PROXY_ATTESTATION_HEADER, result.runtimeProxyAttestation);
  }

  const internalRequest = new Request(url, request);
  return env.SESSION_INGEST.fetch(
    new Request(internalRequest, {
      headers,
      redirect: 'manual',
    })
  );
}
