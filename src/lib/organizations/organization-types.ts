import * as z from 'zod';
import type { Organization, organization_invitations } from '@/db/schema';
import type { Result } from '@/lib/maybe-result';

// Re-export base types that don't depend on schema.ts
export type {
  OrganizationRole,
  OrganizationPlan,
  OrganizationSettings,
  OrganizationModeConfig,
  EditGroupConfig,
} from './organization-base-types';
export {
  OrganizationPlanSchema,
  OrganizationModeConfigSchema,
  OrganizationSettingsSchema,
} from './organization-base-types';

import type { OrganizationRole, OrganizationPlan } from './organization-base-types';
import { OrganizationPlanSchema, OrganizationSettingsSchema } from './organization-base-types';

export const OrganizationNameSchema = z
  .string()
  .trim()
  .min(1, 'Organization name is required')
  .max(100, 'Organization name must be less than 100 characters');

export const OrganizationCreateRequestSchema = z.object({
  name: OrganizationNameSchema,
  autoAddCreator: z.boolean().optional().default(false),
  plan: OrganizationPlanSchema.optional().default('teams'),
});

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  microdollars_used: z.number(),
  total_microdollars_acquired: z.number(),
  next_credit_expiration_at: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  auto_top_up_enabled: z.boolean(),
  settings: OrganizationSettingsSchema,
  seat_count: z.number().min(0).default(0),
  require_seats: z.boolean().default(false),
  created_by_kilo_user_id: z.string().nullable(),
  deleted_at: z.string().nullable(),
  sso_domain: z.string().nullable(),
  plan: z.enum(['teams', 'enterprise']),
  free_trial_end_at: z.string().nullable(),
});

export type UserOrganizationWithSeats = {
  organizationName: string;
  organizationId: Organization['id'];
  role: OrganizationRole;
  memberCount: number;
  balance: number;
  requireSeats: boolean;
  plan: OrganizationPlan;
  created_at: Organization['created_at'];
  seatCount: {
    used: number;
    total: number;
  };
};

type InvitedMember = {
  email: string;
  role: OrganizationRole;
  inviteDate: string | null;
  inviteToken: string;
  inviteId: string; // Database ID for deletion
  status: 'invited';
  inviteUrl: string;
  dailyUsageLimitUsd: number | null;
  currentDailyUsageUsd: number | null;
};

type ActiveMember = {
  id: string;
  name: string;
  email: string;
  role: OrganizationRole;
  status: 'active';
  inviteDate: string | null;
  dailyUsageLimitUsd: number | null;
  currentDailyUsageUsd: number | null;
};

export type OrganizationMember = InvitedMember | ActiveMember;

export type OrganizationWithMembers = z.infer<typeof OrganizationSchema> & {
  members: OrganizationMember[];
};

export type AcceptInviteResult = Result<
  {
    invitation: typeof organization_invitations.$inferSelect;
    organizationId: string;
    role: OrganizationRole;
  },
  string
>;

export const UsageStatsSchema = z.object({
  totalCost: z.number(),
  totalRequestCount: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
});

export type UsageDetailByDay = Array<{
  date: string;
  user: {
    name: string;
    email: string;
  };
  model?: string;
  microdollarCost: string | null;
  tokenCount: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}>;

export type UsageDetails = {
  daily: UsageDetailByDay;
};

export const TimePeriodSchema = z.enum(['week', 'month', 'year', 'all']);
export type TimePeriod = z.infer<typeof TimePeriodSchema>;

// OpenRouter API Types
const OpenRouterProviderSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  baseUrl: z.string().optional(),
  dataPolicy: z
    .object({
      training: z.boolean().optional(),
      retainsPrompts: z.boolean().optional(),
      canPublish: z.boolean().optional(),
      termsOfServiceURL: z.string().optional(),
      privacyPolicyURL: z.string().optional(),
    })
    .optional(),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  hasChatCompletions: z.boolean().optional(),
  hasCompletions: z.boolean().optional(),
  isAbortable: z.boolean().optional(),
  moderationRequired: z.boolean().optional(),
  editors: z.array(z.string()).optional(),
  owners: z.array(z.string()).optional(),
  adapterName: z.string().optional(),
  isMultipartSupported: z.boolean().optional(),
  statusPageUrl: z.string().nullable().optional(),
  byokEnabled: z.boolean().optional(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
  ignoredProviderModels: z.array(z.string()).optional(),
});

export const OpenRouterProvidersResponseSchema = z.object({
  data: z.array(OpenRouterProviderSchema),
});

const ToolSchema = z.enum([
  'apply_diff',
  'apply_patch',
  'delete_file',
  'edit_file',
  'search_replace',
  'search_and_replace',
  'write_file',
  'write_to_file',
]);

const ModelSettingsSchema = z.object({
  included_tools: z.array(ToolSchema), // adds to the standard tool set
  excluded_tools: z.array(ToolSchema), // removes from the standard tool set
});

export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

const VersionedSettingsSchema = z.record(z.string(), ModelSettingsSchema);
export type VersionedSettings = z.infer<typeof VersionedSettingsSchema>;

const OpenRouterModelSchema = z.object({
  // kilocode additions:
  preferredIndex: z.number().optional(),
  settings: ModelSettingsSchema.optional(),
  versioned_settings: VersionedSettingsSchema.optional(),

  id: z.string(),
  name: z.string(),
  created: z.number(),
  description: z.string(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
    tokenizer: z.string(),
  }),
  top_provider: z.object({
    is_moderated: z.boolean(),
    context_length: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
  }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    image: z.string().optional(),
    request: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    web_search: z.string().optional(),
    internal_reasoning: z.string().optional(),
  }),
  context_length: z.number(),
  per_request_limits: z.record(z.string(), z.unknown()).nullable().optional(),
  supported_parameters: z.array(z.string()).optional(),
});

export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
});

export type OpenRouterProvider = z.infer<typeof OpenRouterProviderSchema>;
export type OpenRouterProvidersResponse = z.infer<typeof OpenRouterProvidersResponseSchema>;
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;
export type OpenRouterModelsResponse = z.infer<typeof OpenRouterModelsResponseSchema>;

export const OrganizationSSODomainSchema = z
  .string()
  .min(1, 'Domain cannot be empty')
  .lowercase()
  .trim();

export type OrgTrialStatus =
  | 'subscribed' // Has active paid subscription
  | 'trial_active' // Trial active, 8+ days remaining
  | 'trial_ending_soon' // Trial active, 4-7 days remaining
  | 'trial_ending_very_soon' // Trial active, 1-3 days remaining
  | 'trial_expires_today' // Last day of trial
  | 'trial_expired_soft' // 1-3 days past expiration (read-only, dismissible)
  | 'trial_expired_hard'; // 4+ days past expiration (blocked, must upgrade)
