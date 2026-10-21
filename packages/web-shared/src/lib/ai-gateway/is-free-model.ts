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
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

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

/** Uses only public models; null means the public catalog is unavailable. */
export async function isAnonymousFreeModel(modelId: string): Promise<boolean | null> {
  if (!isFreeModelExcludingCustomLlms(modelId)) return false;
  if (
    findKiloExclusiveModel(modelId) ||
    modelId === KILO_AUTO_FREE_MODEL.id ||
    modelId === 'openrouter/free' ||
    (isLocalFakeLlmEnabled() &&
      (isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)))
  ) {
    return true;
  }
  const models = await getOpenRouterModelsMetadataFromDatabase();
  if (Object.keys(models).length === 0) return null;
  return Object.hasOwn(models, modelId);
}

/** Free models, custom LLMs included, are assumed to train on prompts. */
export async function hasBestEffortGuessDataCollectionRequirement(model: string): Promise<boolean> {
  return (
    (await isFreeModel(model)) ||
    kiloExclusiveModels.some(
      candidate =>
        candidate.public_id === model && candidate.flags.includes('requires-data-collection')
    )
  );
}
