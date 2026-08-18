import { createCachedFetch } from '@/lib/cached-fetch';
import {
  DEFAULT_FRIENDLI_PERCENTAGE,
  DEFAULT_PERPLEXITY_PERCENTAGE,
  DEFAULT_VERCEL_PERCENTAGE,
  DEFAULT_VERCEL_PERCENTAGE_FREE,
  GatewayRoutingConfigSchema,
} from '@/lib/ai-gateway/gateway-config';
import { redisClient } from '@/lib/redis';
import { VERCEL_ROUTING_REDIS_KEY } from '@/lib/redis-keys';

export type RuntimeGatewayRoutingConfig = {
  vercelPaid: number;
  vercelFree: number;
  vercelOptOutModels: ReadonlySet<string>;
  friendli: number;
  perplexity: number;
};

const DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG: RuntimeGatewayRoutingConfig = {
  vercelPaid: DEFAULT_VERCEL_PERCENTAGE,
  vercelFree: DEFAULT_VERCEL_PERCENTAGE_FREE,
  vercelOptOutModels: new Set(),
  friendli: DEFAULT_FRIENDLI_PERCENTAGE,
  perplexity: DEFAULT_PERPLEXITY_PERCENTAGE,
};

export const getRuntimeGatewayRoutingConfig = createCachedFetch<RuntimeGatewayRoutingConfig>(
  async () => {
    const raw = await redisClient.get<string>(VERCEL_ROUTING_REDIS_KEY);
    if (!raw) return DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG;

    const config = GatewayRoutingConfigSchema.parse(JSON.parse(raw));
    return {
      vercelPaid: config.vercel_routing_percentage ?? DEFAULT_VERCEL_PERCENTAGE,
      vercelFree: config.vercel_routing_percentage_free ?? DEFAULT_VERCEL_PERCENTAGE_FREE,
      vercelOptOutModels: new Set(config.vercel_routing_opt_out_models),
      friendli: config.friendli_routing_percentage ?? DEFAULT_FRIENDLI_PERCENTAGE,
      perplexity: config.perplexity_routing_percentage ?? DEFAULT_PERPLEXITY_PERCENTAGE,
    };
  },
  60_000,
  DEFAULT_RUNTIME_GATEWAY_ROUTING_CONFIG
);
