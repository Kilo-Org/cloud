import { getCustomLlmClientApiKind, type CustomLlmDefinition } from '@kilocode/db/schema-types';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

/** The gateway APIs a custom LLM accepts requests on. */
export function getCustomLlmApiKinds(
  definition: Pick<CustomLlmDefinition, 'api_kinds' | 'opencode_settings'>
): ReadonlyArray<GatewayChatApiKind> {
  return (
    definition.api_kinds ?? [
      getCustomLlmClientApiKind(definition.opencode_settings?.ai_sdk_provider),
    ]
  );
}
