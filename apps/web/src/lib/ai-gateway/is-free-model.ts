import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { isKiloExclusiveFreeModel, isOpenRouterStealthModel } from '@/lib/ai-gateway/models';

/**
 * Returns true if `model` should be treated as free for the requesting user
 * this request.
 *
 * Server-only: future implementations will consult external state (e.g. a
 * Redis-backed membership set for partner-funded preview model ids) to
 * answer for models that are conditionally free. Lives outside `models.ts`
 * so client bundles importing the model-id constants
 * (`PRIMARY_DEFAULT_MODEL`, `preferredModels`, …) from `models.ts` don't
 * transitively pull in those server-only dependencies.
 */
export async function isFreeModel(model: string): Promise<boolean> {
  return (
    isKiloExclusiveFreeModel(model) ||
    model === KILO_AUTO_FREE_MODEL.id ||
    (model ?? '').endsWith(':free') ||
    model === 'openrouter/free' ||
    isOpenRouterStealthModel(model ?? '')
  );
}
