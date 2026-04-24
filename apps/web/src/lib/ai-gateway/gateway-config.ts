import * as z from 'zod';

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

/**
 * Schema for parsing just the percentage from Redis (used on the hot path).
 *
 * `vercel_routing_percentage` is nullable because clearing the override in
 * the admin UI persists an explicit `null`. Callers should treat `null` as
 * "no override, use DEFAULT_VERCEL_PERCENTAGE".
 */
export const GatewayPercentageSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable(),
});

/** Schema for the admin set-mutation input. */
export const GatewayConfigInputSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable(),
});
