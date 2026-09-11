import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { isKiloExclusiveFreeModel, kiloExclusiveModels } from '@/lib/ai-gateway/models';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@/lib/ai-gateway/local-fake-llm';

export async function isFreeModel(model: string): Promise<boolean> {
  return (
    ((isLocalFakeDeterministicModel(model) || isLocalFakeTranscriptionModel(model)) &&
      isLocalFakeLlmEnabled()) ||
    isKiloExclusiveFreeModel(model) ||
    model === KILO_AUTO_FREE_MODEL.id ||
    (model ?? '').endsWith(':free') ||
    model === 'openrouter/free' ||
    model === 'stealth/ox-alpha'
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
