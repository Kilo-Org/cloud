import { captureMessage } from '@sentry/nextjs';
import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { calculateCustomCost_mUsd } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import { findKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import type {
  JustTheCostsUsageStats,
  MicrodollarUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  calculateCost_mUsd,
  type KiloExclusiveModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';

export function calculateKiloExclusiveCost_mUsd(
  model: KiloExclusiveModel,
  usage: JustTheCostsUsageStats
): number | undefined {
  const pricing = model?.pricing;
  if (!pricing) {
    return 0;
  }
  if (pricing.fallbackOnly && usage.cost_mUsd > 0) {
    return undefined;
  }
  const uncachedInputTokens = usage.inputTokens - usage.cacheHitTokens - usage.cacheWriteTokens;
  if (uncachedInputTokens < 0) {
    captureMessage('SUSPICIOUS: negative uncached input tokens', {
      level: 'error',
      tags: { source: 'usage_processing' },
      extra: { model: model.public_id, usage },
    });
  }
  return Math.round(
    calculateCost_mUsd(
      {
        uncachedInputTokens: uncachedInputTokens >= 0 ? uncachedInputTokens : usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      pricing.tiers
    )
  );
}

export function applyUsagePricing(
  usage: JustTheCostsUsageStats,
  context: Pick<MicrodollarUsageContext, 'requested_model' | 'is_free' | 'user_byok' | 'provider'>,
  customPricingConfig: CustomPricingConfig
): void {
  const kiloExclusiveModel = findKiloExclusiveModel(context.requested_model);
  if (kiloExclusiveModel?.pricing) {
    const exclusiveCost_mUsd = calculateKiloExclusiveCost_mUsd(kiloExclusiveModel, usage);
    if (exclusiveCost_mUsd !== undefined) {
      usage.market_cost = usage.cost_mUsd;
      usage.cost_mUsd = exclusiveCost_mUsd;
    }
  }

  const customCost_mUsd = calculateCustomCost_mUsd(
    customPricingConfig,
    context.requested_model,
    usage
  );

  usage.market_cost ??= usage.cost_mUsd;
  usage.cost_mUsd = customCost_mUsd ?? usage.cost_mUsd;

  if (context.is_free || context.user_byok || context.provider === OPENAI_CHATGPT_PROVIDER_ID) {
    usage.cost_mUsd = 0;
    usage.cacheDiscount_mUsd = 0;
  }
}
