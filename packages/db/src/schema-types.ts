import * as z from 'zod';

// =============================================================================
// A. Runtime Values (used in enumCheck() or .default())
// =============================================================================

// --- KiloPass enums ---

export enum KiloPassTier {
  Tier19 = 'tier_19',
  Tier49 = 'tier_49',
  Tier199 = 'tier_199',
}

export enum KiloPassCadence {
  Monthly = 'monthly',
  Yearly = 'yearly',
}

export enum KiloPassIssuanceSource {
  StripeInvoice = 'stripe_invoice',
  Cron = 'cron',
}

export enum KiloPassIssuanceItemKind {
  Base = 'base',
  Bonus = 'bonus',
  PromoFirstMonth50Pct = 'promo_first_month_50pct',
}

export enum KiloPassAuditLogAction {
  StripeWebhookReceived = 'stripe_webhook_received',
  KiloPassInvoicePaidHandled = 'kilo_pass_invoice_paid_handled',
  BaseCreditsIssued = 'base_credits_issued',
  BonusCreditsIssued = 'bonus_credits_issued',
  BonusCreditsSkippedIdempotent = 'bonus_credits_skipped_idempotent',
  FirstMonth50PctPromoIssued = 'first_month_50pct_promo_issued',
  YearlyMonthlyBaseCronStarted = 'yearly_monthly_base_cron_started',
  YearlyMonthlyBaseCronCompleted = 'yearly_monthly_base_cron_completed',
  IssueYearlyRemainingCredits = 'issue_yearly_remaining_credits',

  /* Not removed because I didn't want to deal with the migration. */
  /**
   * @deprecated
   */
  YearlyMonthlyBonusCronStarted = 'yearly_monthly_bonus_cron_started',
  /**
   * @deprecated
   */
  YearlyMonthlyBonusCronCompleted = 'yearly_monthly_bonus_cron_completed',
}

export enum KiloPassAuditLogResult {
  Success = 'success',
  SkippedIdempotent = 'skipped_idempotent',
  Failed = 'failed',
}

/** Matches Stripe.SubscriptionSchedule.Status */
export enum KiloPassScheduledChangeStatus {
  NotStarted = 'not_started',
  Active = 'active',
  Completed = 'completed',
  Released = 'released',
  Canceled = 'canceled',
}

// --- Feedback consts ---

export const FeedbackFor = {
  Unknown: 'unknown',
  KiloPass: 'kilopass',
} as const;

export type FeedbackFor = (typeof FeedbackFor)[keyof typeof FeedbackFor];

export const FeedbackSource = {
  Web: 'web',
  Email: 'email',
  Unknown: 'unknown',
} as const;

export type FeedbackSource = (typeof FeedbackSource)[keyof typeof FeedbackSource];

// --- CliSessionSharedState ---

export enum CliSessionSharedState {
  Public = 'public',
  Organization = 'organization',
}

// --- SecurityAuditLogAction ---

/**
 * Actions logged in the security_audit_log table.
 *
 * Follows a consistent 3-segment `security.entity.verb` pattern.
 */
export enum SecurityAuditLogAction {
  FindingCreated = 'security.finding.created',
  FindingStatusChange = 'security.finding.status_change',
  FindingDismissed = 'security.finding.dismissed',
  FindingAutoDismissed = 'security.finding.auto_dismissed',
  FindingAnalysisStarted = 'security.finding.analysis_started',
  FindingAnalysisCompleted = 'security.finding.analysis_completed',
  FindingDeleted = 'security.finding.deleted',
  ConfigEnabled = 'security.config.enabled',
  ConfigDisabled = 'security.config.disabled',
  ConfigUpdated = 'security.config.updated',
  SyncTriggered = 'security.sync.triggered',
  SyncCompleted = 'security.sync.completed',
  AuditLogExported = 'security.audit_log.exported',
}

// --- KiloClaw enums ---

export const KiloClawPlan = {
  Trial: 'trial',
  Commit: 'commit',
  Standard: 'standard',
} as const;

export type KiloClawPlan = (typeof KiloClawPlan)[keyof typeof KiloClawPlan];

export const KiloClawScheduledPlan = {
  Commit: 'commit',
  Standard: 'standard',
} as const;

export type KiloClawScheduledPlan =
  (typeof KiloClawScheduledPlan)[keyof typeof KiloClawScheduledPlan];

export const KiloClawScheduledBy = {
  Auto: 'auto',
  User: 'user',
} as const;

export type KiloClawScheduledBy = (typeof KiloClawScheduledBy)[keyof typeof KiloClawScheduledBy];

export const KiloClawSubscriptionStatus = {
  Trialing: 'trialing',
  Active: 'active',
  PastDue: 'past_due',
  Canceled: 'canceled',
  Unpaid: 'unpaid',
} as const;

export type KiloClawSubscriptionStatus =
  (typeof KiloClawSubscriptionStatus)[keyof typeof KiloClawSubscriptionStatus];

export const KiloClawPaymentSource = {
  Stripe: 'stripe',
  Credits: 'credits',
} as const;

export type KiloClawPaymentSource =
  (typeof KiloClawPaymentSource)[keyof typeof KiloClawPaymentSource];

export const AffiliateProvider = {
  Impact: 'impact',
} as const;

export type AffiliateProvider = (typeof AffiliateProvider)[keyof typeof AffiliateProvider];

export const AffiliateEventType = {
  Signup: 'signup',
  TrialStart: 'trial_start',
  TrialEnd: 'trial_end',
  Sale: 'sale',
} as const;

export type AffiliateEventType = (typeof AffiliateEventType)[keyof typeof AffiliateEventType];

export const AffiliateEventDeliveryState = {
  Queued: 'queued',
  Blocked: 'blocked',
  Sending: 'sending',
  Delivered: 'delivered',
  Failed: 'failed',
} as const;

export type AffiliateEventDeliveryState =
  (typeof AffiliateEventDeliveryState)[keyof typeof AffiliateEventDeliveryState];

// NOTE: Do not change these action names. Use present tense for consistency.
export const KiloClawAdminAuditAction = z.enum([
  'kiloclaw.volume.extend',
  'kiloclaw.volume.reassociate',
  'kiloclaw.snapshot.restore',
  'kiloclaw.recovery.cleanup_retained_volume',
  'kiloclaw.subscription.update_trial_end',
  'kiloclaw.subscription.reset_trial',
  'kiloclaw.machine.start',
  'kiloclaw.machine.stop',
  'kiloclaw.instance.destroy',
  'kiloclaw.gateway.start',
  'kiloclaw.gateway.stop',
  'kiloclaw.gateway.restart',
  'kiloclaw.config.restore',
  'kiloclaw.doctor.run',
  'kiloclaw.inbound_email.cycle',
  'kiloclaw.inbound_email.update_enabled',
  'kiloclaw.machine.destroy_fly',
  'kiloclaw.machine.resize',
  'kiloclaw.subscription.bulk_trial_grant',
  'kiloclaw.subscription.admin_cancel',
  'kiloclaw.cli_run.start',
  'kiloclaw.cli_run.cancel',
  'kiloclaw.orphan.destroy',
]);

export type KiloClawAdminAuditAction = z.infer<typeof KiloClawAdminAuditAction>;

// --- ContributorChampion enums ---

export const ContributorChampionTier = {
  Contributor: 'contributor',
  Ambassador: 'ambassador',
  Champion: 'champion',
} as const;

export type ContributorChampionTier =
  (typeof ContributorChampionTier)[keyof typeof ContributorChampionTier];

// =============================================================================
// B. Type-Only Definitions (used in $type<T>())
// =============================================================================

// --- Organization types ---

export type OrganizationRole = 'owner' | 'member' | 'billing_manager';

export const OrganizationPlanSchema = z.enum(['teams', 'enterprise']);

export type OrganizationPlan = z.infer<typeof OrganizationPlanSchema>;

const OrganizationSettingsSchema = z.object({
  /** @deprecated use model_deny_list instead. delete if this is still here May 2026 */
  model_allow_list: z.array(z.string()).optional(),
  /** @deprecated use provider_deny_list instead. delete if this is still here May 2026 */
  provider_allow_list: z.array(z.string()).optional(),

  model_deny_list: z.array(z.string()).optional(),
  provider_deny_list: z.array(z.string()).optional(),

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

export { OrganizationSettingsSchema };

// --- AuditLogAction ---

export type AuditLogAction = z.infer<typeof AuditLogAction>;

// NOTE: (bmc) - do not change these action names.
// if you introduce a new event action, please use present tense for consistency.
export const AuditLogAction = z.enum([
  'organization.user.login', // ✅
  'organization.user.logout', // TODO: (bmc) - not sure nextauth lets us get this?
  'organization.user.accept_invite', // ✅
  'organization.user.send_invite', // ✅
  'organization.user.revoke_invite', // ✅
  'organization.settings.change', // ✅
  'organization.purchase_credits', // ✅
  'organization.promo_credit_granted', // ✅
  'organization.member.remove', // ✅
  'organization.member.change_role', // ✅
  'organization.sso.auto_provision', // ✅
  'organization.sso.set_domain', // ✅
  'organization.sso.remove_domain', // ✅
  'organization.mode.create', // ✅
  'organization.mode.update', // ✅
  'organization.mode.delete', // ✅
  'organization.created', // ✅
  'organization.token.generate', // ✅
]);

// --- EncryptedData ---

export type EncryptedData = {
  iv: string;
  data: string;
  authTag: string;
};

// --- AuthProviderId ---

export type AuthProviderId =
  | 'apple'
  | 'email'
  | 'google'
  | 'github'
  | 'gitlab'
  | 'linkedin'
  | 'discord'
  | 'fake-login'
  | 'workos';

// --- AbuseClassification ---

export type AbuseClassification = (typeof ABUSE_CLASSIFICATION)[keyof typeof ABUSE_CLASSIFICATION];
export const ABUSE_CLASSIFICATION = {
  NOT_ABUSE: -100,
  CLASSIFICATION_ERROR: -50,
  NOT_CLASSIFIED: 0,
  LIKELY_ABUSE: 200,
} as const;

// --- Microdollar Usage --

export const GatewayApiKindSchema = z.enum([
  'chat_completions',
  'embeddings',
  'fim_completions',
  'messages',
  'responses',
]);

export type GatewayApiKind = z.infer<typeof GatewayApiKindSchema>;

// --- Integration types ---

export type IntegrationPermissions = Record<string, string>;

export type PlatformRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

// --- Deployment types ---

export const providerSchema = z.enum(['github', 'git', 'app-builder']);

export type Provider = z.infer<typeof providerSchema>;

export const buildStatusSchema = z.enum([
  'queued',
  'building',
  'deploying',
  'deployed',
  'failed',
  'cancelled',
]);

export type BuildStatus = z.infer<typeof buildStatusSchema>;

// --- CodeReviewAgentConfig ---

export const ManuallyAddedRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

export type ManuallyAddedRepository = z.infer<typeof ManuallyAddedRepositorySchema>;

export const CodeReviewAgentConfigSchema = z.object({
  review_style: z.enum(['strict', 'balanced', 'lenient', 'roast']),
  focus_areas: z.array(z.string()),
  auto_approve_minor: z.boolean().optional(),
  custom_instructions: z.string().nullable().optional(),
  max_review_time_minutes: z.number().int().positive(),
  model_slug: z.string(),
  // Thinking effort variant name (e.g. "high", "max", "thinking") — null means model default
  thinking_effort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
  repository_selection_mode: z.enum(['all', 'selected']).optional(),
  selected_repository_ids: z.array(z.number()).optional(),
  // Manually added repositories (for GitLab where pagination limits results)
  manually_added_repositories: z.array(ManuallyAddedRepositorySchema).optional(),
  // Controls when the PR gate check (GitHub Check Run / GitLab commit status)
  // reports a failure based on review findings.
  //   'off'      — gate only fails on system errors (timeout, crash)
  //   'all'      — gate fails on any finding
  //   'warning'  — gate fails on warnings and above
  //   'critical' — gate fails only on critical issues
  gate_threshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),
});

export type CodeReviewAgentConfig = z.infer<typeof CodeReviewAgentConfigSchema>;

// --- Security types ---

export const DependabotAlertState = {
  OPEN: 'open',
  FIXED: 'fixed',
  DISMISSED: 'dismissed',
  AUTO_DISMISSED: 'auto_dismissed',
} as const;

export type DependabotAlertState = (typeof DependabotAlertState)[keyof typeof DependabotAlertState];

export const SecuritySeverity = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;

export type SecuritySeverity = (typeof SecuritySeverity)[keyof typeof SecuritySeverity];

export type DependabotAlertRaw = {
  number: number;
  state: DependabotAlertState;
  dependency: {
    package: {
      ecosystem: string;
      name: string;
    };
    manifest_path: string;
    scope: 'development' | 'runtime' | null;
  };
  security_advisory: {
    ghsa_id: string;
    cve_id: string | null;
    summary: string;
    description: string;
    severity: SecuritySeverity;
    cvss?: {
      score: number;
      vector_string: string;
    };
    cwes?: Array<{
      cwe_id: string;
      name: string;
    }>;
  };
  security_vulnerability: {
    vulnerable_version_range: string;
    first_patched_version?: {
      identifier: string;
    };
  };
  created_at: string;
  updated_at: string;
  fixed_at: string | null;
  dismissed_at: string | null;
  dismissed_by?: {
    login: string;
  } | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  auto_dismissed_at?: string | null;
  html_url: string;
  url: string;
};

export type SecurityFindingTriage = {
  needsSandboxAnalysis: boolean;
  needsSandboxReasoning: string;
  suggestedAction: 'dismiss' | 'analyze_codebase' | 'manual_review';
  confidence: 'high' | 'medium' | 'low';
  triageAt: string;
};

export const SandboxSuggestedAction = {
  DISMISS: 'dismiss',
  OPEN_PR: 'open_pr',
  MANUAL_REVIEW: 'manual_review',
  MONITOR: 'monitor',
} as const;

export type SandboxSuggestedAction =
  (typeof SandboxSuggestedAction)[keyof typeof SandboxSuggestedAction];

export type SecurityFindingSandboxAnalysis = {
  isExploitable: boolean | 'unknown';
  exploitabilityReasoning: string;
  usageLocations: string[];
  suggestedFix: string;
  suggestedAction: SandboxSuggestedAction;
  summary: string;
  rawMarkdown: string;
  analysisAt: string;
  modelUsed?: string;
};

export type SecurityFindingAnalysis = {
  triage?: SecurityFindingTriage;
  sandboxAnalysis?: SecurityFindingSandboxAnalysis;
  rawMarkdown?: string;
  analyzedAt: string;
  modelUsed?: string;
  triageModel?: string;
  analysisModel?: string;
  triggeredByUserId?: string;
  correlationId?: string;
};

// --- OpenRouter types ---

export type OpenRouterIcon = z.infer<typeof OpenRouterIcon>;
export const OpenRouterIcon = z.object({
  url: z.string(),
  className: z.string().optional(),
});

export type OpenRouterDataPolicy = z.infer<typeof OpenRouterDataPolicy>;
export const OpenRouterDataPolicy = z.object({
  training: z.boolean(),
  retainsPrompts: z.boolean(),
  canPublish: z.boolean(),
  termsOfServiceURL: z.string().optional(),
  privacyPolicyURL: z.string().optional(),
  requiresUserIDs: z.boolean().optional(),
});

export type OpenRouterReasoningConfig = z.infer<typeof OpenRouterReasoningConfig>;
export const OpenRouterReasoningConfig = z.object({
  start_token: z.string().nullish(),
  end_token: z.string().nullish(),
  system_prompt: z.string().nullish(),
});

export type OpenRouterToolChoiceSupport = z.infer<typeof OpenRouterToolChoiceSupport>;
export const OpenRouterToolChoiceSupport = z.object({
  literal_none: z.boolean(),
  literal_auto: z.boolean(),
  literal_required: z.boolean(),
  type_function: z.boolean(),
});

export type OpenRouterSupportedParameters = z.infer<typeof OpenRouterSupportedParameters>;
export const OpenRouterSupportedParameters = z
  .object({
    response_format: z.boolean().optional(),
    structured_outputs: z.boolean().optional(),
  })
  .catchall(z.unknown());

export type OpenRouterFeatures = z.infer<typeof OpenRouterFeatures>;
export const OpenRouterFeatures = z
  .object({
    reasoning_config: OpenRouterReasoningConfig.optional(),
    supports_implicit_caching: z.boolean().optional(),
    supports_file_urls: z.boolean().optional(),
    supports_input_audio: z.boolean().optional(),
    supports_tool_choice: OpenRouterToolChoiceSupport.optional(),
    supported_parameters: OpenRouterSupportedParameters.optional(),
  })
  .catchall(z.unknown());

export type OpenRouterPricing = z.infer<typeof OpenRouterPricing>;
export const OpenRouterPricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  image: z.string().optional(),
  request: z.string().optional(),
  web_search: z.string().optional(),
  internal_reasoning: z.string().optional(),
  image_output: z.string().optional(),
  discount: z.number(),
  input_cache_read: z.string().optional(),
});

export type OpenRouterProviderInfo = z.infer<typeof OpenRouterProviderInfo>;
export const OpenRouterProviderInfo = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  baseUrl: z.string(),
  dataPolicy: OpenRouterDataPolicy,
  headquarters: z.string().optional(),
  hasChatCompletions: z.boolean(),
  hasCompletions: z.boolean(),
  isAbortable: z.boolean(),
  moderationRequired: z.boolean(),
  editors: z.array(z.string()),
  owners: z.array(z.string()),
  adapterName: z.string(),
  isMultipartSupported: z.boolean().optional(),
  statusPageUrl: z.string().nullable(),
  byokEnabled: z.boolean(),
  icon: OpenRouterIcon.optional(),
  ignoredProviderModels: z.array(z.string()),
});

export type OpenRouterBaseModel = z.infer<typeof OpenRouterBaseModel>;
export const OpenRouterBaseModel = z.object({
  slug: z.string(),
  hf_slug: z
    .string()
    .nullable()
    .transform(val => (val === '' ? null : val)),
  updated_at: z.string(),
  created_at: z.string(),
  hf_updated_at: z.string().nullable(),
  name: z.string(),
  short_name: z.string(),
  author: z.string(),
  description: z.string(),
  model_version_group_id: z.string().nullable(),
  context_length: z.number(),
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  has_text_output: z.boolean(),
  group: z.string(),
  instruct_type: z.string().nullable(),
  default_system: z.string().nullable(),
  default_stops: z.array(z.string()),
  hidden: z.boolean(),
  router: z.string().nullable(),
  warning_message: z
    .string()
    .nullable()
    .transform(val => (val === '' ? null : val)),
  permaslug: z.string(),
  reasoning_config: OpenRouterReasoningConfig.nullable(),
  features: OpenRouterFeatures.nullable(),
  default_parameters: z.record(z.string(), z.unknown()).nullable(),
});

export type OpenRouterEndpoint = z.infer<typeof OpenRouterEndpoint>;
export const OpenRouterEndpoint = z.object({
  id: z.string(),
  name: z.string(),
  context_length: z.number(),
  model: OpenRouterBaseModel,
  model_variant_slug: z.string(),
  model_variant_permaslug: z.string(),
  adapter_name: z.string(),
  provider_name: z.string(),
  provider_info: OpenRouterProviderInfo,
  provider_display_name: z.string(),
  provider_slug: z.string(),
  provider_model_id: z.string(),
  quantization: z.string().nullable(),
  variant: z.string(),
  is_free: z.boolean(),
  can_abort: z.boolean(),
  max_prompt_tokens: z.number().nullable(),
  max_completion_tokens: z.number().nullable(),
  max_tokens_per_image: z.number().nullable(),
  supported_parameters: z.array(z.string()),
  is_byok: z.boolean(),
  moderation_required: z.boolean(),
  data_policy: OpenRouterDataPolicy,
  pricing: OpenRouterPricing,
  variable_pricings: z.array(z.unknown()),
  is_hidden: z.boolean(),
  is_deranked: z.boolean(),
  is_disabled: z.boolean(),
  supports_tool_parameters: z.boolean(),
  supports_reasoning: z.boolean(),
  supports_multipart: z.boolean(),
  limit_rpm: z.number().nullable(),
  limit_rpd: z.number().nullable(),
  limit_rpm_cf: z.number().nullable(),
  has_completions: z.boolean(),
  has_chat_completions: z.boolean(),
  features: OpenRouterFeatures.nullable(),
  provider_region: z.string().nullable(),
});

export type OpenRouterModel = z.infer<typeof OpenRouterModel>;
export const OpenRouterModel = OpenRouterBaseModel.extend({
  endpoint: OpenRouterEndpoint.nullable(),
});

export type OpenRouterAnalyticsEntry = z.infer<typeof OpenRouterAnalyticsEntry>;
export const OpenRouterAnalyticsEntry = z.object({
  date: z.string(),
  model_permaslug: z.string(),
  variant: z.string(),
  variant_permaslug: z.string(),
  count: z.number(),
  total_completion_tokens: z.number(),
  total_prompt_tokens: z.number(),
  total_native_tokens_reasoning: z.number(),
  num_media_prompt: z.number(),
  num_media_completion: z.number(),
  total_native_tokens_cached: z.number(),
  total_tool_calls: z.number(),
});

export type OpenRouterAnalytics = z.infer<typeof OpenRouterAnalytics>;
export const OpenRouterAnalytics = z.record(z.string(), OpenRouterAnalyticsEntry);

export type OpenRouterCategoryEntry = z.infer<typeof OpenRouterCategoryEntry>;
export const OpenRouterCategoryEntry = z.object({
  id: z.number().optional(),
  date: z.string(),
  model: z.string(),
  category: z.string(),
  count: z.number(),
  total_prompt_tokens: z.number(),
  total_completion_tokens: z.number(),
  volume: z.number(),
  rank: z.number(),
});

export type OpenRouterCategories = z.infer<typeof OpenRouterCategories>;
export const OpenRouterCategories = z.record(z.string(), z.array(OpenRouterCategoryEntry));

export type OpenRouterSearchResponse = z.infer<typeof OpenRouterSearchResponse>;
export const OpenRouterSearchResponse = z.object({
  data: z.object({
    models: z.array(OpenRouterModel),
    analytics: OpenRouterAnalytics,
    categories: OpenRouterCategories,
  }),
});

export type OpenRouterProvider = z.infer<typeof OpenRouterProvider>;
export const OpenRouterProvider = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  baseUrl: z.string(),
  dataPolicy: z.object({
    training: z.boolean(),
    trainingOpenRouter: z.boolean().optional(),
    retainsPrompts: z.boolean(),
    canPublish: z.boolean(),
    termsOfServiceURL: z.string().optional(),
    privacyPolicyURL: z.string().optional(),
    requiresUserIDs: z.boolean().optional(),
    retentionDays: z.number().optional(),
  }),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  hasChatCompletions: z.boolean(),
  hasCompletions: z.boolean(),
  isAbortable: z.boolean(),
  moderationRequired: z.boolean(),
  editors: z.array(z.string()),
  owners: z.array(z.string()),
  adapterName: z.string(),
  isMultipartSupported: z.boolean().optional(),
  statusPageUrl: z.string().nullable(),
  byokEnabled: z.boolean(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
  ignoredProviderModels: z.array(z.string()),
});

export type OpenRouterProvidersResponse = z.infer<typeof OpenRouterProvidersResponse>;
export const OpenRouterProvidersResponse = z.union([
  z.object({
    data: z.array(OpenRouterProvider),
  }),
  z.array(OpenRouterProvider),
]);

export type NormalizedProvider = z.infer<typeof NormalizedProvider>;
export const NormalizedProvider = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  dataPolicy: z.object({
    training: z.boolean(),
    retainsPrompts: z.boolean(),
    canPublish: z.boolean(),
  }),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
  models: z.array(OpenRouterModel),
});

export type NormalizedOpenRouterResponse = z.infer<typeof NormalizedOpenRouterResponse>;
export const NormalizedOpenRouterResponse = z.object({
  providers: z.array(NormalizedProvider),
  total_providers: z.number(),
  total_models: z.number(),
  generated_at: z.string(),
});

// --- Model settings ---

export const ToolSchema = z.enum([
  'apply_diff',
  'apply_patch',
  'delete_file',
  'edit_file',
  'search_replace',
  'search_and_replace',
  'write_file',
  'write_to_file',
]);

export type Tool = z.infer<typeof ToolSchema>;

export const ToolArraySchema = z.array(ToolSchema);

export const ModelSettingsSchema = z.object({
  included_tools: ToolArraySchema,
  excluded_tools: ToolArraySchema,
});

export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const VersionedSettingsSchema = z.record(z.string(), ModelSettingsSchema);

export type VersionedSettings = z.infer<typeof VersionedSettingsSchema>;

export const OpenCodePromptSchema = z.enum([
  'codex',
  'gemini',
  'beast',
  'anthropic',
  'trinity',
  'anthropic_without_todo',
]);

export type OpenCodePrompt = z.infer<typeof OpenCodePromptSchema>;

export const OpenCodeFamilySchema = z.enum(['claude', 'gpt', 'gemini', 'llama', 'mistral']);

export type OpenCodeFamily = z.infer<typeof OpenCodeFamilySchema>;

export const VerbositySchema = z.enum(['low', 'medium', 'high', 'max']);

export type Verbosity = z.infer<typeof VerbositySchema>;

export const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const CustomLlmProviderSchema = z.enum([
  'anthropic', // uses Messages API
  'openai', // uses Responses API
  'openai-compatible', // uses Chat Completions API with reasoning_content
  'openrouter', // uses Chat Completions API with reasoning_details
]);

export type CustomLlmProvider = z.infer<typeof CustomLlmProviderSchema>;

export const OpenCodeVariantSchema = z.object({
  verbosity: VerbositySchema.optional(),
  reasoning: z
    .object({
      enabled: z.boolean().optional(),
      effort: ReasoningEffortSchema.optional(),
    })
    .optional(),
});

export type OpenCodeVariant = z.infer<typeof OpenCodeVariantSchema>;

export const OpenCodeSettingsSchema = z.object({
  ai_sdk_provider: CustomLlmProviderSchema.optional(),
  family: OpenCodeFamilySchema.optional(),
  prompt: OpenCodePromptSchema.optional(),
  variants: z.record(z.string(), OpenCodeVariantSchema).optional(),
});

export type OpenCodeSettings = z.infer<typeof OpenCodeSettingsSchema>;

export const OpenClawApiAdapterSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);

export type OpenClawApiAdapter = z.infer<typeof OpenClawApiAdapterSchema>;

export const OpenClawModelSettingsSchema = z.object({
  api_adapter: OpenClawApiAdapterSchema.optional(),
});

export type OpenClawModelSettings = z.infer<typeof OpenClawModelSettingsSchema>;

export const InterleavedFormatSchema = z.enum(['reasoning_content', 'think']);

export type InterleavedFormat = z.infer<typeof InterleavedFormatSchema>;

export const CustomLlmExtraBodySchema = z.record(z.string(), z.any());

export type CustomLlmExtraBody = z.infer<typeof CustomLlmExtraBodySchema>;

export const CustomLlmExtraHeadersSchema = z.record(z.string(), z.string());

export type CustomLlmExtraHeaders = z.infer<typeof CustomLlmExtraHeadersSchema>;

// All price fields are in dollars per token (e.g. "0.000001" = $1 per million tokens),
// matching the OpenRouter pricing convention.
export const CustomLlmPricingSchema = z.object({
  prompt: z.string(),
  completion: z.string(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
});

export type CustomLlmPricing = z.infer<typeof CustomLlmPricingSchema>;

export const CustomLlmDefinitionSchema = z
  .object({
    internal_id: z.string(),
    display_name: z.string(),
    context_length: z.number(),
    max_completion_tokens: z.number(),
    base_url: z.string(),
    api_key: z.string(),
    organization_ids: z.array(z.string()),
    supports_image_input: z.boolean().optional(),
    add_cache_breakpoints: z.boolean().optional(),
    inject_reasoning_into_content: z.boolean().optional(),
    reasoning_summary: z.enum(['auto', 'concise', 'detailed']).optional(),
    extra_headers: CustomLlmExtraHeadersSchema.optional(),
    extra_body: CustomLlmExtraBodySchema.optional(),
    remove_from_body: z.array(z.string()).optional(),
    opencode_settings: OpenCodeSettingsSchema.optional(),
    openclaw_settings: OpenClawModelSettingsSchema.optional(),
    pricing: CustomLlmPricingSchema.optional(),
  })
  .strict();

export type CustomLlmDefinition = z.infer<typeof CustomLlmDefinitionSchema>;

// --- StoredModel ---

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['language', 'embedding', 'image']).optional().catch(undefined),
});

export const ModelsSchema = z.object({ data: z.array(ModelSchema) });

export const EndpointSchema = z.object({
  provider_name: z.string(),
  tag: z.string(),
  context_length: z.number(),
});

export const EndpointsSchema = z.object({
  data: z.object({ endpoints: z.array(EndpointSchema) }),
});

export const StoredModelSchema = ModelSchema.and(
  z.object({
    endpoints: z.array(EndpointSchema),
  })
);

export type StoredModel = z.infer<typeof StoredModelSchema>;

// =============================================================================
// C. Stripe type (inline)
// =============================================================================

export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

// --- Code review terminal reasons ---

/**
 * Valid values for cloud_agent_code_reviews.terminal_reason.
 * KEEP IN SYNC with CloudAgentTerminalReason in
 * packages/worker-utils/src/cloud-agent-next-client.ts — both lists must
 * contain the same literal values.
 */
export const CODE_REVIEW_TERMINAL_REASONS = [
  'billing',
  'user_cancelled',
  'superseded',
  'interrupted',
  'timeout',
  'upstream_error',
  'unknown',
] as const;

export type CodeReviewTerminalReason = (typeof CODE_REVIEW_TERMINAL_REASONS)[number];
