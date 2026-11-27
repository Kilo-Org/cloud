import * as z from 'zod';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';

export const NOTE_MAX_LENGTH = 500;

export const VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH = 200;
export const VERCEL_ROUTING_OPT_OUT_MODELS_MAX_COUNT = 200;

const note = z.string().max(NOTE_MAX_LENGTH);

/**
 * Saved configurations from before the field existed carry no list, so a
 * missing value parses as an empty one.
 */
const storedVercelRoutingOptOutModels = z.array(z.string().min(1)).default([]);

export const GatewayConfigSchema = z.object({
  vercel_routing_opt_out_models: storedVercelRoutingOptOutModels,
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
  note: note.nullable().default(null),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = GatewayConfigSchema.parse({
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
});

/** Schema for parsing the routing settings on the hot path. */
export const GatewayRoutingConfigSchema = z.object({
  vercel_routing_opt_out_models: storedVercelRoutingOptOutModels,
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
  vercel_routing_opt_out_models: vercelRoutingOptOutModels,
  note: note.nullable(),
});

export const ORGANIZATION_FEATURE_ORGANIZATIONS_MAX_COUNT = 1000;

const storedOrganizationIds = z.array(z.string().transform(id => id.toLowerCase())).default([]);

/**
 * Per-feature lists of the organizations a feature is enabled for, stored under
 * `organization_features` in the gateway configuration. A feature missing from
 * a saved configuration is enabled for no organization.
 */
export const OrganizationFeaturesSchema = z.object({
  experimental_byok: storedOrganizationIds,
  byok_private_providers: storedOrganizationIds,
  enkrypt_output_guardrail: storedOrganizationIds,
  gateway_settings: storedOrganizationIds,
  org_permission_policy: storedOrganizationIds,
});

export type OrganizationFeatures = z.infer<typeof OrganizationFeaturesSchema>;
export type OrganizationFeature = keyof OrganizationFeatures;

export const ORGANIZATION_FEATURES = OrganizationFeaturesSchema.keyof().options;

export const ORGANIZATION_FEATURE_DESCRIPTIONS = {
  experimental_byok: {
    label: 'Direct Amazon Bedrock and Google Vertex AI BYOK',
    description: 'Lets the organization add direct Amazon Bedrock and Google Vertex AI keys.',
  },
  byok_private_providers: {
    label: 'BYOK private providers',
    description:
      'Lets the organization add its own OpenAI- or Anthropic-compatible providers as private BYOK providers.',
  },
  enkrypt_output_guardrail: {
    label: 'Enkrypt output guardrails',
    description:
      'Lets the organization configure Enkrypt output guardrails in AI Guardrails. Existing output guardrails keep running when this feature is removed.',
  },
  gateway_settings: {
    label: 'Advanced policies',
    description:
      'Lets an enterprise organization turn off OpenRouter and pin requests paid with Kilo credits to a Vercel AI Gateway inference region, on the Advanced policies tab of its Providers & Models page. The policies stop applying if the organization leaves the enterprise plan.',
  },
  org_permission_policy: {
    label: 'Organization permission policy',
    description:
      'Makes versioned agent and client permission policies available to Enterprise organizations.',
  },
} as const satisfies Record<OrganizationFeature, { label: string; description: string }>;

export const ORGANIZATION_DATA_REGION_NAMES = {
  us: 'United States',
  eu: 'European Union',
  au: 'Australia',
  jp: 'Japan',
} as const satisfies Record<OrganizationDataRegion, string>;

export const DEFAULT_ORGANIZATION_FEATURES: OrganizationFeatures = OrganizationFeaturesSchema.parse(
  {}
);

/** Reads the organization features from a stored gateway configuration. */
export const GatewayOrganizationFeaturesConfigSchema = z.object({
  organization_features: OrganizationFeaturesSchema.prefault({}),
});

/** A bound-checked organization-id list input: guids, deduped and lowercased. */
const organizationIdsListInput = (max: number) =>
  z
    .array(z.guid())
    .max(max)
    .transform(ids => [...new Set(ids.map(id => id.toLowerCase()))]);

const organizationIdsInput = organizationIdsListInput(ORGANIZATION_FEATURE_ORGANIZATIONS_MAX_COUNT);

/** Schema for the admin organization-features mutation input. */
export const OrganizationFeaturesInputSchema = z.object({
  experimental_byok: organizationIdsInput,
  byok_private_providers: organizationIdsInput,
  enkrypt_output_guardrail: organizationIdsInput,
  gateway_settings: organizationIdsInput,
  org_permission_policy: organizationIdsInput,
}) satisfies z.ZodType<OrganizationFeatures, unknown>;

export const OrganizationFeaturesCompatibleInputSchema = OrganizationFeaturesInputSchema.extend({
  org_permission_policy: organizationIdsInput.optional(),
});

export const ANTHROPIC_USER_PROFILE_LIST_MAX_COUNT = 1000;

const storedIds = z.array(z.string()).default([]);

/**
 * Settings for attributing Kilo-paid Claude requests to Anthropic user profiles,
 * stored under `anthropic_user_profiles` in the gateway configuration. With
 * `enabled` set, a user or organization gets a profile when explicitly opted in,
 * or once `start_at` has passed; without `start_at`, only opt-ins get one.
 * Opt-outs never get a profile or the header, and win over opt-ins.
 */
export const AnthropicUserProfilesSettingsSchema = z.object({
  /** Incremented on every save, so a save from a stale form can be rejected. */
  revision: z.number().int().min(0).default(0),
  enabled: z.boolean().default(false),
  start_at: z.string().nullable().default(null),
  opted_in_user_ids: storedIds,
  opted_in_organization_ids: storedOrganizationIds,
  opted_out_user_ids: storedIds,
  opted_out_organization_ids: storedOrganizationIds,
});

export type AnthropicUserProfilesSettings = z.infer<typeof AnthropicUserProfilesSettingsSchema>;

export const DEFAULT_ANTHROPIC_USER_PROFILES_SETTINGS: AnthropicUserProfilesSettings =
  AnthropicUserProfilesSettingsSchema.parse({});

/** Reads the Anthropic user profile settings from a stored gateway configuration. */
export const GatewayAnthropicUserProfilesConfigSchema = z.object({
  anthropic_user_profiles: AnthropicUserProfilesSettingsSchema.prefault({}),
});

const userIdsInput = z
  .array(z.string().trim().min(1))
  .max(ANTHROPIC_USER_PROFILE_LIST_MAX_COUNT)
  .transform(ids => [...new Set(ids)]);

const anthropicOrganizationIdsInput = organizationIdsListInput(
  ANTHROPIC_USER_PROFILE_LIST_MAX_COUNT
);

function overlap(a: string[], b: string[]): string[] {
  const set = new Set(a);
  return b.filter(id => set.has(id));
}

/** Schema for the admin Anthropic user profile settings mutation input. */
export const AnthropicUserProfilesSettingsInputSchema = z
  .object({
    /** The revision the form was loaded with. */
    revision: z.number().int().min(0),
    enabled: z.boolean(),
    start_at: z.iso.datetime({ offset: true }).nullable(),
    opted_in_user_ids: userIdsInput,
    opted_in_organization_ids: anthropicOrganizationIdsInput,
    opted_out_user_ids: userIdsInput,
    opted_out_organization_ids: anthropicOrganizationIdsInput,
  })
  .superRefine((input, ctx) => {
    const users = overlap(input.opted_in_user_ids, input.opted_out_user_ids);
    if (users.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['opted_out_user_ids'],
        message: `Users cannot be both opted in and opted out: ${users.join(', ')}`,
      });
    }
    const organizations = overlap(
      input.opted_in_organization_ids,
      input.opted_out_organization_ids
    );
    if (organizations.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['opted_out_organization_ids'],
        message: `Organizations cannot be both opted in and opted out: ${organizations.join(', ')}`,
      });
    }
  }) satisfies z.ZodType<AnthropicUserProfilesSettings, unknown>;
