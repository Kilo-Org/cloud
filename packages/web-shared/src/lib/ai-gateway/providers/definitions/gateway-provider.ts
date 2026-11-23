import type {
  Provider,
  ProviderType,
  TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { GatewayChatApiKindSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export function defineGatewayProvider<
  const Type extends ProviderType,
  const ApiUrl extends string,
>(definition: {
  type: Type;
  apiUrl: ApiUrl;
  apiKey: string;
  /**
   * Runs on every request this provider serves, before it reaches the upstream. Omitting it leaves
   * requests unchanged.
   */
  transformRequest?: (context: TransformRequestContext) => void | Promise<void>;
}) {
  const requestTransform = definition.transformRequest;
  const provider = {
    type: definition.type,
    apiUrl: definition.apiUrl,
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    apiKey: definition.apiKey,
    apiKeyHeader: null,
    supportedChatApis: GatewayChatApiKindSchema.options,
    responseTransforms: null,
    async transformRequest(context: TransformRequestContext) {
      await requestTransform?.(context);
    },
  } as const;
  // Checking the computed value keeps `type` at its literal type. A `satisfies` clause on the
  // object literal itself widens it to `ProviderType`.
  return provider satisfies Provider;
}

/**
 * Serves a base gateway definition with a caller-supplied key. The base is left untouched; the
 * result is a copy that keeps every routing field of the base.
 */
export function withApiKey(base: Provider, apiKey: string): Provider {
  return { ...base, apiKey };
}
