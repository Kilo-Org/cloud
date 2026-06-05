import {
  addCacheBreakpoints,
  injectReasoningIntoContent,
  removeCacheBreakpoints,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { CustomLlmProvider } from '@kilocode/db';
import type { GatewayChatApiKind, Provider } from '@/lib/ai-gateway/providers/types';
import type { ExperimentUpstream } from '@/lib/ai-gateway/experiments/upstream-schema';

/**
 * Maps adapter settings to the supported chat APIs for the resulting Provider.
 * Mirrors the same inference performed for `custom_llm2` rows in
 * `apps/web/src/lib/ai-gateway/providers/get-provider.ts`.
 */
export function inferSupportedChatApis(
  aiSdkProvider: CustomLlmProvider | undefined
): ReadonlyArray<GatewayChatApiKind> {
  if (aiSdkProvider === 'openai') {
    return ['responses'];
  }
  if (aiSdkProvider === 'anthropic') {
    return ['messages'];
  }
  if (
    aiSdkProvider === 'openai-compatible' ||
    aiSdkProvider === 'alibaba' ||
    aiSdkProvider === 'openrouter' ||
    aiSdkProvider === undefined
  ) {
    return ['chat_completions'];
  }
  return [];
}

/**
 * Plain in-memory shape: an `ExperimentUpstream` (no key) merged with the
 * decrypted partner-issued api key.
 *
 * `pickModelExperimentVariant` decrypts the chosen
 * `model_experiment_variant_version.encrypted_api_key` and merges the
 * plaintext with the upstream blob for the outbound provider request. The
 * plaintext NEVER touches Postgres, Redis, or any tRPC response.
 */
export type ResolvedExperimentUpstream = ExperimentUpstream & { api_key: string };

/**
 * Input to `buildDirectProvider`. A superset of `ResolvedExperimentUpstream`
 * that also accepts `extra_headers`, which is used by the custom_llm2
 * (`kilo-internal/...`) code path but not by experiments. Experiment
 * upstreams must NOT pass `extra_headers` — see
 * `ExperimentUpstreamSchema`.
 */
export type DirectProviderInput = ResolvedExperimentUpstream & {
  extra_headers?: Record<string, string>;
};

/**
 * Builds a `Provider` that points directly at a partner-issued upstream.
 *
 * Used by both the experiment routing path and the existing
 * `kilo-internal/...` (custom_llm2) path: `id: 'custom'`, `apiUrl` =
 * upstream `base_url`, `apiKey` = upstream-issued key, supported chat APIs
 * inferred from adapter settings.
 *
 * Direct traffic goes to `apiUrl` — OpenRouter and Vercel are never
 * contacted. The route layer is responsible for not applying provider
 * pinning or kilo-exclusive model rewrites on top of this provider.
 */
export function buildDirectProvider(
  id: 'custom' | 'experiment',
  upstream: DirectProviderInput
): Provider {
  return {
    id,
    apiUrl: upstream.base_url,
    apiKey: upstream.api_key,
    supportedChatApis: inferSupportedChatApis(upstream.opencode_settings?.ai_sdk_provider),
    transformRequest(context) {
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
    },
  };
}
