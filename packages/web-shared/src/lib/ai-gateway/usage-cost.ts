import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import {
  calculateCustomCost_mUsd,
  calculateTieredCost_mUsd,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import { isDelegatedBillingProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/provider-type-predicates';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export function applyUsagePricing(
  usage: JustTheCostsUsageStats,
  context: Pick<
    MicrodollarUsageContext,
    'requested_model' | 'is_free' | 'user_byok' | 'provider' | 'custom_llm_pricing'
  >,
  customPricingConfig: CustomPricingConfig
): void {
  // Custom pricing replaces the inference cost; non-inference costs stay charged on top.
  const nonInferenceCost_mUsd = usage.nonInferenceCost_mUsd ?? 0;
  const inferenceUsage = { ...usage, cost_mUsd: usage.cost_mUsd - nonInferenceCost_mUsd };

  const customCost_mUsd = context.custom_llm_pricing
    ? calculateTieredCost_mUsd(context.custom_llm_pricing, context.requested_model, inferenceUsage)
    : calculateCustomCost_mUsd(customPricingConfig, context.requested_model, inferenceUsage);

  usage.market_cost ??= usage.cost_mUsd;
  if (customCost_mUsd !== undefined) {
    usage.cost_mUsd = customCost_mUsd + nonInferenceCost_mUsd;
  }

  if (context.is_free || context.user_byok || isDelegatedBillingProvider(context.provider)) {
    usage.cost_mUsd = 0;
    usage.cacheDiscount_mUsd = 0;
  }
}
