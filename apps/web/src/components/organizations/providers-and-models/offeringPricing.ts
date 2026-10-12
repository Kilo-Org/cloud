import type { OpenRouterPricing } from '@kilocode/db/schema-types';
import {
  formatPricePerToken,
  getCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { getModelDisplayPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
import type { OfferingPricing } from '@/components/organizations/providers-and-models/providersAndModels.types';

function listPriceIfDiscounted(listPrice: string, billedPrice: string): string | undefined {
  return Number.parseFloat(billedPrice) < Number.parseFloat(listPrice) ? listPrice : undefined;
}

/**
 * Prices for one provider endpoint as Kilo bills them. `modelVariantId` must be
 * the exact gateway id (e.g. `x/y:free`), matching how usage looks up custom
 * pricing by requested model.
 */
export function getOfferingPricing(
  modelVariantId: string,
  endpointPricing: OpenRouterPricing
): OfferingPricing {
  const listPricing = getModelDisplayPricing(endpointPricing) ?? endpointPricing;
  const customPricing = getCustomPricing(modelVariantId);
  if (!customPricing || customPricing.fallbackOnly) {
    return { promptPrice: listPricing.prompt, completionPrice: listPricing.completion };
  }

  const billedPricing = customPricing.pricing[0].pricing;
  const promptPrice = formatPricePerToken(billedPricing.prompt_per_million);
  const completionPrice = formatPricePerToken(billedPricing.completion_per_million);
  return {
    promptPrice,
    completionPrice,
    originalPromptPrice: listPriceIfDiscounted(listPricing.prompt, promptPrice),
    originalCompletionPrice: listPriceIfDiscounted(listPricing.completion, completionPrice),
  };
}
