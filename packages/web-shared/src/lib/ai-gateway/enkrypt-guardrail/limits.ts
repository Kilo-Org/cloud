import { ai_gateway_config } from '@kilocode/db/schema';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import {
  DEFAULT_ENKRYPT_LIMITS,
  GatewayEnkryptLimitsConfigSchema,
  type EnkryptLimits,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  selectGatewayConfigRow,
  type GatewayConfigRowDb,
} from '@kilocode/web-shared/lib/ai-gateway/select-gateway-config-row';

export async function readEnkryptLimits(fromDb: GatewayConfigRowDb): Promise<EnkryptLimits> {
  const config = await selectGatewayConfigRow(fromDb, ai_gateway_config.config);
  if (config === undefined) return DEFAULT_ENKRYPT_LIMITS;
  return GatewayEnkryptLimitsConfigSchema.parse(config).enkrypt;
}

/** The Enkrypt limits for the gateway hot path, read from the local replica and cached for one minute. */
export const getRuntimeEnkryptLimits = createCachedFetch<EnkryptLimits>(
  () => readEnkryptLimits(readDb),
  60_000,
  DEFAULT_ENKRYPT_LIMITS,
  { name: 'runtimeEnkryptLimits' }
);
