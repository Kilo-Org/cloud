import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { isKiloExclusiveFreeModel, isOpenRouterStealthModel } from '@/lib/ai-gateway/models';

/**
 * Returns true when `model` is intrinsically free. Request-specific funding,
 * such as a selected provider-funded experiment variant, is recorded on the
 * usage context after routing and must not be inferred from mutable model
 * membership.
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
