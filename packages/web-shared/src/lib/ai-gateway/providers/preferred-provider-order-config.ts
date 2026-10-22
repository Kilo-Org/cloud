import { ai_gateway_config } from '@kilocode/db/schema';
import {
  PreferredProviderOrderConfigSchema,
  type PreferredProviderOrderConfig,
} from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';

/** Throws on an invalid stored config, so the cached getter keeps its last valid value. */
export async function readPreferredProviderOrderConfig(): Promise<PreferredProviderOrderConfig> {
  const [row] = await readDb
    .select({ config: ai_gateway_config.preferred_provider_order })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.config) return EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG;
  return PreferredProviderOrderConfigSchema.parse(row.config);
}

export const getPreferredProviderOrderConfig = createCachedFetch(
  readPreferredProviderOrderConfig,
  60_000,
  EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG
);
