import * as z from 'zod';

export const NOTE_MAX_LENGTH = 500;

const note = z.string().max(NOTE_MAX_LENGTH);

export const GatewayConfigSchema = z.object({
  vercel_routing_opt_out_models: z.array(z.string().min(1)).default([]),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
  note: note.nullable().default(null),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  vercel_routing_opt_out_models: [],
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
  note: null,
};

/** Schema for parsing the routing settings from the database (used on the hot path). */
export const GatewayRoutingConfigSchema = z.object({
  vercel_routing_opt_out_models: z.array(z.string().min(1)).default([]),
});

/** Schema for the admin set-mutation input. */
export const GatewayConfigInputSchema = z.object({
  vercel_routing_opt_out_models: z.array(z.string()),
  note: note.nullable(),
});
