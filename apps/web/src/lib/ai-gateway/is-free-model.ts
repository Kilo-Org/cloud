import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import {
  isKiloExclusiveFreeModel,
  kiloExclusiveModels,
} from '@/lib/ai-gateway/kilo-exclusive-models';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@/lib/ai-gateway/local-fake-llm';

export async function isFreeModel(model: string): Promise<boolean> {
  const modelId = model ?? '';
  return (
    ((isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)) &&
      isLocalFakeLlmEnabled()) ||
    isKiloExclusiveFreeModel(modelId) ||
    modelId === KILO_AUTO_FREE_MODEL.id ||
    modelId.endsWith(':free') ||
    modelId === 'openrouter/free' ||
    (modelId.startsWith('stealth/') && modelId.endsWith('-alpha'))
  );
}

export async function hasBestEffortGuessDataCollectionRequirement(model: string): Promise<boolean> {
  return (
    (await isFreeModel(model)) ||
    kiloExclusiveModels.some(
      candidate =>
        candidate.public_id === model &&
        candidate.status !== 'disabled' &&
        candidate.flags.includes('requires-data-collection')
    )
  );
}
