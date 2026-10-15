import { addCacheBreakpoints } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import type { CustomLlmApiConfig, CustomLlmSecureProxyCredentials } from '@kilocode/db';
import {
  type GatewayChatApiKind,
  type Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { sanitizeJsonRefToolResults } from '@kilocode/web-shared/lib/ai-gateway/providers/sanitize-json-ref-tool-results';

export type DirectUpstreamAuth =
  | { type: 'api_key'; apiKey: string; apiKeyHeader: 'x-api-key' | null }
  | { type: 'secure_proxy'; credentials: CustomLlmSecureProxyCredentials };

function resolveRouting(
  upstream: CustomLlmApiConfig,
  auth: DirectUpstreamAuth
): Pick<Provider, 'apiUrl' | 'apiKey' | 'apiKeyHeader' | 'secureProxy'> {
  if (auth.type === 'api_key') {
    return { apiUrl: upstream.base_url, apiKey: auth.apiKey, apiKeyHeader: auth.apiKeyHeader };
  }
  return {
    apiUrl: auth.credentials.config.url,
    apiKey: '',
    apiKeyHeader: null,
    secureProxy: {
      url: upstream.base_url,
      secret: auth.credentials.proxy_secret,
      upstreamAuthHeaders: auth.credentials.config.extra_headers ?? {},
    },
  };
}

export function buildDirectProvider(
  id: 'custom',
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>,
  upstream: CustomLlmApiConfig,
  auth: DirectUpstreamAuth
): Provider {
  return {
    id,
    ...resolveRouting(upstream, auth),
    apiUrlOverrides: {},
    disableUrlSuffix: upstream.disable_url_suffix ?? false,
    supportedChatApis,
    responseTransforms: upstream.reasoning_details_transform ?? null,
    async transformRequest(context) {
      const body = context.request.body as Record<string, unknown>;
      if (upstream.remove_from_body) {
        for (const key of upstream.remove_from_body) {
          delete body[key];
        }
      }
      Object.assign(body, upstream.extra_body ?? {});
      if (upstream.extra_headers) {
        Object.assign(context.extraHeaders, upstream.extra_headers);
      }
      if (upstream.internal_id === undefined) {
        delete body.model;
      } else {
        body.model = upstream.internal_id;
      }
      if (upstream.add_cache_breakpoints) {
        addCacheBreakpoints(context.request);
      }
      if (upstream.sanitize_ref_fields) {
        sanitizeJsonRefToolResults(context.request);
      }
    },
  };
}
