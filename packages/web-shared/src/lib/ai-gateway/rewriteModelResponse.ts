import { api_request_log_2, type User } from '@kilocode/db/schema';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import { detectToolCallArgumentErrors } from '@kilocode/web-shared/lib/ai-gateway/api-request-log-errors';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import type {
  ProviderType,
  ProviderResponseTransforms,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { getDynamicRequestLoggingMode } from '@kilocode/web-shared/lib/ai-gateway/request-logging-opt-ins';
import { stripNulBytesInPlace } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  apiRequestLogBlobKey,
  uploadApiRequestLogBlob,
  type EnkryptRequestLog,
} from '@kilocode/web-shared/lib/r2/api-request-log';
import { after, type NextResponse } from 'next/server';
import type {
  RequestLogCapture,
  ResponseUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.shared';
import { rewriteModelResponse_ChatCompletions } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.chatCompletions';
import { rewriteModelResponse_Messages } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.messages';
import { rewriteModelResponse_Responses } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.responses';

export type RequestLoggingParams = {
  /** The `microdollar_usage` id of the request, which is also the log row id. */
  usage_id: string;
  user: User | null;
  organization_id: string | null;
  session_id: string | null;
  vercel_request_id: string | null;
  request: GatewayRequest;
  enkrypt?: (captureResponse?: boolean) => Promise<EnkryptRequestLog[]>;
};

export type LogUnrewrittenResponseParams = {
  response: Response;
  model: string;
  logging: RequestLoggingParams;
  /** Merged into the logged `error`, e.g. to mark a response the gateway produced itself. */
  error: Record<string, string> | null;
};

export type RewriteModelResponseParams = {
  response: Response;
  model: string;
  providerId: ProviderType;
  kind: GatewayRequest['kind'];
  isFree: boolean;
  userByok: boolean;
  customLlmPricing: CustomPricingTiers | null;
  logging: RequestLoggingParams;
  responseTransforms: ProviderResponseTransforms | null;
  /** Only for the Cloud Agent runtime proxy caller; see `startFirstByteKeepAlive`. */
  keepAliveUntilFirstByte?: boolean;
};

type CapturedResponseBody =
  | { text: string; readError?: never }
  | { readError: string; text?: string };

const REDACTED = '[redacted]';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactFields(object: JsonObject, fields: readonly string[]): JsonObject {
  const redacted = { ...object };
  for (const field of fields) {
    if (redacted[field] !== undefined && redacted[field] !== null) redacted[field] = REDACTED;
  }
  return redacted;
}

/** Keeps header names, which are useful for debugging, and redacts every value. */
function redactHeaderValues(object: JsonObject, field: string): JsonObject {
  const headers = object[field];
  if (!isJsonObject(headers)) return object;
  return {
    ...object,
    [field]: Object.fromEntries(Object.keys(headers).map(name => [name, REDACTED])),
  };
}

function mapObjectArray(value: unknown, map: (object: JsonObject) => JsonObject): unknown {
  return Array.isArray(value)
    ? value.map((item: unknown) => (isJsonObject(item) ? map(item) : item))
    : value;
}

function redactMcpServer(server: JsonObject): JsonObject {
  return redactHeaderValues(
    redactFields(server, ['authorization', 'authorization_token']),
    'headers'
  );
}

function redactShellTool(tool: JsonObject): JsonObject {
  const environment = tool.environment;
  if (!isJsonObject(environment) || !isJsonObject(environment.network_policy)) return tool;
  const networkPolicy = environment.network_policy;
  return {
    ...tool,
    environment: {
      ...environment,
      network_policy: {
        ...networkPolicy,
        domain_secrets: mapObjectArray(networkPolicy.domain_secrets, secret =>
          redactFields(secret, ['value'])
        ),
      },
    },
  };
}

function redactTool(tool: JsonObject): JsonObject {
  switch (tool.type) {
    // OpenAI, xAI, Groq and OpenRouter Responses remote MCP and connectors, and the Gemini
    // Interactions API
    // https://developers.openai.com/api/docs/guides/tools-connectors-mcp
    // https://docs.x.ai/docs/guides/tools/remote-mcp-tools
    // https://console.groq.com/docs/tool-use/remote-mcp
    // https://ai.google.dev/api/interactions-api
    case 'mcp':
    case 'mcp_server':
      return redactMcpServer(tool);
    // https://openrouter.ai/openapi.json (McpServerToolParameters)
    case 'openrouter:mcp':
      return isJsonObject(tool.parameters)
        ? { ...tool, parameters: redactMcpServer(tool.parameters) }
        : tool;
    // https://developers.openai.com/api/docs/guides/tools-shell
    case 'shell':
      return redactShellTool(tool);
    default:
      return tool;
  }
}

// Azure OpenAI On Your Data
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/azure-search
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/elasticsearch
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/mongo-db
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/cosmos-db
const AZURE_DATA_SOURCE_SECRET_FIELDS = [
  'key',
  'key_id',
  'access_token',
  'encoded_api_key',
  'password',
  'connection_string',
] as const;

function redactAzureAuthentication(object: JsonObject): JsonObject {
  return isJsonObject(object.authentication)
    ? {
        ...object,
        authentication: redactFields(object.authentication, AZURE_DATA_SOURCE_SECRET_FIELDS),
      }
    : object;
}

function redactDataSource(dataSource: JsonObject): JsonObject {
  const parameters = dataSource.parameters;
  if (!isJsonObject(parameters)) return dataSource;
  const redactedParameters = redactAzureAuthentication(parameters);
  return {
    ...dataSource,
    parameters: isJsonObject(parameters.embedding_dependency)
      ? {
          ...redactedParameters,
          embedding_dependency: redactAzureAuthentication(parameters.embedding_dependency),
        }
      : redactedParameters,
  };
}

// https://vercel.com/docs/ai-gateway/authentication-and-byok/byok
function redactProviderOptions(providerOptions: unknown): unknown {
  if (!isJsonObject(providerOptions)) return providerOptions;
  const gateway = providerOptions.gateway;
  if (!isJsonObject(gateway) || !isJsonObject(gateway.byok)) return providerOptions;
  const redactedByok = Object.fromEntries(
    Object.entries(gateway.byok).map(([provider, credentials]) => [
      provider,
      Array.isArray(credentials) ? credentials.map(() => ({ apiKey: REDACTED })) : REDACTED,
    ])
  );
  return { ...providerOptions, gateway: { ...gateway, byok: redactedByok } };
}

/**
 * Redacts credentials that clients embed in documented, structured request fields. String
 * content such as messages is logged as-is.
 */
export function redactApiRequestLogRequest(request: GatewayRequest): Record<string, unknown> {
  const body: JsonObject = { ...request.body };
  if (body.providerOptions !== undefined) {
    body.providerOptions = redactProviderOptions(body.providerOptions);
  }
  if (body.tools !== undefined) {
    body.tools = mapObjectArray(body.tools, redactTool);
  }
  // Anthropic MCP connector
  // https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
  if (body.mcp_servers !== undefined) {
    body.mcp_servers = mapObjectArray(body.mcp_servers, redactMcpServer);
  }
  if (body.data_sources !== undefined) {
    body.data_sources = mapObjectArray(body.data_sources, redactDataSource);
  }
  return body;
}

async function createRequestLogCapture(
  response: Response,
  model: string,
  logging: RequestLoggingParams,
  extraError: Record<string, string> | null
): Promise<RequestLogCapture | null> {
  const { usage_id, user, organization_id, session_id, request } = logging;
  const loggingMode = await getDynamicRequestLoggingMode({
    accountId: user?.id ?? null,
    organizationId: organization_id,
  });
  // Anonymous requests have neither an account nor an organization to opt in, so they never match.
  if (loggingMode === null || user === null) {
    if (logging.enkrypt) after(async () => void (await logging.enkrypt?.(false)));
    return null;
  }
  const status = response.status;
  let generationId: string | null = null;

  let resolveCaptured: (result: CapturedResponseBody) => void = () => {};
  const captured = new Promise<CapturedResponseBody>(resolve => {
    resolveCaptured = resolve;
  });
  let isSettled = false;
  const settleOnce = (result: CapturedResponseBody) => {
    if (!isSettled) {
      isSettled = true;
      resolveCaptured(result);
    }
  };

  after(async () => {
    // Wait until the response pipeline has processed the response body. This
    // resolves when the response stream completes (or fails), which happens
    // before after() callbacks are awaited.
    const result = await captured;
    const responseText = 'text' in result ? result.text : undefined;
    const responseReadError = 'readError' in result ? result.readError : undefined;
    if (responseReadError !== undefined) {
      logExceptInTest(
        `[rewriteModelResponse] failed to read response body (user=${user?.id}, status=${status}, model=${model}): ${responseReadError}`
      );
    }
    try {
      const responseError =
        responseText !== undefined
          ? responseReadError !== undefined
            ? {
                ...(detectToolCallArgumentErrors(responseText, request) ?? {}),
                response_body_read_error: responseReadError,
              }
            : detectToolCallArgumentErrors(responseText, request)
          : { response_body_read_error: responseReadError };
      const detectedError =
        extraError === null ? responseError : { ...(responseError ?? {}), ...extraError };
      if (loggingMode === 'errors_only' && status < 400 && detectedError === null) {
        await logging.enkrypt?.(false);
        return;
      }
      const row = {
        id: usage_id,
        created_at: new Date().toISOString(),
        generation_id: generationId,
        kilo_user_id: user.id,
        organization_id,
        session_id,
        requested_model: model,
      };
      // The session ID comes from client headers and the generation ID from the upstream
      // response; Postgres text rejects NUL bytes. Stripping them, as microdollar_usage_metadata
      // does, keeps the session ID equal to the one stored there.
      stripNulBytesInPlace(row, []);
      const uploadError = await uploadApiRequestLogBlob(apiRequestLogBlobKey(row), {
        request: redactApiRequestLogRequest(request),
        response: responseText ?? null,
        error: detectedError,
        enkrypt: await logging.enkrypt?.(),
      });
      if (uploadError !== null) {
        logExceptInTest(
          `[rewriteModelResponse] failed to upload api_request_log_2 blob to R2 (user=${user.id}, status=${status}, model=${model}): ${uploadError.substring(0, 4000)}`
        );
        return;
      }
      await db.insert(api_request_log_2).values(row);
      logExceptInTest('[rewriteModelResponse] Inserted into api_request_log_2', usage_id);
    } catch (e) {
      const cause = e instanceof Error ? e.cause : undefined;
      logExceptInTest(
        `[rewriteModelResponse] failed to insert api_request_log_2 (user=${user.id}, status=${status}, model=${model}) cause (truncated): ${String(cause).substring(0, 4000)} error (truncated): ${String(e).substring(0, 4000)}`
      );
    }
  });

  return {
    setGenerationId: id => {
      generationId ??= id;
    },
    setBody: text => settleOnce({ text }),
    setReadError: (error, partialBody) =>
      settleOnce(
        partialBody !== undefined && partialBody.length > 0
          ? { text: partialBody, readError: String(error).substring(0, 4000) }
          : { readError: String(error).substring(0, 4000) }
      ),
  };
}

/** For paths where the upstream response is not passed through rewriteModelResponse. */
export async function logUnrewrittenResponse({
  response,
  model,
  logging,
  error,
}: LogUnrewrittenResponseParams): Promise<void> {
  const capture = await createRequestLogCapture(response, model, logging, error);
  if (!capture) {
    return;
  }
  try {
    capture.setBody(await response.text());
  } catch (error) {
    capture.setReadError(error);
  }
}

export async function rewriteModelResponse({
  response,
  model,
  providerId,
  kind,
  isFree,
  userByok,
  customLlmPricing,
  logging,
  responseTransforms,
  keepAliveUntilFirstByte,
}: RewriteModelResponseParams): Promise<NextResponse> {
  const capture = await createRequestLogCapture(response, model, logging, null);
  const usageContext: ResponseUsageContext = {
    requested_model: model,
    provider: providerId,
    api_kind: kind,
    is_free: isFree,
    user_byok: userByok,
    custom_llm_pricing: customLlmPricing,
    custom_pricing_config: await getCustomPricingConfig(),
  };

  console.debug('[rewriteModelResponse] rewriting response for %s', model);
  const { vercel_request_id: vercelRequestId } = logging;
  const reasoningEffort = getReasoningEffort(logging.request);
  if (kind === 'chat_completions') {
    return rewriteModelResponse_ChatCompletions({
      response,
      usageContext,
      capture,
      reasoningEffort,
      vercelRequestId,
      responseTransforms,
      keepAliveUntilFirstByte,
    });
  }
  if (kind === 'responses') {
    return rewriteModelResponse_Responses({
      response,
      usageContext,
      capture,
      reasoningEffort,
      vercelRequestId,
      keepAliveUntilFirstByte,
    });
  }
  if (kind === 'messages') {
    return rewriteModelResponse_Messages({
      response,
      usageContext,
      capture,
      reasoningEffort,
      vercelRequestId,
      keepAliveUntilFirstByte,
    });
  }

  const error = new Error(`implementation error: unrecognized API kind ${kind}`);
  capture?.setReadError(error);
  throw error;
}
