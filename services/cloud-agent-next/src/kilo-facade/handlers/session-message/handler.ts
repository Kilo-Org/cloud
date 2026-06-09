import type { OwnedRootHandlerContext } from '../../contracts.js';
import {
  facadeError,
  invalidPersistedSessionDataResponse,
  isRecord,
  missingRootKiloSessionResponse,
  readBoundedBody,
  retryableSessionReadResponse,
  validateIdScopedSelectors,
} from '../../http-contract.js';
import { projectPublicStoredMessage } from '../../public-sdk-projection.js';
import { handleLiveFirstSessionRead } from '../../session-read-source.js';
import { parseOwnedKiloSdkStoredMessage } from '../../stored-message-validation.js';

const MAX_KILO_SESSION_JSON_BYTES = 8 * 1024 * 1024;

function exactMessageNotFoundResponse(): Response {
  return facadeError(404, 'KILO_MESSAGE_NOT_FOUND', 'Kilo session message was not found');
}

async function rewriteLiveSessionMessageResponse(
  response: Response,
  kiloSessionId: string,
  messageId: string
): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type');
  if (!contentType?.toLowerCase().includes('application/json')) {
    return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', 'Kilo message response is not valid');
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_SESSION_JSON_BYTES) {
      return facadeError(
        502,
        'KILO_UPSTREAM_RESPONSE_INVALID',
        'Kilo message response exceeds supported size'
      );
    }
  }
  const bytes = await readBoundedBody(response, MAX_KILO_SESSION_JSON_BYTES);
  if (!bytes) {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo message response exceeds supported size'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo message response is not valid JSON'
    );
  }
  const message = parseOwnedKiloSdkStoredMessage(parsed, kiloSessionId, messageId);
  if (!message) {
    return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', 'Kilo message response is not valid');
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(projectPublicStoredMessage(message, kiloSessionId)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function persistedSessionMessageResponse(
  context: OwnedRootHandlerContext,
  messageId: string
): Promise<Response> {
  const result = await context.env.SESSION_INGEST.getCloudAgentRootSessionMessage({
    kiloUserId: context.userId,
    kiloSessionId: context.kiloSessionId,
    messageId,
  });
  if (!result) return missingRootKiloSessionResponse();
  if (
    result.kiloSessionId !== context.kiloSessionId ||
    result.cloudAgentSessionId !== context.cloudAgentSessionId ||
    !isRecord(result.message)
  ) {
    return invalidPersistedSessionDataResponse('messages');
  }
  switch (result.message.kind) {
    case 'not_found':
      return exactMessageNotFoundResponse();
    case 'too_large':
      return facadeError(
        413,
        'KILO_TRANSCRIPT_TOO_LARGE',
        'Persisted Kilo message exceeds the safe cold-read budget; retry while a live runtime is available'
      );
    case 'retryable_failure':
      return retryableSessionReadResponse();
    case 'invalid_data':
      return invalidPersistedSessionDataResponse('messages');
    case 'value': {
      const message = parseOwnedKiloSdkStoredMessage(
        result.message.message,
        context.kiloSessionId,
        messageId
      );
      if (!message) return invalidPersistedSessionDataResponse('messages');
      return Response.json(projectPublicStoredMessage(message, context.kiloSessionId));
    }
  }
}

export async function handleSessionMessage(
  context: OwnedRootHandlerContext,
  messageId: string
): Promise<Response> {
  if (messageId.includes('/') || messageId.includes('\u0000') || !messageId.startsWith('msg')) {
    return exactMessageNotFoundResponse();
  }
  const selectorResponse = validateIdScopedSelectors(context.url, context.kiloSessionId, new Set());
  if (selectorResponse) return selectorResponse;
  return handleLiveFirstSessionRead({
    context,
    persistedFallback: () => persistedSessionMessageResponse(context, messageId),
    rewriteLiveResponse: (response, kiloSessionId) =>
      rewriteLiveSessionMessageResponse(response, kiloSessionId, messageId),
  });
}
