import { eq } from 'drizzle-orm';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  CustomPricingConfigSchema,
  type CustomPricingModelConfig,
} from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import type {
  ConfiguredCustomPricing,
  CustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';

function toCustomPricing(config: CustomPricingModelConfig): CustomPricing {
  return {
    pricing: [{ start_context_length: 0, pricing: config.pricing }],
    discountPercentage: config.discountPercentage,
    fallbackOnly: config.fallbackOnly,
  };
}

/** Throws on an invalid stored config, so the cached getter keeps its last valid value. */
export async function readConfiguredCustomPricing(): Promise<ConfiguredCustomPricing> {
  const [row] = await db
    .select({ custom_pricing: ai_gateway_config.custom_pricing })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.custom_pricing) return {};
  const { models } = CustomPricingConfigSchema.parse(row.custom_pricing);
  return Object.fromEntries(models.map(model => [model.model, toCustomPricing(model)]));
}

/** Cached for one minute; on a read failure, returns the last valid value (or none). */
export const getConfiguredCustomPricing = createCachedFetch<ConfiguredCustomPricing>(
  readConfiguredCustomPricing,
  60_000,
  {}
);
