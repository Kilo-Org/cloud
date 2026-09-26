import { createCachedFetch } from '@/lib/cached-fetch';
import {
  DEFAULT_VERCEL_PERCENTAGE,
  DEFAULT_VERCEL_PERCENTAGE_FREE,
  GatewayRoutingConfigSchema,
} from '@/lib/ai-gateway/gateway-config';
import { db } from '@/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export type RuntimeGatewayRoutingConfig = {
  vercelPaid: number;
  vercelFree: number;
  vercelOptOutModels: ReadonlySet<string>;
};

const DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG: RuntimeGatewayRoutingConfig = {
  vercelPaid: DEFAULT_VERCEL_PERCENTAGE,
  vercelFree: DEFAULT_VERCEL_PERCENTAGE_FREE,
  vercelOptOutModels: new Set(),
};

export const getRuntimeGatewayRoutingConfig = createCachedFetch<RuntimeGatewayRoutingConfig>(
  async () => {
    const [row] = await db
      .select({ config: ai_gateway_config.config })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    if (!row) return DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG;

    const config = GatewayRoutingConfigSchema.parse(row.config);
    return {
      vercelPaid: config.vercel_routing_percentage ?? DEFAULT_VERCEL_PERCENTAGE,
      vercelFree: config.vercel_routing_percentage_free ?? DEFAULT_VERCEL_PERCENTAGE_FREE,
      vercelOptOutModels: new Set(config.vercel_routing_opt_out_models),
    };
  },
  60_000,
  DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG
);
