import * as z from 'zod';

export const DEFAULT_VERCEL_PERCENTAGE = 50;

const vercelRoutingPercentage = z.number().int().min(0).max(100);

export const NOTE_MAX_LENGTH = 500;

const note = z.string().max(NOTE_MAX_LENGTH);

export const GatewayConfigSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
  note: note.nullable().default(null),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  vercel_routing_percentage: null,
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
  note: null,
};

export const GatewayPercentageSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable(),
});

export const GatewayConfigInputSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable(),
  note: note.nullable(),
});
