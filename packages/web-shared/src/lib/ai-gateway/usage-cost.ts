import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { calculateCustomCost_mUsd } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export function applyUsagePricing(
  usage: JustTheCostsUsageStats,
  context: Pick<MicrodollarUsageContext, 'requested_model' | 'is_free' | 'user_byok' | 'provider'>,
  customPricingConfig: CustomPricingConfig
): void {
  // Custom pricing replaces the inference cost; non-inference costs stay charged on top.
  const nonInferenceCost_mUsd = usage.nonInferenceCost_mUsd ?? 0;
  const inferenceUsage = { ...usage, cost_mUsd: usage.cost_mUsd - nonInferenceCost_mUsd };

  const customCost_mUsd = calculateCustomCost_mUsd(
    customPricingConfig,
    context.requested_model,
    inferenceUsage
  );

  usage.market_cost ??= usage.cost_mUsd;
  if (customCost_mUsd !== undefined) {
    usage.cost_mUsd = customCost_mUsd + nonInferenceCost_mUsd;
  }

  if (context.is_free || context.user_byok || context.provider === OPENAI_CHATGPT_PROVIDER_ID) {
    usage.cost_mUsd = 0;
    usage.cacheDiscount_mUsd = 0;
  }
}
