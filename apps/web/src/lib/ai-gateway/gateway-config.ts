import * as z from 'zod';

export const DEFAULT_VERCEL_PERCENTAGE = 50;

export const VERCEL_ROUTING_API_TYPES = ['chat', 'embeddings', 'transcription'] as const;
export type VercelRoutingApiType = (typeof VERCEL_ROUTING_API_TYPES)[number];

export const VERCEL_ROUTING_PERCENTAGE_FIELDS = {
  chat: 'vercel_chat_routing_percentage',
  embeddings: 'vercel_embeddings_routing_percentage',
  transcription: 'vercel_transcription_routing_percentage',
} as const satisfies Record<VercelRoutingApiType, string>;

const vercelRoutingPercentage = z.number().int().min(0).max(100);

export const NOTE_MAX_LENGTH = 500;

const note = z.string().max(NOTE_MAX_LENGTH);

const gatewayConfigMetadata = {
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
  note: note.nullable().default(null),
};

const CurrentGatewayConfigSchema = z.object({
  vercel_routing_percentage: vercelRoutingPercentage.nullable().optional(),
  vercel_chat_routing_percentage: vercelRoutingPercentage.nullable(),
  vercel_embeddings_routing_percentage: vercelRoutingPercentage.nullable(),
  vercel_transcription_routing_percentage: vercelRoutingPercentage.nullable(),
  ...gatewayConfigMetadata,
});

const LegacyGatewayConfigSchema = z
  .object({
    vercel_routing_percentage: vercelRoutingPercentage.nullable(),
    ...gatewayConfigMetadata,
  })
  .transform(config => ({
    vercel_chat_routing_percentage: config.vercel_routing_percentage,
    vercel_embeddings_routing_percentage: null,
    vercel_transcription_routing_percentage: null,
    updated_at: config.updated_at,
    updated_by: config.updated_by,
    updated_by_email: config.updated_by_email,
    note: config.note,
  }));

export const GatewayConfigSchema = z.union([CurrentGatewayConfigSchema, LegacyGatewayConfigSchema]);

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  vercel_routing_percentage: null,
  vercel_chat_routing_percentage: null,
  vercel_embeddings_routing_percentage: null,
  vercel_transcription_routing_percentage: null,
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
  note: null,
};

/**
 * Schema for parsing just the percentage from Redis (used on the hot path).
 *
 * Percentages are nullable because clearing an override in the admin UI persists
 * an explicit `null`. Callers treat `null` as the default percentage.
 */
export const GatewayPercentageSchema = z.object({
  vercel_chat_routing_percentage: vercelRoutingPercentage.nullable(),
  vercel_embeddings_routing_percentage: vercelRoutingPercentage.nullable(),
  vercel_transcription_routing_percentage: vercelRoutingPercentage.nullable(),
});

/** Schema for the admin set-mutation input. */
export const GatewayConfigInputSchema = z.object({
  vercel_chat_routing_percentage: vercelRoutingPercentage.nullable(),
  vercel_embeddings_routing_percentage: vercelRoutingPercentage.nullable(),
  vercel_transcription_routing_percentage: vercelRoutingPercentage.nullable(),
  note: note.nullable(),
});
