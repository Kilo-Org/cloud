import { ai_gateway_config } from '@kilocode/db/schema';
import { CustomPricingConfigSchema, type CustomPricingConfig } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { EMPTY_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import {
  getOpenRouterAliasTarget,
  type GatewayModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

/**
 * Returns the stored custom pricing, or no custom pricing when none is stored.
 * Throws on an invalid stored config, so the cached getter keeps its last valid
 * value.
 */
export async function readCustomPricingConfig(): Promise<CustomPricingConfig> {
  const [row] = await readDb
    .select({ config: ai_gateway_config.custom_pricing })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.config) return EMPTY_CUSTOM_PRICING_CONFIG;
  return CustomPricingConfigSchema.parse(row.config);
}

/**
 * Prices every resolvable `~` latest alias as the model it resolves to, so a lookup by requested
 * model id finds the target's custom pricing. Entries naming an alias never apply; the admin write
 * path rejects them. An alias that does not resolve gets no custom pricing.
 */
export function resolveCustomPricingAliases(
  config: CustomPricingConfig,
  models: GatewayModelMap
): CustomPricingConfig {
  const entries = config.models.filter(entry => !entry.model.startsWith('~'));
  const entriesByModel = new Map(entries.map(entry => [entry.model, entry]));
  const aliasEntries = Object.keys(models).flatMap(modelId => {
    const target = getOpenRouterAliasTarget(models, modelId);
    const targetEntry = target === undefined ? undefined : entriesByModel.get(target);
    return targetEntry ? [{ ...targetEntry, model: modelId }] : [];
  });
  return { models: [...entries, ...aliasEntries] };
}

/** The stored custom pricing with {@link resolveCustomPricingAliases} applied. */
export const getCustomPricingConfig = createCachedFetch(
  async () => {
    const [config, models] = await Promise.all([
      readCustomPricingConfig(),
      getOpenRouterModelsMetadataFromDatabase(),
    ]);
    return resolveCustomPricingAliases(config, models);
  },
  60_000,
  EMPTY_CUSTOM_PRICING_CONFIG,
  { name: 'customPricingConfig' }
);
