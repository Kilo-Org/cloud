import { createAiGatewayConfigSelector } from '@kilocode/web-shared/lib/ai-gateway/ai-gateway-config-snapshot';
import {
  DEFAULT_VERCEL_ROUTING_ENABLED,
  GatewayRoutingConfigSchema,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';

export type RuntimeGatewayRoutingConfig = {
  vercelEnabled: boolean;
  vercelOptOutModels: ReadonlySet<string>;
};

const DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG: RuntimeGatewayRoutingConfig = {
  vercelEnabled: DEFAULT_VERCEL_ROUTING_ENABLED,
  vercelOptOutModels: new Set(),
};

export const getRuntimeGatewayRoutingConfig =
  createAiGatewayConfigSelector<RuntimeGatewayRoutingConfig>(snapshot => {
    const config = GatewayRoutingConfigSchema.parse(snapshot.config);
    return {
      vercelEnabled: config.vercel_routing_enabled,
      vercelOptOutModels: new Set(config.vercel_routing_opt_out_models),
    };
  }, DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG);
