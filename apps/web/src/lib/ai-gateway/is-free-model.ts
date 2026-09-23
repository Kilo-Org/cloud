import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import {
  isKiloExclusiveFreeModel,
  kiloExclusiveModels,
} from '@/lib/ai-gateway/kilo-exclusive-models';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';
import {
  isLocalFakeDeterministicModel,
  isLocalFakeLlmEnabled,
  isLocalFakeTranscriptionModel,
} from '@/lib/ai-gateway/local-fake-llm';

/**
 * Returns true if `model` should be treated as free for the requesting user
 * this request — including dedicated experimented public ids, which are
 * partner/Kilo-funded for v1.
 *
 * Server-only: consults a Redis-backed membership set for experiment routing.
 * Lives outside `models.ts` so client bundles importing the model-id
 * constants (`PRIMARY_DEFAULT_MODEL`, `preferredModels`, …) from `models.ts`
 * don't transitively pull in the Redis client.
 */
export async function isFreeModel(model: string): Promise<boolean> {
  const modelId = model ?? '';
  return (
    ((isLocalFakeDeterministicModel(modelId) || isLocalFakeTranscriptionModel(modelId)) &&
      isLocalFakeLlmEnabled()) ||
    isKiloExclusiveFreeModel(modelId) ||
    modelId === KILO_AUTO_FREE_MODEL.id ||
    modelId.endsWith(':free') ||
    modelId === 'openrouter/free' ||
    (modelId.startsWith('stealth/') && modelId.endsWith('-alpha')) ||
    (await isPublicIdExperimented(modelId))
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
