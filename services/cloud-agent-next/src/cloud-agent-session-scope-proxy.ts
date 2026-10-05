import {
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeProtocolVersion,
} from '@kilocode/session-ingest-contracts';
import { RUNTIME_PROXY_ATTESTATION_HEADER } from '@kilocode/worker-utils/runtime-proxy-attestation';

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

export async function forwardCloudAgentSessionScopeRequest(
  request: Request,
  env: Pick<Cloudflare.Env, 'INTERNAL_API_SECRET_PROD' | 'SESSION_INGEST'>,
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

  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  headers.delete('X-Internal-Secret');
  for (const headerName of [...headers.keys()]) {
    if (headerName.toLowerCase().startsWith('x-kilo-')) headers.delete(headerName);
  }
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
