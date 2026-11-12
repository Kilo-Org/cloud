import { NextResponse, type NextRequest, type NextResponse as NextResponseType } from 'next/server';
import type { z } from 'zod';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  providerPreferencesSchema,
  type providerPrivacySchema,
} from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import {
  extractHeaderAndLimitLength,
  invalidRequestResponse,
  malformedJsonResponse,
  modelDoesNotExistResponse,
  storeAndPreviousResponseIdIsNotSupported,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';

export type LlmProxyPath = '/chat/completions' | '/responses' | '/messages';

export type ValidatedGatewayRequest = GatewayRequest & { body: { model: string } };

type ParsedLlmProxyRequest =
  | {
      ok: true;
      request: ValidatedGatewayRequest;
      requestPrivacy: z.infer<typeof providerPrivacySchema> | undefined;
      ipAddress: string;
    }
  | { ok: false; response: NextResponseType<unknown> };

export type LlmProxyRequestHeaders = ReturnType<typeof readLlmProxyHeaders>;

export function readLlmProxyHeaders(request: NextRequest) {
  const taskId = extractHeaderAndLimitLength(request, 'x-kilocode-taskid');
  return {
    mode: extractHeaderAndLimitLength(request, 'x-kilocode-mode'),
    taskId,
    // `x-kilo-session` is the fallback session id for clients that send no
    // `x-kilocode-taskid` (e.g. non-kilocode clients).
    sessionId: taskId ?? extractHeaderAndLimitLength(request, 'x-kilo-session'),
    // Per-message id from the kilocode client. Joinable to PostHog
    // `Feedback Submitted.parentMessageID`.
    clientRequestId: extractHeaderAndLimitLength(request, 'x-kilo-request'),
    machineId: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
    userAgent: extractHeaderAndLimitLength(request, 'user-agent'),
    // Vercel's per-invocation request id. Logged on the disconnect and upstream
    // failure paths so a client disconnect can be correlated with the upstream
    // error it causes, and with the platform logs for the same invocation.
    vercelRequestId: extractHeaderAndLimitLength(request, 'x-vercel-id'),
  };
}

function hasModelId(request: GatewayRequest): request is ValidatedGatewayRequest {
  return typeof request.body.model === 'string' && request.body.model.trim().length > 0;
}

function parseBody(path: LlmProxyPath, bodyText: string): GatewayRequest {
  if (path === '/chat/completions') {
    const body = JSON.parse(bodyText) as OpenRouterChatCompletionRequest;
    // Inject or merge stream_options.include_usage = true (only when streaming)
    if (body.stream) {
      body.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }
    return { kind: 'chat_completions', body };
  }
  if (path === '/messages') {
    return { kind: 'messages', body: JSON.parse(bodyText) as GatewayMessagesRequest };
  }
  return { kind: 'responses', body: JSON.parse(bodyText) as GatewayResponsesRequest };
}

/** Parses and validates the request body without I/O, so invalid requests fail before any work. */
export function parseLlmProxyRequest(
  path: LlmProxyPath,
  bodyText: string,
  ipAddress: string | undefined
): ParsedLlmProxyRequest {
  const reject = (response: NextResponseType<unknown>) => ({ ok: false, response }) as const;
  let request: GatewayRequest;
  try {
    request = parseBody(path, bodyText);
    // Usage accounting parses the response as SSE only when `stream` is exactly true.
    if (request.body.stream) {
      request.body.stream = true;
    }
  } catch (e) {
    return reject(malformedJsonResponse(e));
  }

  if (request.body.providerOptions !== undefined) {
    const error = 'The providerOptions field is not supported. Use provider instead.';
    return reject(
      NextResponse.json(
        { error, error_type: ProxyErrorType.unsupported_field, message: error },
        { status: 400 }
      )
    );
  }

  if (!hasModelId(request)) return reject(modelDoesNotExistResponse());

  if (
    (request.kind === 'chat_completions' || request.kind === 'messages') &&
    !Array.isArray(request.body.messages)
  ) {
    return reject(invalidRequestResponse());
  }

  if (request.kind === 'responses') {
    const { input } = request.body;
    if (input != null && typeof input !== 'string' && !Array.isArray(input)) {
      return reject(invalidRequestResponse());
    }
  }

  const requestPrivacy = providerPreferencesSchema.optional().safeParse(request.body.provider);
  if (!requestPrivacy.success) return reject(invalidRequestResponse());

  if (!ipAddress) {
    return reject(
      NextResponse.json(
        { error: 'Unable to determine client IP', error_type: ProxyErrorType.missing_client_ip },
        { status: 400 }
      )
    );
  }

  if (request.kind === 'responses' && (request.body.store || request.body.previous_response_id)) {
    return reject(storeAndPreviousResponseIdIsNotSupported());
  }

  // Canonicalize once so routing, policy, and the upstream request all see the same id.
  request.body.model = request.body.model.trim();
  return { ok: true, request, requestPrivacy: requestPrivacy.data, ipAddress };
}
