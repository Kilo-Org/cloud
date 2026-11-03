import { KILO_AUTO_FREE_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import {
  findCustomLlm,
  isCustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';

/** Whether Kilo charges nothing for the model. Custom LLMs are free unless they set pricing. */
export async function isFreeModel(model: string): Promise<boolean> {
  const modelId = model ?? '';
  const customLlm = await findCustomLlm(modelId);
  if (customLlm) return !customLlm.definition.pricing;
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

/** Free models and custom LLMs, priced or not, are assumed to train on prompts. */
export async function hasBestEffortGuessDataCollectionRequirement(model: string): Promise<boolean> {
  return (await isCustomLlm(model)) || (await isFreeModel(model));
}
