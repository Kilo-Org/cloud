import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { CustomLlmApiConfig } from '@kilocode/db';
import { type GatewayChatApiKind, type Provider } from '@/lib/ai-gateway/providers/types';
import { sanitizeJsonRefToolResults } from '@/lib/ai-gateway/providers/sanitize-json-ref-tool-results';

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
  upstream: ResolvedExperimentUpstream,
  apiKeyHeader: 'x-api-key' | null
): Provider {
  return {
    id,
    apiUrl: upstream.base_url,
    apiUrlOverrides: {},
    apiKey: upstream.api_key,
    apiKeyHeader,
    supportedChatApis,
    responseTransforms: upstream.reasoning_details_transform ?? null,
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
      if (upstream.add_cache_breakpoints) {
        addCacheBreakpoints(context.request);
      }
      if (upstream.sanitize_ref_fields) {
        sanitizeJsonRefToolResults(context.request);
      }
    },
  };
}
