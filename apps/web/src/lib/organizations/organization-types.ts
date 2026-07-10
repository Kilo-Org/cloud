import * as z from 'zod';
import { ORGANIZATION_ROLES } from '@kilocode/app-shared/organizations';
import type { Organization, organization_invitations } from '@kilocode/db/schema';
import type { Result } from '@/lib/maybe-result';
import { CompanyDomainSchema, isValidDomain } from './company-domain';

// Re-export base types that don't depend on schema.ts
export type {
  OrganizationRole,
  OrganizationPlan,
  OrganizationSettings,
  OrganizationAutoModelSettings,
  OrganizationModeConfig,
  EditGroupConfig,
} from './organization-base-types';
export {
  OrganizationPlanSchema,
  OrganizationModeConfigSchema,
  OrganizationSettingsSchema,
  OrganizationAutoModelSettingsSchema,
} from './organization-base-types';

import type { OrganizationRole, OrganizationPlan } from './organization-base-types';
import { OrganizationPlanSchema, OrganizationSettingsSchema } from './organization-base-types';
import { OpenCodeSettingsSchema } from '@kilocode/db/schema-types';

export const OrganizationRoleSchema = z.enum(ORGANIZATION_ROLES);

// API-facing billing cycle values: 'monthly' | 'annual'
// The DB stores 'yearly' instead of 'annual'; Stripe uses 'year'/'month'.
export const BillingCycleSchema = z.enum(['monthly', 'annual']);
export type BillingCycle = z.infer<typeof BillingCycleSchema>;

export function billingCycleToDb(cycle: BillingCycle): 'monthly' | 'yearly' {
  return cycle === 'annual' ? 'yearly' : 'monthly';
}

// Maps DB ('yearly') or Stripe ('year') interval values to the domain BillingCycle.
export function toBillingCycle(source: 'monthly' | 'yearly' | 'month' | 'year'): BillingCycle {
  return source === 'yearly' || source === 'year' ? 'annual' : 'monthly';
}

/** @deprecated Use toBillingCycle */
export const billingCycleFromDb: (dbCycle: 'monthly' | 'yearly') => BillingCycle = toBillingCycle;
/** @deprecated Use toBillingCycle */
export const billingCycleFromStripeInterval: (interval: 'month' | 'year') => BillingCycle =
  toBillingCycle;

export const OrganizationNameSchema = z
  .string()
  .trim()
  .min(1, 'Organization name is required')
  .max(100, 'Organization name must be less than 100 characters');

export const OrganizationCreateRequestSchema = z.object({
  name: OrganizationNameSchema,
  autoAddCreator: z.boolean().optional().default(false),
  company_domain: CompanyDomainSchema.optional(),
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
  require_seats: z.boolean().default(true),
  created_by_kilo_user_id: z.string().nullable(),
  deleted_at: z.string().nullable(),
  sso_domain: z.string().nullable(),
  parent_organization_id: z.string().nullable(),
  plan: z.enum(['teams', 'enterprise']),
  free_trial_end_at: z.string().nullable(),
  company_domain: z.string().nullable(),
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

export const InvitedOrganizationMemberSchema = z.object({
  email: z.string(),
  role: OrganizationRoleSchema,
  inviteDate: z.string().nullable(),
  inviteToken: z.string(),
  inviteId: z.string(),
  status: z.literal('invited'),
  inviteUrl: z.string(),
  dailyUsageLimitUsd: z.number().nullable(),
  currentDailyUsageUsd: z.number().nullable(),
});

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

export const ActiveOrganizationMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: OrganizationRoleSchema,
  status: z.literal('active'),
  inviteDate: z.string().nullable(),
  dailyUsageLimitUsd: z.number().nullable(),
  currentDailyUsageUsd: z.number().nullable(),
});

type ActiveMember = {
  id: string;
  name: string;
  email: string;
  role: OrganizationRole;
  status: 'active';
  inviteDate: string | null;
  dailyUsageLimitUsd: number | null;
  currentDailyUsageUsd: number | null;
  childOrganizationMemberships?: ChildOrganizationMembership[];
};

export type OrganizationMember = InvitedMember | ActiveMember;

export const OrganizationMemberSchema = z.discriminatedUnion('status', [
  ActiveOrganizationMemberSchema,
  InvitedOrganizationMemberSchema,
]);

export const PublicInvitedOrganizationMemberSchema = InvitedOrganizationMemberSchema.omit({
  inviteToken: true,
  inviteId: true,
  inviteUrl: true,
  dailyUsageLimitUsd: true,
  currentDailyUsageUsd: true,
});

export const PublicActiveOrganizationMemberSchema = ActiveOrganizationMemberSchema.omit({
  dailyUsageLimitUsd: true,
  currentDailyUsageUsd: true,
});

export const PublicOrganizationMemberSchema = z.discriminatedUnion('status', [
  PublicActiveOrganizationMemberSchema,
  PublicInvitedOrganizationMemberSchema,
]);

export const PublicOrganizationMembersSchema = z.array(PublicOrganizationMemberSchema);

export const OrganizationWithMembersSchema = OrganizationSchema.extend({
  members: z.array(OrganizationMemberSchema),
});

export type ChildOrganizationSummary = {
  id: string;
  name: string;
};

export type ChildOrganizationMembership = ChildOrganizationSummary & {
  role: OrganizationRole;
};

export type OrganizationSsoPolicyView = {
  required: boolean;
  source: 'self' | 'direct_parent' | null;
  domain: string | null;
  configurationError: boolean;
};

export type OrganizationWithMembers = z.infer<typeof OrganizationSchema> & {
  members: OrganizationMember[];
  childOrganizations: ChildOrganizationSummary[];
  effectiveSsoPolicy: OrganizationSsoPolicyView;
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

const OpenRouterModelSchema = z.object({
  // kilocode additions:
  preferredIndex: z.number().optional(),
  isFree: z.boolean().optional(),
  mayTrainOnYourPrompts: z.boolean().optional(),
  hasUserByokAvailable: z.boolean().optional(),
  autoRouting: z
    .object({
      models: z.array(z.string()),
    })
    .optional(),
  terminalBench: z
    .object({
      overallScore: z.number(),
      avgAttemptCostUsd: z.number(),
    })
    .optional(),
  opencode: OpenCodeSettingsSchema.optional(),

  id: z.string(),
  name: z.string(),
  created: z.number(),
  description: z.string(),
  architecture: z.object({
    modality: z.string().nullable().optional(),
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
  expiration_date: z.string().nullable().optional(), // format: yyyy-MM-dd
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
  .trim()
  .toLowerCase()
  .refine(isValidDomain, { message: 'Please enter a valid domain (e.g. acme.com)' });

export type OrgTrialStatus =
  | 'subscribed' // Has active paid subscription
  | 'trial_active' // Trial active, 8+ days remaining
  | 'trial_ending_soon' // Trial active, 4-7 days remaining
  | 'trial_ending_very_soon' // Trial active, 1-3 days remaining
  | 'trial_expires_today' // Last day of trial
  | 'trial_expired_soft' // 1-3 days past expiration (read-only, dismissible)
  | 'trial_expired_hard'; // 4+ days past expiration (blocked, must upgrade)
