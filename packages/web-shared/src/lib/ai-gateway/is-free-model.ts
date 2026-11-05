import { KILO_AUTO_FREE_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { findCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';

/**
 * Whether Kilo charges nothing for the model, judged by its id alone. Custom
 * LLMs follow the same rule; the admin router rejects pricing on a custom LLM
 * whose id matches it. `localFakeEnabled` overrides the FAKE_LLM_URL reader so a
 * caller that composes the environment can classify without reading it again.
 */
export function isFreeModel(model: string, localFakeEnabled?: boolean): boolean {
  const modelId = model ?? '';
  return (
    ((isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)) &&
      (localFakeEnabled ?? isLocalFakeLlmEnabled())) ||
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
export async function hasBestEffortGuessDataCollectionRequirement(
  model: string,
  localFakeEnabled?: boolean
): Promise<boolean> {
  const customLlm = await findCustomLlm(model);
  if (customLlm) return customLlm.definition.may_train_on_prompts !== false;
  return isFreeModel(model, localFakeEnabled);
}
