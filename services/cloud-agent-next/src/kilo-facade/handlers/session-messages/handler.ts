import {
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
  validateKiloSdkMessagesCursor,
} from '@kilocode/session-ingest-contracts';
import type {
  GetCloudAgentRootSessionMessagesParams,
  KiloSdkStoredMessage,
} from '../../../session-ingest-binding.js';
import type { CloudAgentSession } from '../../../persistence/CloudAgentSession.js';
import { withDORetry } from '../../../utils/do-retry.js';
import type { QueuedMessageSnapshot } from '../../../websocket/stream.js';
import type { OwnedRootHandlerContext } from '../../contracts.js';
import {
  facadeError,
  invalidPersistedSessionDataResponse,
  missingRootKiloSessionResponse,
  pendingSessionSnapshotResponse,
  readBoundedBody,
  retryableSessionReadResponse,
  unsupportedSessionSelectorResponse,
  validateIdScopedSelectors,
} from '../../http-contract.js';
import { projectPublicStoredMessages } from '../../public-sdk-projection.js';
import { handleLiveFirstSessionRead } from '../../session-read-source.js';
import { parseOwnedKiloSdkStoredMessages } from '../../stored-message-validation.js';

const MAX_KILO_SESSION_JSON_BYTES = 8 * 1024 * 1024;
const SUPPORTED_QUERY_PARAMS = new Set(['directory', 'limit', 'before']);

function parseSessionMessagesQuery(
  url: URL
): Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'> | Response {
  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED_QUERY_PARAMS.has(key)) return unsupportedSessionSelectorResponse();
  }
  const params: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'> = {};
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    const limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        `Session messages limit must be an integer from 0 to ${MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE}`
      );
    }
    params.limit = limit;
  }
  const before = url.searchParams.get('before');
  if (before !== null) {
    if (before.length === 0 || params.limit === undefined || params.limit === 0) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session messages before requires a positive limit'
      );
    }
    if (!validateKiloSdkMessagesCursor(before)) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session messages before is not a valid cursor'
      );
    }
    params.before = before;
  }
  return params;
}

async function rewriteLiveMessagesResponse(
  response: Response,
  context: OwnedRootHandlerContext,
  query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>
): Promise<Response> {
  if (response.status === 404) return persistedSessionMessagesResponse(context, query);
  if (!response.ok) return response;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_SESSION_JSON_BYTES) {
      return facadeError(
        502,
        'KILO_UPSTREAM_RESPONSE_INVALID',
        'Kilo messages response exceeds supported size'
      );
    }
  }
  const bytes = await readBoundedBody(response, MAX_KILO_SESSION_JSON_BYTES);
  if (!bytes) {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo messages response exceeds supported size'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo messages response is not valid JSON'
    );
  }
  const messages = parseOwnedKiloSdkStoredMessages(parsed, context.kiloSessionId);
  if (!messages) {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo messages response is not valid'
    );
  }
  const output =
    messages.length > 0
      ? projectPublicStoredMessages(messages, context.kiloSessionId)
      : await initialStoredMessages(context, query);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(output), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function initialStoredMessage(
  snapshot: QueuedMessageSnapshot,
  kiloSessionId: string
): KiloSdkStoredMessage {
  return {
    info: {
      id: snapshot.messageId,
      sessionID: kiloSessionId,
      role: 'user',
      time: { created: snapshot.timestamp },
      agent: '',
      model: { providerID: '', modelID: '' },
    },
    parts: [
      {
        id: `prt_${snapshot.messageId}`,
        sessionID: kiloSessionId,
        messageID: snapshot.messageId,
        type: 'text',
        text: snapshot.content,
      },
    ],
  };
}

async function initialStoredMessages(
  context: OwnedRootHandlerContext,
  query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>
): Promise<KiloSdkStoredMessage[]> {
  if (query.before !== undefined) return [];
  const id = context.env.CLOUD_AGENT_SESSION.idFromName(
    `${context.userId}:${context.cloudAgentSessionId}`
  );
  const snapshot = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    QueuedMessageSnapshot | null
  >(
    () => context.env.CLOUD_AGENT_SESSION.get(id),
    stub => stub.getInitialMessageSnapshot(),
    'getInitialMessageSnapshot'
  ).catch(() => null);
  return snapshot?.content ? [initialStoredMessage(snapshot, context.kiloSessionId)] : [];
}

function messagesPageResponse(
  requestUrl: URL,
  messages: unknown,
  nextCursor: string | null,
  omittedItemCount: number
): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'X-Kilo-Omitted-Item-Count': String(omittedItemCount),
  });
  if (nextCursor !== null) {
    const nextUrl = new URL(requestUrl);
    nextUrl.searchParams.set('before', nextCursor);
    headers.set('Link', `<${nextUrl.toString()}>; rel="next"`);
    headers.set('X-Next-Cursor', nextCursor);
  }
  return new Response(JSON.stringify(messages), { headers });
}

async function persistedSessionMessagesResponse(
  context: OwnedRootHandlerContext,
  query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>
): Promise<Response> {
  const result = await context.env.SESSION_INGEST.getCloudAgentRootSessionMessages({
    kiloUserId: context.userId,
    kiloSessionId: context.kiloSessionId,
    ...query,
  });
  if (!result) return missingRootKiloSessionResponse();
  if (result.history === null) {
    const initial = await initialStoredMessages(context, query);
    return initial.length > 0
      ? messagesPageResponse(context.url, initial, null, 0)
      : pendingSessionSnapshotResponse();
  }
  if ('kind' in result.history) {
    switch (result.history.kind) {
      case 'too_large':
        return facadeError(
          413,
          'KILO_TRANSCRIPT_TOO_LARGE',
          'Persisted Kilo transcript exceeds the safe cold-read budget; use smaller bounded history when possible, or retry while a live runtime is available'
        );
      case 'retryable_failure':
        return retryableSessionReadResponse();
      case 'invalid_data':
        return invalidPersistedSessionDataResponse('messages');
    }
  }
  const messages = projectPublicStoredMessages(result.history.messages, context.kiloSessionId);
  const output = messages.length > 0 ? messages : await initialStoredMessages(context, query);
  return messagesPageResponse(
    context.url,
    output,
    result.history.nextCursor,
    result.history.omittedItemCount ?? 0
  );
}

export async function handleSessionMessages(context: OwnedRootHandlerContext): Promise<Response> {
  const selectorResponse = validateIdScopedSelectors(
    context.url,
    context.kiloSessionId,
    new Set(['limit', 'before'])
  );
  if (selectorResponse) return selectorResponse;
  const query = parseSessionMessagesQuery(context.url);
  if (query instanceof Response) return query;
  return handleLiveFirstSessionRead({
    context,
    persistedFallback: () => persistedSessionMessagesResponse(context, query),
    rewriteLiveResponse: response => rewriteLiveMessagesResponse(response, context, query),
  });
}
