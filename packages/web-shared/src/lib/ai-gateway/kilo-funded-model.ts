import { isAutoSmallFreeModel } from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';

/**
 * Whether Kilo pays for the model and must therefore serve it itself: a free model, or the
 * Kilo-funded auto-small fallback. A user's BYOK key never takes over a model Kilo funds. Each
 * surface adds its own conditions on top of this rule (catalog currency, the inference route
 * plan), so a surface that skips a term here states why in its own doc.
 */
export function isKiloFundedModel(modelId: string): boolean {
  return isFreeModel(modelId) || isAutoSmallFreeModel(modelId);
}