import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { CustomLlmApiConfig } from '@kilocode/db';
import { type GatewayChatApiKind, type Provider } from '@/lib/ai-gateway/providers/types';
import { sanitizeJsonRefToolResults } from '@/lib/ai-gateway/providers/sanitize-json-ref-tool-results';

export type ResolvedDirectUpstream = CustomLlmApiConfig & { api_key: string };

export function buildDirectProvider(
  id: 'custom',
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>,
  upstream: ResolvedDirectUpstream,
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
