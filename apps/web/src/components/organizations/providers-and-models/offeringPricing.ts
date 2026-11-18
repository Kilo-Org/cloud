import type { OpenRouterPricing } from '@kilocode/db/schema-types';
import { getModelDisplayPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
import type { OfferingPricing } from '@/components/organizations/providers-and-models/providersAndModels.types';

/**
 * Prices for one provider endpoint: its default list price, with OpenRouter
 * discounts undone. Custom pricing never applies to a single provider's price.
 */
export function getOfferingPricing(endpointPricing: OpenRouterPricing): OfferingPricing {
  const listPricing = getModelDisplayPricing(endpointPricing) ?? endpointPricing;
  return { promptPrice: listPricing.prompt, completionPrice: listPricing.completion };
}
