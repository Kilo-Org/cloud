import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';

export const GATEWAY_MODEL_LISTS = ['preferred_models', 'unavailable_models'] as const;

export type GatewayModelList = (typeof GATEWAY_MODEL_LISTS)[number];

export const GATEWAY_MODEL_LIST_CACHE_TTL_MS = 60_000;

/** Throws when the stored list is invalid, so cached readers keep their last valid value. */
export async function readGatewayModelList(list: GatewayModelList): Promise<string[]> {
  const [row] = await db
    .select({ config: ai_gateway_config[list] })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.config) return [];
  return GatewayModelListConfigSchema.parse(row.config).models;
}
