import { KILO_AUTO_FREE_MODEL } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';

export function isFreeModel(model: string): boolean {
  const modelId = model ?? '';
  const exclusiveModel = kiloExclusiveModels.find(m => m.public_id === modelId);
  if (exclusiveModel?.pricing) {
    return false;
  }
  if (exclusiveModel && exclusiveModel.status !== 'disabled') {
    return true;
  }
  return (
    ((isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)) &&
      isLocalFakeLlmEnabled()) ||
    modelId === KILO_AUTO_FREE_MODEL.id ||
    modelId.endsWith(':free') ||
    modelId === 'openrouter/free' ||
    modelId === 'inclusionai/ling-3.1-flash' ||
    (modelId.startsWith('stealth/') && modelId.endsWith('-alpha'))
  );
}

export function hasBestEffortGuessDataCollectionRequirement(model: string): boolean {
  return (
    isFreeModel(model) ||
    kiloExclusiveModels.some(
      candidate =>
        candidate.public_id === model &&
        candidate.status !== 'disabled' &&
        candidate.flags.includes('requires-data-collection')
    )
  );
}
