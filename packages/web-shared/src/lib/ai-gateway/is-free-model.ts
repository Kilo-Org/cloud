import { KILO_AUTO_FREE_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { findCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * Whether Kilo charges nothing for the model, judged by its id alone. Custom
 * LLMs follow the same rule; the admin router rejects pricing on a custom LLM
 * whose id matches it.
 */
export function isFreeModel(model: string): boolean {
  const modelId = model ?? '';
  return (
    ((isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)) &&
      isLocalFakeLlmEnabled()) ||
    modelId === KILO_AUTO_FREE_MODEL.id ||
    modelId === 'openrouter/free' ||
    modelId.endsWith(':free') ||
    modelId.endsWith('-free') ||
    modelId.startsWith('stealth/')
  );
}

/**
 * Free models are assumed to train on prompts, and so are custom LLMs unless
 * their definition sets `may_train_on_prompts: false`.
 */
export async function hasBestEffortGuessDataCollectionRequirement(model: string): Promise<boolean> {
  const customLlm = await findCustomLlm(model);
  if (customLlm) return customLlm.definition.may_train_on_prompts !== false;
  return isFreeModel(model);
}

/**
 * Whether the provider privacy preferences rule the model out. `data_collection: 'deny'` rules out
 * models that may train on prompts. `zdr` also rules out every custom LLM, since Kilo does not
 * vouch for zero data retention on an upstream it calls directly.
 */
export async function isDeniedByProviderPrivacy(
  model: string,
  privacy: Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'> | undefined
): Promise<boolean> {
  if (privacy?.zdr === true) {
    return (
      (await findCustomLlm(model)) !== null ||
      (await hasBestEffortGuessDataCollectionRequirement(model))
    );
  }
  if (privacy?.data_collection === 'deny') {
    return await hasBestEffortGuessDataCollectionRequirement(model);
  }
  return false;
}
