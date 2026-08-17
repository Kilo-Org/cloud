import * as z from 'zod';

export const DEFAULT_VERCEL_PERCENTAGE = 50;
export const DEFAULT_VERCEL_PERCENTAGE_FREE = 50;
export const DEFAULT_FRIENDLI_PERCENTAGE = 0;
export const DEFAULT_PERPLEXITY_PERCENTAGE = 0;

export const RoutingPercentageSchema = z.number().min(0).max(100).multipleOf(0.001);

export const NOTE_MAX_LENGTH = 500;

const note = z.string().max(NOTE_MAX_LENGTH);

export const GatewayConfigSchema = z.object({
  vercel_routing_percentage: RoutingPercentageSchema.nullable(),
  vercel_routing_percentage_free: RoutingPercentageSchema.nullable().default(null),
  vercel_routing_opt_out_models: z.array(z.string().min(1)).default([]),
  friendli_routing_percentage: RoutingPercentageSchema.nullable().default(null),
  perplexity_routing_percentage: RoutingPercentageSchema.nullable().default(null),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
  note: note.nullable().default(null),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  vercel_routing_percentage: null,
  vercel_routing_percentage_free: null,
  vercel_routing_opt_out_models: [],
  friendli_routing_percentage: null,
  perplexity_routing_percentage: null,
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
  note: null,
};

/**
 * Schema for parsing the routing settings from Redis (used on the hot path).
 *
 * `vercel_routing_percentage` is nullable because clearing the override in
 * the admin UI persists an explicit `null`. Callers should treat `null` as
 * "no override, use DEFAULT_VERCEL_PERCENTAGE". It applies to paid models.
 *
 * All fields added after the initial Vercel percentage default to `null` so
 * pre-existing Redis entries parse cleanly. Callers should treat `null` as
 * "no override" and use the corresponding compiled default.
 */
export const GatewayRoutingConfigSchema = z.object({
  vercel_routing_percentage: RoutingPercentageSchema.nullable(),
  vercel_routing_percentage_free: RoutingPercentageSchema.nullable().default(null),
  vercel_routing_opt_out_models: z.array(z.string().min(1)).default([]),
  friendli_routing_percentage: RoutingPercentageSchema.nullable().default(null),
  perplexity_routing_percentage: RoutingPercentageSchema.nullable().default(null),
});

/** Schema for the admin set-mutation input. */
export const GatewayConfigInputSchema = z.object({
  vercel_routing_percentage: RoutingPercentageSchema.nullable(),
  vercel_routing_percentage_free: RoutingPercentageSchema.nullable(),
  vercel_routing_opt_out_models: z.array(z.string()),
  friendli_routing_percentage: RoutingPercentageSchema.nullable(),
  perplexity_routing_percentage: RoutingPercentageSchema.nullable(),
  note: note.nullable(),
});
