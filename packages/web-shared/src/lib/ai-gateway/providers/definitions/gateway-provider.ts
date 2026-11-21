import type {
  Provider,
  ProviderType,
  TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { GatewayChatApiKindSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/thinking-block-binding';

export function defineGatewayProvider<
  const Type extends ProviderType,
  const ApiUrl extends string,
>(definition: { type: Type; apiUrl: ApiUrl; apiKey: string }) {
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
      dropThinkingBlocksOnPrefixMismatch(context);
    },
  } as const;
  // Checking the computed value keeps `type` at its literal type. A `satisfies` clause on the
  // object literal itself widens it to `ProviderType`.
  return provider satisfies Provider;
}
