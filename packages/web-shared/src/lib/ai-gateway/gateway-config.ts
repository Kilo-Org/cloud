import * as z from 'zod';

export const DEFAULT_VERCEL_ROUTING_ENABLED = true;

export const NOTE_MAX_LENGTH = 500;

export const VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH = 200;
export const VERCEL_ROUTING_OPT_OUT_MODELS_MAX_COUNT = 200;

const note = z.string().max(NOTE_MAX_LENGTH);

/**
 * Saved configurations from before the switch only contain the obsolete
 * percentage fields, so a missing value parses as the compiled default.
 */
const vercelRoutingEnabled = z.boolean().default(DEFAULT_VERCEL_ROUTING_ENABLED);

export const GatewayConfigSchema = z.object({
  vercel_routing_enabled: vercelRoutingEnabled,
  vercel_routing_opt_out_models: z.array(z.string().min(1)).default([]),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
  note: note.nullable().default(null),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  vercel_routing_enabled: DEFAULT_VERCEL_ROUTING_ENABLED,
  vercel_routing_opt_out_models: [],
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
  note: null,
};

/** Schema for parsing the routing settings on the hot path. */
export const GatewayRoutingConfigSchema = z.object({
  vercel_routing_enabled: vercelRoutingEnabled,
  vercel_routing_opt_out_models: z.array(z.string().min(1)).default([]),
});

/**
 * The admin form submits one model ID per line, so the write schema owns the
 * stored form: trimmed, lowercase, non-empty, bounded and duplicate-free. Every
 * accepted input therefore stays parseable by the stored-config and hot-path
 * schemas, and a saved list never carries an entry the readers reject.
 */
const vercelRoutingOptOutModels = z
  .array(z.string().trim().toLowerCase().min(1).max(VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH))
  .max(VERCEL_ROUTING_OPT_OUT_MODELS_MAX_COUNT)
  .transform(models => [...new Set(models)]);

/** Schema for the admin set-mutation input. */
export const GatewayConfigInputSchema = z.object({
  vercel_routing_enabled: z.boolean(),
  vercel_routing_opt_out_models: vercelRoutingOptOutModels,
  note: note.nullable(),
});
