import { ai_gateway_config } from '@kilocode/db/schema';
import { CustomPricingConfigSchema, type CustomPricingConfig } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { CUSTOM_PRICING_FALLBACK_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';

/**
 * Returns the stored custom pricing, or the in-code fallback when none is
 * stored. Throws on an invalid stored config, so the cached getter keeps its
 * last valid value.
 */
export async function readCustomPricingConfig(): Promise<CustomPricingConfig> {
  const [row] = await readDb
    .select({ config: ai_gateway_config.custom_pricing })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.config) return CUSTOM_PRICING_FALLBACK_CONFIG;
  return CustomPricingConfigSchema.parse(row.config);
}

export const getCustomPricingConfig = createCachedFetch(
  readCustomPricingConfig,
  60_000,
  CUSTOM_PRICING_FALLBACK_CONFIG
);
