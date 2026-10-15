import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { GatewayRoutingConfigSchema } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export type RuntimeGatewayRoutingConfig = {
  vercelOptOutModels: ReadonlySet<string>;
};

const DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG: RuntimeGatewayRoutingConfig = {
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
    return { vercelOptOutModels: new Set(config.vercel_routing_opt_out_models) };
  },
  60_000,
  DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG
);
