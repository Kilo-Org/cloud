import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { GatewayRoutingConfigSchema } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readGatewayConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/ai-gateway-config-row';

export type RuntimeGatewayRoutingConfig = {
  vercelOptOutModels: ReadonlySet<string>;
};

const DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG: RuntimeGatewayRoutingConfig = {
  vercelOptOutModels: new Set(),
};

export const getRuntimeGatewayRoutingConfig = createCachedFetch<RuntimeGatewayRoutingConfig>(
  async () => {
    const stored = await readGatewayConfig();
    if (!stored) return DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG;

    const config = GatewayRoutingConfigSchema.parse(stored);
    return {
      vercelOptOutModels: new Set(config.vercel_routing_opt_out_models),
    };
  },
  60_000,
  DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG,
  { name: 'runtimeGatewayRoutingConfig' }
);
