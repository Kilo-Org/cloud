import {
  cloudAgentSyncAuthorizationSchema,
  cloudAgentSyncUploadSession,
  isCloudAgentSyncHandle,
  RUNTIME_PROXY_ORIGIN_HEADER,
  type CloudAgentSyncAuthorizationBinding,
} from '@kilocode/worker-utils/cloud-agent-session-sync';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { withTimeout } from '@kilocode/worker-utils';
import type { Principal } from './protocol';
import { jsonResponse } from './metrics';

export type CloudAgentUploadEnv = {
  CLOUD_AGENT_SYNC_AUTH?: CloudAgentSyncAuthorizationBinding;
};

function failure(status: number, code: string, message: string): Response {
  return jsonResponse(
    { error: { code, message, retryable: status === 503 } },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(status === 503 ? { 'Retry-After': '3' } : {}),
      },
    }
  );
}

async function resolve(
  env: CloudAgentUploadEnv,
  input: { handle: string; sessionID?: string; originProof?: string }
) {
  if (!env.CLOUD_AGENT_SYNC_AUTH)
    return failure(503, 'auth_unavailable', 'Cloud Agent upload authorization is unavailable');
  try {
    const result = await withTimeout(
      env.CLOUD_AGENT_SYNC_AUTH.authorizeUpload(input),
      5_000,
      'Cloud Agent upload authorization timed out'
    );
    if (result === null)
      return failure(401, 'invalid_credential', 'The Cloud Agent credential is invalid or expired');
    const parsed = cloudAgentSyncAuthorizationSchema.safeParse(result);
    if (!parsed.success || parsed.data.expiresAt <= Date.now())
      return failure(503, 'auth_unavailable', 'Cloud Agent upload authorization is unavailable');
    return parsed.data;
  } catch (error) {
    console.error('Session sync auth dependency failure', {
      operation: 'cloud-agent-upload',
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return failure(503, 'auth_unavailable', 'Cloud Agent upload authorization is unavailable');
  }
}

function principal(authorization: { userID: string; organizationID?: string }): Principal {
  return {
    userID: authorization.userID,
    tenant: authorization.organizationID
      ? { type: 'organization', id: authorization.organizationID }
      : { type: 'user', id: authorization.userID },
  };
}

export async function exchangeCloudAgentUpload(
  token: string,
  organizationID: string | undefined,
  env: CloudAgentUploadEnv
): Promise<Response | undefined> {
  if (!isCloudAgentSyncHandle(token)) return undefined;
  const authorization = await resolve(env, { handle: token });
  if (authorization instanceof Response) return authorization;
  if (authorization.organizationID !== organizationID)
    return failure(
      403,
      'organization_access_denied',
      'The Cloud Agent organization does not match'
    );
  // The opaque handle is not a tenant-wide sync grant. Every upload resolves it again.
  return jsonResponse(
    {
      version: 1,
      token,
      expiresAt: new Date(Math.min(authorization.expiresAt, Date.now() + 300_000)).toISOString(),
      ...principal(authorization),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function authorizeCloudAgentUpload(
  request: Request,
  env: CloudAgentUploadEnv
): Promise<Principal | Response | undefined> {
  const token = extractBearerToken(request.headers.get('Authorization'));
  if (!token || !isCloudAgentSyncHandle(token)) return undefined;
  const url = new URL(request.url);
  const sessionID = url.search ? null : cloudAgentSyncUploadSession(request.method, url.pathname);
  if (sessionID === null)
    return failure(403, 'upload_only', 'Cloud Agent credentials permit session uploads only');
  const authorization = await resolve(env, { handle: token, sessionID });
  return authorization instanceof Response ? authorization : principal(authorization);
}

/**
 * A sandbox may advertise itself as a presence runner. It cannot view instances or send
 * commands, and the handle must arrive through the platform egress of its own sandbox.
 */
export async function authorizeCloudAgentPresenceRunner(
  request: Request,
  env: CloudAgentUploadEnv,
  role: unknown
): Promise<{ principal: Principal; expiresAt: number } | Response | undefined> {
  const token = extractBearerToken(request.headers.get('Authorization'));
  if (!token || !isCloudAgentSyncHandle(token)) return undefined;
  if (role !== 'runner')
    return failure(
      403,
      'runner_only',
      'Cloud Agent credentials permit presence runner tickets only'
    );
  const originProof = request.headers.get(RUNTIME_PROXY_ORIGIN_HEADER);
  if (!originProof)
    return failure(401, 'invalid_credential', 'The Cloud Agent credential is invalid or expired');
  const authorization = await resolve(env, { handle: token, originProof });
  if (authorization instanceof Response) return authorization;
  return {
    principal: principal(authorization),
    expiresAt: Math.floor(authorization.expiresAt / 1000),
  };
}
