import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import {
  DEFAULT_VERCEL_ROUTING_ENABLED,
  GatewayRoutingConfigSchema,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export type RuntimeGatewayRoutingConfig = {
  vercelEnabled: boolean;
  vercelOptOutModels: ReadonlySet<string>;
};

const DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG: RuntimeGatewayRoutingConfig = {
  vercelEnabled: DEFAULT_VERCEL_ROUTING_ENABLED,
  vercelOptOutModels: new Set(),
};

export const getRuntimeGatewayRoutingConfig = createCachedFetch<RuntimeGatewayRoutingConfig>(
  async () => {
    const [row] = await readDb
      .select({ config: ai_gateway_config.config })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    if (!row) return DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG;

    const config = GatewayRoutingConfigSchema.parse(row.config);
    return {
      vercelEnabled: config.vercel_routing_enabled,
      vercelOptOutModels: new Set(config.vercel_routing_opt_out_models),
    };
  },
  60_000,
  DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG
);
