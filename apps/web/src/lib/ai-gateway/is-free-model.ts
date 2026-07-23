import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { isKiloExclusiveFreeModel, kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';

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
  return (
    isKiloExclusiveFreeModel(model) ||
    model === KILO_AUTO_FREE_MODEL.id ||
    (model ?? '').endsWith(':free') ||
    model === 'openrouter/free' ||
    (await isPublicIdExperimented(model ?? '')) ||
    model === 'inclusionai/ling-3.0-flash'
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
