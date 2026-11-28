import {
  cloudAgentOrganizationIdSchema,
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeProtocolVersion,
  cloudAgentSessionScopeProtocolVersionV2,
  cloudAgentSessionScopeV2Headers,
  cloudAgentWorktreeIdSchema,
  MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_VALUE_BYTES,
  measureCloudAgentSessionScopeV2HeaderValueBytes,
  tryEncodeCloudAgentSessionScopeV2Headers,
} from '@kilocode/session-ingest-contracts';
import { RUNTIME_PROXY_ATTESTATION_HEADER } from '@kilocode/worker-utils/runtime-proxy-attestation';
import type { ScopeGrantView } from './control-plane/sandbox/scope-view.js';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { readCloudAgentNextStoreSecret, type CloudAgentNextSecretsEnv } from './secrets.js';
import { sessionIngestCallerAuth } from './session-ingest-caller-auth.js';

type ScopeProxyEnv = Pick<Cloudflare.Env, 'SESSION_INGEST'> & CloudAgentNextSecretsEnv;

/**
 * The facade's credential toward Session Ingest (`SESSION_INGEST_CALLER_AUTH`): the internal
 * secret under `legacy`, nothing under `binding`, where the binding's `props.caller` identifies
 * this Worker. Throws rather than forward without a credential.
 */
async function sessionIngestCredential(
  env: ScopeProxyEnv,
  ctx?: SecretsExecutionContext
): Promise<Record<string, string>> {
  if (sessionIngestCallerAuth(env) === 'binding') return {};
  const internalSecret = await readCloudAgentNextStoreSecret(env, 'INTERNAL_API_SECRET', ctx);
  if (!internalSecret) throw new Error('Session Ingest internal secret unavailable');
  return { 'X-Internal-Secret': internalSecret };
}

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
 * would reject it or it exceeds the contract limits: a scope outside the v2
 * assertion contract (a non-worktree scope id, an empty member-root list, more
 * than 32 roots, a malformed organization), or header values whose encoded
 * bytes sum over 4096. The facade maps null to its 503; it never truncates an
 * authorized root.
 */
export function encodeCloudAgentSessionScopeV2ViewHeaders(
  view: ScopeGrantView
): Record<string, string> | null {
  const worktreeId = cloudAgentWorktreeIdSchema.safeParse(view.scopeId);
  if (!worktreeId.success) return null;
  const organizationId =
    view.expectedOrganizationId === null
      ? null
      : cloudAgentOrganizationIdSchema.safeParse(view.expectedOrganizationId);
  if (organizationId !== null && !organizationId.success) return null;
  const encoded = tryEncodeCloudAgentSessionScopeV2Headers({
    worktreeId: worktreeId.data,
    organizationId: organizationId === null ? null : organizationId.data,
    memberRootKiloSessionIds: view.memberRootKiloSessionIds,
  });
  if (encoded === null) return null;
  if (
    measureCloudAgentSessionScopeV2HeaderValueBytes(encoded) >
    MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_VALUE_BYTES
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
  },
  ctx?: SecretsExecutionContext
): Promise<Response> {
  const url = getCloudAgentSessionScopeInternalUrl(request.url);
  if (!url || request.method !== 'POST')
    throw new Error('Unsupported Cloud Agent session scope route');

  const credential = await sessionIngestCredential(env, ctx);

  const headers = stripCallerScopeHeaders(request);
  headers.set('Authorization', result.authorization);
  for (const [name, value] of Object.entries(credential)) headers.set(name, value);
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
  },
  ctx?: SecretsExecutionContext
): Promise<Response> {
  const url = getCloudAgentSessionScopeV2InternalUrl(request.url);
  if (!url) throw new Error('Unsupported Cloud Agent session scope v2 route');

  const credential = await sessionIngestCredential(env, ctx);

  const headers = stripCallerScopeHeaders(request);
  headers.set('Authorization', result.authorization);
  for (const [name, value] of Object.entries(credential)) headers.set(name, value);
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
