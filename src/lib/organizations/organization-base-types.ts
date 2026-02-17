import * as z from 'zod';

// Base types that don't depend on @/db/schema
// These are used by schema.ts and re-exported from organization-types.ts

export type OrganizationRole = 'owner' | 'member' | 'billing_manager';

export const OrganizationPlanSchema = z.enum(['teams', 'enterprise']);

export type OrganizationPlan = z.infer<typeof OrganizationPlanSchema>;

const OrganizationSettingsSchema = z.object({
  model_allow_list: z.array(z.string()).optional(),
  provider_allow_list: z.array(z.string()).optional(),
  default_model: z.string().optional(),
  data_collection: z.enum(['allow', 'deny']).nullable().optional(),
  // null means they were grandfathered in and so they have usage limits enabled
  enable_usage_limits: z.boolean().optional(),
  code_indexing_enabled: z.boolean().optional(),
  projects_ui_enabled: z.boolean().optional(),
  minimum_balance: z.number().optional(),
  minimum_balance_alert_email: z.array(z.email()).optional(),
  suppress_trial_messaging: z.boolean().optional(),
  // OSS Sponsorship fields
  // null/undefined = not an OSS org, values: 1, 2, or 3
  oss_sponsorship_tier: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .nullable()
    .optional(),
  github_app_type: z.enum(['lite', 'standard']).nullable().optional(),
  // Credits to reset to every 30 days (in microdollars)
  oss_monthly_credit_amount_microdollars: z.number().nullable().optional(),
  // When credits were last reset (ISO timestamp string)
  oss_credits_last_reset_at: z.string().nullable().optional(),
  // Full GitHub URL for OSS sponsored repos (e.g., https://github.com/org/repo)
  oss_github_url: z.string().url().nullable().optional(),
});

export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;

const GroupNameSchema = z.enum(['read', 'edit', 'browser', 'command', 'mcp']);

const EditGroupConfigSchema = z.object({
  fileRegex: z.string().min(1, 'File regex cannot be empty'),
  description: z.string().optional(),
});

// Groups can be either simple strings or tuples for edit with config
const GroupEntrySchema = z.union([
  GroupNameSchema,
  z.tuple([z.literal('edit'), EditGroupConfigSchema]),
]);

export const OrganizationModeConfigSchema = z.object({
  roleDefinition: z.string().min(1, 'Role definition is required'),
  whenToUse: z.string().optional(),
  description: z.string().optional(),
  customInstructions: z.string().optional(),
  groups: z.array(GroupEntrySchema),
});

export type OrganizationModeConfig = z.infer<typeof OrganizationModeConfigSchema>;
export type EditGroupConfig = z.infer<typeof EditGroupConfigSchema>;

// Re-export the settings schema for use in organization-types.ts
export { OrganizationSettingsSchema };
