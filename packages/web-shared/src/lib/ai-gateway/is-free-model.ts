import { KILO_AUTO_FREE_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  findKiloExclusiveModel,
  kiloExclusiveModels,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';

/** Whether Kilo charges nothing for the model. Custom LLMs are always free. */
export async function isFreeModel(modelId: string): Promise<boolean> {
  return (await isCustomLlm(modelId)) || isFreeModelExcludingCustomLlms(modelId);
}

/**
 * The built-in free model rules, without custom LLMs. Use `isFreeModel` unless
 * custom LLMs must be excluded outright, as for `kilo-auto/free` candidates.
 */
export function isFreeModelExcludingCustomLlms(model: string): boolean {
  const modelId = model ?? '';
  const exclusiveModel = findKiloExclusiveModel(modelId);
  if (exclusiveModel) {
    return !exclusiveModel.pricing;
  }
  return (
    ((isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)) &&
      isLocalFakeLlmEnabled()) ||
    modelId === KILO_AUTO_FREE_MODEL.id ||
    modelId.endsWith(':free') ||
    modelId === 'openrouter/free' ||
    (modelId.startsWith('stealth/') && modelId.endsWith('-alpha'))
  );
}

export function hasBestEffortGuessDataCollectionRequirement(model: string): boolean {
  return (
    isFreeModelExcludingCustomLlms(model) ||
    kiloExclusiveModels.some(
      candidate =>
        candidate.public_id === model && candidate.flags.includes('requires-data-collection')
    )
  );
}
