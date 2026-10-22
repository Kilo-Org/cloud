import { addCacheBreakpoints } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import type {
  CustomLlmApiConfig,
  CustomLlmAwsBedrockCredentials,
  CustomLlmSecureProxyCredentials,
} from '@kilocode/db';
import {
  type GatewayChatApiKind,
  type Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { sanitizeJsonRefToolResults } from '@kilocode/web-shared/lib/ai-gateway/providers/sanitize-json-ref-tool-results';

export type DirectUpstreamAuth =
  | { type: 'api_key'; apiKey: string; apiKeyHeader: 'x-api-key' | null }
  | { type: 'secure_proxy'; credentials: CustomLlmSecureProxyCredentials }
  | { type: 'aws_bedrock'; credentials: CustomLlmAwsBedrockCredentials };

function resolveRouting(
  upstream: CustomLlmApiConfig,
  auth: DirectUpstreamAuth
): Pick<Provider, 'apiUrl' | 'apiKey' | 'apiKeyHeader' | 'secureProxy' | 'awsBedrock'> {
  switch (auth.type) {
    case 'api_key':
      return { apiUrl: upstream.base_url, apiKey: auth.apiKey, apiKeyHeader: auth.apiKeyHeader };
    case 'aws_bedrock':
      return {
        apiUrl: upstream.base_url,
        apiKey: '',
        apiKeyHeader: null,
        awsBedrock: auth.credentials,
      };
    case 'secure_proxy':
      return {
        apiUrl: auth.credentials.config.url,
        apiKey: auth.credentials.proxy_secret,
        apiKeyHeader: null,
        secureProxy: {
          url: upstream.base_url,
          upstreamAuthHeaders: auth.credentials.config.extra_headers ?? {},
        },
      };
  }
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
