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

export const ORGANIZATION_FEATURE_ORGANIZATIONS_MAX_COUNT = 1000;

const storedOrganizationIds = z.array(z.string()).default([]);

/**
 * Per-feature lists of the organizations a feature is enabled for, stored under
 * `organization_features` in the gateway configuration. A feature missing from
 * a saved configuration is enabled for no organization.
 */
export const OrganizationFeaturesSchema = z.object({
  experimental_byok: storedOrganizationIds,
  gateway_disable_toggles: storedOrganizationIds,
  data_region: storedOrganizationIds,
});

export type OrganizationFeatures = z.infer<typeof OrganizationFeaturesSchema>;
export type OrganizationFeature = keyof OrganizationFeatures;

export const ORGANIZATION_FEATURES = OrganizationFeaturesSchema.keyof().options;

export const ORGANIZATION_FEATURE_DESCRIPTIONS = {
  experimental_byok: {
    label: 'Direct Amazon Bedrock and Google Vertex AI BYOK',
    description: 'Lets the organization add direct Amazon Bedrock and Google Vertex AI keys.',
  },
  gateway_disable_toggles: {
    label: 'Disable OpenRouter or Vercel AI Gateway',
    description:
      'Lets the organization turn off OpenRouter or the Vercel AI Gateway on its Providers & Models page.',
  },
  data_region: {
    label: 'Data region',
    description:
      'Lets the organization pin OpenRouter and Vercel AI Gateway requests to the EU or the US on its Providers & Models page.',
  },
} as const satisfies Record<OrganizationFeature, { label: string; description: string }>;

export const DEFAULT_ORGANIZATION_FEATURES: OrganizationFeatures = OrganizationFeaturesSchema.parse(
  {}
);

/** Reads the organization features from a stored gateway configuration. */
export const GatewayOrganizationFeaturesConfigSchema = z.object({
  organization_features: OrganizationFeaturesSchema.prefault({}),
});

const organizationIdsInput = z
  .array(z.guid())
  .max(ORGANIZATION_FEATURE_ORGANIZATIONS_MAX_COUNT)
  .transform(ids => [...new Set(ids.map(id => id.toLowerCase()))]);

/** Schema for the admin organization-features mutation input. */
export const OrganizationFeaturesInputSchema = z.object({
  experimental_byok: organizationIdsInput,
  gateway_disable_toggles: organizationIdsInput,
  data_region: organizationIdsInput,
}) satisfies z.ZodType<OrganizationFeatures, unknown>;
