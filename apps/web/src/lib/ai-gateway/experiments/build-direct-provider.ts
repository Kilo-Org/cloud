import {
  addCacheBreakpoints,
  injectReasoningIntoContent,
  removeCacheBreakpoints,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { CustomLlmCompression } from '@kilocode/db';
import { api_request_compress_log, type CustomLlmApiConfig } from '@kilocode/db';
import type {
  GatewayChatApiKind,
  Provider,
  TransformRequestContext,
} from '@/lib/ai-gateway/providers/types';
import { compress } from 'headroom-ai';
import type {
  GatewayMessagesRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { logExceptInTest } from '@/lib/utils.server';
import { db } from '@/lib/drizzle';

/**
 * Plain in-memory shape: a `CustomLlmApiConfig` merged with the decrypted
 * partner-issued api key.
 *
 * `pickModelExperimentVariant` decrypts the chosen
 * `model_experiment_variant_version.encrypted_api_key` and merges the
 * plaintext with the upstream blob for the outbound provider request. The
 * plaintext NEVER touches Postgres, Redis, or any tRPC response.
 */
export type ResolvedExperimentUpstream = CustomLlmApiConfig & { api_key: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPropertyPath(target: Record<string, unknown>, path: string, value: string) {
  const segments = path.split('.');
  const finalSegment = segments.at(-1);
  if (!finalSegment) {
    return;
  }

  let current = target;

  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
      continue;
    }

    const nested: Record<string, unknown> = {};
    current[segment] = nested;
    current = nested;
  }

  current[finalSegment] = value;
}

function mapThoughtSignatures(context: TransformRequestContext, path: string) {
  if (context.request.kind !== 'chat_completions') {
    return;
  }

  for (const message of context.request.body.messages) {
    if (!isRecord(message)) {
      continue;
    }

    delete message.thoughtSignature;

    if (!Array.isArray(message.tool_calls)) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      const signature = toolCall.thoughtSignature;
      delete toolCall.thoughtSignature;
      if (typeof signature === 'string') {
        setPropertyPath(toolCall, path, signature);
      }
    }
  }
}

async function compressWithHeadroom(
  context: TransformRequestContext,
  compression: CustomLlmCompression
) {
  const messages =
    context.request.kind === 'responses'
      ? context.request.body.input
      : context.request.body.messages;
  if (!Array.isArray(messages)) {
    return messages;
  }
  try {
    const result = await compress(messages, {
      baseUrl: compression.base_url,
      apiKey: compression.api_key,
      model: compression.model_alias,
      fallback: false,
    });
    const logId = await db
      .insert(api_request_compress_log)
      .values({
        kilo_user_id: context.kilo_user_id,
        organization_id: context.organization_id,
        session_id: context.session_id,
        model: context.model,
        provider: context.provider.id,
        request: context.request,
        result,
      })
      .returning({ id: api_request_compress_log.id });
    logExceptInTest('[compressWithHeadroom] Inserted into api_request_compress_log', logId[0].id);
    return result.messages;
  } catch (e) {
    logExceptInTest('[compressWithHeadroom]', e);
  }
  return messages;
}

/**
 * Builds a `Provider` that points directly at a partner-issued upstream.
 *
 * Used by both the experiment routing path and the existing
 * `kilo-internal/...` (custom_llm2) path. The caller supplies supported chat
 * APIs separately from the shared upstream API config.
 *
 * Direct traffic goes to `apiUrl` — OpenRouter and Vercel are never
 * contacted. The route layer is responsible for not applying provider
 * pinning or kilo-exclusive model rewrites on top of this provider.
 */
export function buildDirectProvider(
  id: 'custom' | 'experiment',
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>,
  upstream: ResolvedExperimentUpstream
): Provider {
  return {
    id,
    apiUrl: upstream.base_url,
    apiKey: upstream.api_key,
    supportedChatApis,
    responseTransforms: upstream.thought_content_mapping
      ? { thoughtContentMapping: upstream.thought_content_mapping }
      : undefined,
    async transformRequest(context) {
      if (upstream.remove_from_body) {
        const body = context.request.body as Record<string, unknown>;
        for (const key of upstream.remove_from_body) {
          delete body[key];
        }
      }
      Object.assign(context.request.body, upstream.extra_body ?? {});
      if (upstream.extra_headers) {
        Object.assign(context.extraHeaders, upstream.extra_headers);
      }
      context.request.body.model = upstream.internal_id;
      if (upstream.remove_cache_breakpoints) {
        removeCacheBreakpoints(context.request);
      }
      if (upstream.add_cache_breakpoints) {
        addCacheBreakpoints(context.request);
      }
      if (upstream.inject_reasoning_into_content) {
        injectReasoningIntoContent(context.request);
      }
      if (upstream.compression?.enabled) {
        const messages = await compressWithHeadroom(context, upstream.compression);
        if (context.request.kind === 'responses') {
          context.request.body.input = messages as GatewayResponsesRequest['input'];
        } else if (context.request.kind === 'messages') {
          context.request.body.messages = messages as GatewayMessagesRequest['messages'];
        } else {
          context.request.body.messages = messages as OpenRouterChatCompletionRequest['messages'];
        }
      }
      if (upstream.thought_signature_mapping) {
        mapThoughtSignatures(context, upstream.thought_signature_mapping);
      }
    },
  };
}
