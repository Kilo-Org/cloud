import type { KiloSdkSessionInfo } from '../../../session-ingest-binding.js';
import type { CloudAgentSession } from '../../../persistence/CloudAgentSession.js';
import { withDORetry } from '../../../utils/do-retry.js';
import type { QueuedMessageSnapshot } from '../../../websocket/stream.js';
import type { OwnedRootHandlerContext } from '../../contracts.js';
import {
  facadeError,
  invalidPersistedSessionDataResponse,
  isRecord,
  missingRootKiloSessionResponse,
  pendingSessionSnapshotResponse,
  readBoundedBody,
  retryableSessionReadResponse,
  validateIdScopedSelectors,
} from '../../http-contract.js';
import { projectPublicListedSession, projectPublicSession } from '../../public-sdk-projection.js';
import { handleLiveFirstSessionRead } from '../../session-read-source.js';

const MAX_KILO_SESSION_JSON_BYTES = 8 * 1024 * 1024;

function isKiloSdkSessionInfo(value: unknown, kiloSessionId: string): value is KiloSdkSessionInfo {
  return (
    isRecord(value) &&
    value.id === kiloSessionId &&
    typeof value.slug === 'string' &&
    typeof value.projectID === 'string' &&
    typeof value.directory === 'string' &&
    typeof value.title === 'string' &&
    typeof value.version === 'string' &&
    isRecord(value.time) &&
    typeof value.time.created === 'number' &&
    typeof value.time.updated === 'number'
  );
}

async function rewriteLiveSessionDetailResponse(
  response: Response,
  context: OwnedRootHandlerContext
): Promise<Response> {
  if (response.status === 404) return persistedSessionDetailResponse(context);
  if (!response.ok) return response;
  const kiloSessionId = context.kiloSessionId;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_SESSION_JSON_BYTES) {
      return facadeError(
        502,
        'KILO_UPSTREAM_RESPONSE_INVALID',
        'Kilo session response exceeds supported size'
      );
    }
  }
  const bytes = await readBoundedBody(response, MAX_KILO_SESSION_JSON_BYTES);
  if (!bytes) {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo session response exceeds supported size'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo session response is not valid JSON'
    );
  }
  if (!isKiloSdkSessionInfo(parsed, kiloSessionId)) {
    return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', 'Kilo session response is not valid');
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(projectPublicSession(parsed, kiloSessionId)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function pendingSessionDetailResponse(context: OwnedRootHandlerContext): Promise<Response> {
  const id = context.env.CLOUD_AGENT_SESSION.idFromName(
    `${context.userId}:${context.cloudAgentSessionId}`
  );
  const initial = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    QueuedMessageSnapshot | null
  >(
    () => context.env.CLOUD_AGENT_SESSION.get(id),
    stub => stub.getInitialMessageSnapshot(),
    'getInitialMessageSnapshot'
  ).catch(() => null);
  if (!initial) return pendingSessionSnapshotResponse();
  return Response.json(
    projectPublicListedSession({
      kiloSessionId: context.kiloSessionId,
      cloudAgentSessionId: context.cloudAgentSessionId,
      title: null,
      created: initial.timestamp,
      updated: initial.timestamp,
    })
  );
}

async function persistedSessionDetailResponse(context: OwnedRootHandlerContext): Promise<Response> {
  const snapshot = await context.env.SESSION_INGEST.getCloudAgentRootSessionSnapshot({
    kiloUserId: context.userId,
    kiloSessionId: context.kiloSessionId,
  });
  if (!snapshot) return missingRootKiloSessionResponse();
  switch (snapshot.snapshot.kind) {
    case 'pending':
      return pendingSessionDetailResponse(context);
    case 'too_large':
      return facadeError(
        413,
        'KILO_SESSION_SNAPSHOT_TOO_LARGE',
        'Persisted Kilo session snapshot exceeds the safe cold-read budget'
      );
    case 'retryable_failure':
      return retryableSessionReadResponse();
    case 'invalid_data':
      return invalidPersistedSessionDataResponse('session');
    case 'value':
      return Response.json(projectPublicSession(snapshot.snapshot.info, snapshot.kiloSessionId));
  }
}

export async function handleSessionDetail(context: OwnedRootHandlerContext): Promise<Response> {
  const selectorResponse = validateIdScopedSelectors(context.url, context.kiloSessionId, new Set());
  if (selectorResponse) return selectorResponse;
  return handleLiveFirstSessionRead({
    context,
    persistedFallback: () => persistedSessionDetailResponse(context),
    rewriteLiveResponse: response => rewriteLiveSessionDetailResponse(response, context),
  });
}
