import * as z from 'zod';

export const VERCEL_ROUTING_REDIS_KEY = 'ai-gateway:vercel-routing-percentage';
export const DEFAULT_VERCEL_PERCENTAGE = 10;

const vercelRoutingPercentage = z.number().int().min(0).max(100);

export const GatewayConfigSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  vercel_routing_percentage: null,
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
};

/** Schema for parsing just the percentage from Redis (used on the hot path). */
export const GatewayPercentageSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage,
});

/** Schema for the admin set-mutation input. */
export const GatewayConfigInputSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable(),
});
