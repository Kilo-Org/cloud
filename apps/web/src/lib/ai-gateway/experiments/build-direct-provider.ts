import {
  addCacheBreakpoints,
  injectReasoningIntoContent,
  removeCacheBreakpoints,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
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

async function compressWithHeadroom(context: TransformRequestContext) {
  const messages =
    context.request.kind === 'responses'
      ? context.request.body.input
      : context.request.body.messages;
  if (!Array.isArray(messages)) {
    return messages;
  }
  try {
    const result = await compress(messages, {
      model: context.request.body.model,
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
      if (upstream.enable_headroom_compression) {
        const messages = await compressWithHeadroom(context);
        if (context.request.kind === 'responses') {
          context.request.body.input = messages as GatewayResponsesRequest['input'];
        } else if (context.request.kind === 'messages') {
          context.request.body.messages = messages as GatewayMessagesRequest['messages'];
        } else {
          context.request.body.messages = messages as OpenRouterChatCompletionRequest['messages'];
        }
      }
    },
  };
}
