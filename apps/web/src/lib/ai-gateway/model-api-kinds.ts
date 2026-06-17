import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { GatewayChatApiKind } from '@/lib/ai-gateway/providers/types';

const GATEWAY_CHAT_API_KINDS: readonly GatewayChatApiKind[] = [
  'chat_completions',
  'responses',
  'messages',
];

/**
 * The gateway chat API kinds the model's serving provider can speak, derived
 * from the provider the gateway would route it to. Mirrors get-provider.ts's
 * static fallback resolution — a Kilo-exclusive model is served by its
 * declared gateway, everything else by OpenRouter.
 */
export function gatewayChatApisForModel(modelId: string): ReadonlyArray<GatewayChatApiKind> {
  const exclusive = findKiloExclusiveModel(modelId);
  const provider =
    Object.values(PROVIDERS).find(p => p.id === exclusive?.gateway) ?? PROVIDERS.OPENROUTER;
  return provider.supportedChatApis;
}

/**
 * Guards admin saves of the auto-routing benchmark config: routing-table
 * candidates carry no per-protocol metadata, so every decider model must be
 * servable on ALL gateway chat API kinds — otherwise the gateway would hard-
 * reject requests whose protocol the model's provider can't speak.
 */
export function modelServesAllGatewayChatApis(modelId: string): boolean {
  const supported = gatewayChatApisForModel(modelId);
  return GATEWAY_CHAT_API_KINDS.every(kind => supported.includes(kind));
}
