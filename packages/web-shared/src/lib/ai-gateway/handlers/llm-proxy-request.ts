import { NextResponse, type NextRequest, type NextResponse as NextResponseType } from 'next/server';
import { z } from 'zod';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { providerPrivacySchema } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import {
  gatewayModelSchema,
  gatewayProviderSchema,
  validateRequestBody,
} from '@kilocode/web-shared/lib/ai-gateway/request-validation';
import {
  extractHeaderAndLimitLength,
  malformedJsonResponse,
  storeAndPreviousResponseIdIsNotSupported,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';

export type LlmProxyPath = '/chat/completions' | '/responses' | '/messages';

const contentPartsSchema = z.array(z.looseObject({}));
const tokenLimitSchema = z.number().int().nonnegative().nullish();
const commonRequestFields = {
  model: gatewayModelSchema,
  stream: z.boolean().nullish(),
  provider: gatewayProviderSchema.optional(),
};
const functionSchema = z.looseObject({ name: z.string() });
const chatToolSchema = z
  .looseObject({ type: z.string().optional(), function: functionSchema.optional() })
  .refine(tool => tool.type !== 'function' || tool.function !== undefined, { path: ['function'] });
const chatMessageSchema = z
  .looseObject({
    role: z.string(),
    content: z.union([z.string(), contentPartsSchema, z.null()]).optional(),
    tool_calls: z.array(z.looseObject({ id: z.string() })).nullish(),
    tool_call_id: z.string().optional(),
  })
  .refine(
    message =>
      (message.role === 'assistant' || message.content !== undefined) &&
      (message.role !== 'tool' || message.content !== null),
    { path: ['content'] }
  );

const chatRequestSchema = z.looseObject({
  ...commonRequestFields,
  max_tokens: tokenLimitSchema,
  max_completion_tokens: tokenLimitSchema,
  messages: z.array(chatMessageSchema),
  tools: z.array(chatToolSchema).nullish(),
  transforms: z.array(z.string()).nullish(),
});

const messagesRequestSchema = z.looseObject({
  ...commonRequestFields,
  max_tokens: tokenLimitSchema,
  messages: z.array(
    z.looseObject({ role: z.string(), content: z.union([z.string(), contentPartsSchema]) })
  ),
  system: z.union([z.string(), contentPartsSchema]).nullish(),
  tools: z.array(z.looseObject({ name: z.string() })).nullish(),
});

const responsesRequestSchema = z.looseObject({
  ...commonRequestFields,
  max_output_tokens: tokenLimitSchema,
  input: z.union([z.string(), contentPartsSchema]).nullish(),
  instructions: z.string().nullish(),
  tools: z
    .array(
      z
        .looseObject({ type: z.string().optional(), name: z.string().optional() })
        .refine(tool => tool.type !== 'function' || tool.name !== undefined, { path: ['name'] })
    )
    .nullish(),
});

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

export function parseLlmProxyRequest(
  path: LlmProxyPath,
  bodyText: string,
  ipAddress: string | undefined
): ParsedLlmProxyRequest {
  const reject = (response: NextResponseType<unknown>) => ({ ok: false, response }) as const;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    return reject(malformedJsonResponse(e));
  }

  let request: ValidatedGatewayRequest;
  if (path === '/chat/completions') {
    const result = validateRequestBody(body, chatRequestSchema);
    if (!result.success) return reject(result.response);
    const chatBody = result.data as OpenRouterChatCompletionRequest & { model: string };
    if (chatBody.stream) {
      chatBody.stream_options = { ...chatBody.stream_options, include_usage: true };
    }
    request = { kind: 'chat_completions', body: chatBody };
  } else if (path === '/messages') {
    const result = validateRequestBody(body, messagesRequestSchema);
    if (!result.success) return reject(result.response);
    request = { kind: 'messages', body: result.data as GatewayMessagesRequest & { model: string } };
  } else {
    const result = validateRequestBody(body, responsesRequestSchema);
    if (!result.success) return reject(result.response);
    request = {
      kind: 'responses',
      body: result.data as GatewayResponsesRequest & { model: string },
    };
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

  const { data_collection, zdr } = request.body.provider ?? {};
  const requestPrivacy = request.body.provider
    ? {
        ...(data_collection !== undefined && { data_collection }),
        ...(zdr !== undefined && { zdr }),
      }
    : undefined;
  return { ok: true, request, requestPrivacy, ipAddress };
}
