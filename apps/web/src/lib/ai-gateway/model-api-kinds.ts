import { ClassifierApiKindSchema, type ClassifierApiKind } from '@kilocode/auto-routing-contracts';
import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';

/**
 * Which gateway API kinds a model can serve, derived from the provider the
 * gateway would route it to. Mirrors get-provider.ts's static fallback
 * resolution — a Kilo-exclusive model is served by its declared gateway,
 * everything else by OpenRouter. The dynamic paths (BYOK, custom LLMs,
 * experiments, Vercel re-routing) never apply to auto-routing benchmark
 * candidates, which is the only consumer.
 */
export function supportedApiKindsForModel(modelId: string): ClassifierApiKind[] {
  const exclusive = findKiloExclusiveModel(modelId);
  const provider =
    Object.values(PROVIDERS).find(p => p.id === exclusive?.gateway) ?? PROVIDERS.OPENROUTER;
  const kinds = provider.supportedChatApis.filter((kind): kind is ClassifierApiKind =>
    (ClassifierApiKindSchema.options as readonly string[]).includes(kind)
  );
  // A provider with no chat APIs (e.g. Mistral) can't serve gateway chat
  // traffic at all; such models are not meaningful decider candidates, but
  // the contract requires a non-empty list.
  return kinds.length > 0 ? kinds : ['chat_completions'];
}
