import * as z from 'zod';
import type { Organization, organization_invitations } from '@kilocode/db/schema';
import type { Result } from '@/lib/maybe-result';
import { CompanyDomainSchema } from './company-domain';

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
import {
  ModelSettingsSchema,
  OpenClawModelSettingsSchema,
  OpenCodeSettingsSchema,
  OpenRouterProvider as OpenRouterProviderSchema,
  VersionedSettingsSchema,
} from '@kilocode/db/schema-types';

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
// OpenRouterProviderSchema is re-exported from @kilocode/db/schema-types so that
// the frontend-facing parser stays in sync with the Zod schema used to validate
// the payload synced into Redis by the cron job.
export const OpenRouterProvidersResponseSchema = z.object({
  data: z.array(OpenRouterProviderSchema),
});

const OpenRouterModelSchema = z.object({
  // kilocode additions:
  preferredIndex: z.number().optional(),
  isFree: z.boolean().optional(),
  settings: ModelSettingsSchema.optional(),
  versioned_settings: VersionedSettingsSchema.optional(),
  opencode: OpenCodeSettingsSchema.optional(),
  openclaw: OpenClawModelSettingsSchema.optional(),

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
