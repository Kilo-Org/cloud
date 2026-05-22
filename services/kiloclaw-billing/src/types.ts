export const BILLING_HOURLY_CRON = '0 * * * *';
export const INSTANCE_DESTRUCTION_QUARTER_HOURLY_CRON = '5,20,35,50 * * * *';
export const TRIAL_INACTIVITY_DAILY_CRON = '0 8 * * *';
export const TRIAL_INACTIVITY_SWEEP = 'trial_inactivity_stop' as const;
export const TRIAL_INACTIVITY_STOP_CANDIDATE_SWEEP = 'trial_inactivity_stop_candidate' as const;

export const BILLING_SWEEP_ORDER = [
  'credit_renewal',
  'interrupted_auto_resume',
  'trial_expiry',
  'organization_trial_expiry',
  'subscription_expiry',
  'instance_destruction',
  'past_due_cleanup',
  'intro_schedule_repair',
  'destruction_warning',
  'trial_warning',
  'earlybird_warning',
  'complementary_inference_ended',
] as const;

export const BILLING_QUEUE_MAX_RETRIES = 3;

export type BillingSweepKind = (typeof BILLING_SWEEP_ORDER)[number];
export type TrialInactivitySweepKind =
  | typeof TRIAL_INACTIVITY_SWEEP
  | typeof TRIAL_INACTIVITY_STOP_CANDIDATE_SWEEP;
export type CreditRenewalMessageSweep =
  | 'credit_renewal_discovery'
  | 'credit_renewal_item'
  | 'credit_renewal_terminal_failure';
export type BillingMessageSweep =
  | BillingSweepKind
  | TrialInactivitySweepKind
  | CreditRenewalMessageSweep;

export type LifecycleQueueMessage = {
  kind: 'lifecycle';
  runId: string;
  sweep: BillingSweepKind;
};

export type StandaloneInstanceDestructionQueueMessage = {
  kind: 'standalone_instance_destruction';
  runId: string;
  sweep: 'instance_destruction';
};

export type CreditRenewalDiscoveryQueueMessage = {
  kind: 'credit_renewal_discovery';
  runId: string;
  sweep: 'credit_renewal_discovery';
  cutoffTime?: string;
  cursorSubscriptionId?: string;
  cursorRenewalBoundary?: string;
  pageBudget?: number;
  wallClockBudgetMs?: number;
};

export type CreditRenewalDiscoveryContinuationQueueMessage = {
  kind: 'credit_renewal_discovery_continuation';
  runId: string;
  sweep: 'credit_renewal_discovery';
  cutoffTime: string;
  cursorSubscriptionId: string;
  cursorRenewalBoundary: string;
  pageBudget?: number;
  wallClockBudgetMs?: number;
};

export type CreditRenewalItemQueueMessage = {
  kind: 'credit_renewal_item';
  runId: string;
  sweep: 'credit_renewal_item';
  subscriptionId: string;
  userId?: string;
  renewalBoundary: string;
  discoveredAt?: string;
  resolveTerminalFailureOnExpectedOutcome?: boolean;
  diagnostics?: {
    instanceId: string | null;
    plan: string;
    status: string;
  };
};

export type CreditRenewalTerminalFailureQueueMessage = {
  kind: 'credit_renewal_terminal_failure';
  runId: string;
  sweep: 'credit_renewal_terminal_failure';
  subscriptionId: string;
  renewalBoundary: string;
  attempts: number;
  failureMessage?: string;
};

export type CreditRenewalQueueMessage =
  | CreditRenewalDiscoveryQueueMessage
  | CreditRenewalDiscoveryContinuationQueueMessage
  | CreditRenewalItemQueueMessage
  | CreditRenewalTerminalFailureQueueMessage;

export type TrialExpiryPageQueueMessage = {
  kind: 'trial_expiry_page';
  runId: string;
  sweep: 'trial_expiry';
  cutoffTime?: string;
  cursorSubscriptionId?: string;
  cursorTrialEndsAt?: string;
  pageBudget?: number;
  wallClockBudgetMs?: number;
};

export type TrialExpiryContinuationQueueMessage = {
  kind: 'trial_expiry_continuation';
  runId: string;
  sweep: 'trial_expiry';
  cutoffTime: string;
  cursorSubscriptionId: string;
  cursorTrialEndsAt: string;
  pageBudget?: number;
  wallClockBudgetMs?: number;
};

export type TrialExpiryQueueMessage =
  | TrialExpiryPageQueueMessage
  | TrialExpiryContinuationQueueMessage;

export type OrganizationTrialExpiryPageQueueMessage = {
  kind: 'organization_trial_expiry_page';
  runId: string;
  sweep: 'organization_trial_expiry';
  cutoffTime?: string;
  cursorSubscriptionId?: string;
  cursorHardExpiryBoundary?: string;
  pageBudget?: number;
  wallClockBudgetMs?: number;
};

export type OrganizationTrialExpiryContinuationQueueMessage = {
  kind: 'organization_trial_expiry_continuation';
  runId: string;
  sweep: 'organization_trial_expiry';
  cutoffTime: string;
  cursorSubscriptionId: string;
  cursorHardExpiryBoundary: string;
  pageBudget?: number;
  wallClockBudgetMs?: number;
};

export type OrganizationTrialExpiryQueueMessage =
  | OrganizationTrialExpiryPageQueueMessage
  | OrganizationTrialExpiryContinuationQueueMessage;

export type LifecycleProducerQueueMessage =
  | LifecycleQueueMessage
  | StandaloneInstanceDestructionQueueMessage
  | CreditRenewalQueueMessage
  | TrialExpiryQueueMessage
  | OrganizationTrialExpiryQueueMessage;

export type TrialInactivityKickoffQueueMessage = {
  kind: 'trial_inactivity_stop';
  runId: string;
  sweep: typeof TRIAL_INACTIVITY_SWEEP;
};

export type TrialInactivityStopCandidateQueueMessage = {
  kind: 'trial_inactivity_stop_candidate';
  runId: string;
  sweep: typeof TRIAL_INACTIVITY_STOP_CANDIDATE_SWEEP;
  subscriptionId: string;
  userId: string;
  instanceId: string;
};

export type TrialInactivityQueueMessage =
  | TrialInactivityKickoffQueueMessage
  | TrialInactivityStopCandidateQueueMessage;

export type BillingQueueMessage =
  | LifecycleQueueMessage
  | StandaloneInstanceDestructionQueueMessage
  | CreditRenewalQueueMessage
  | TrialExpiryQueueMessage
  | OrganizationTrialExpiryQueueMessage
  | TrialInactivityQueueMessage;

export type ServiceFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type BillingWorkerEnv = {
  HYPERDRIVE: { connectionString: string };
  LIFECYCLE_QUEUE: Queue<LifecycleProducerQueueMessage>;
  TRIAL_INACTIVITY_QUEUE: Queue<TrialInactivityQueueMessage>;
  KILOCLAW: ServiceFetcher;
  KILOCODE_BACKEND_BASE_URL: string;
  STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID: string;
  STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID: string;
  STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID: string;
  STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID: string;
  STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID: string;
  INTERNAL_API_SECRET?: string;
  TRIAL_INACTIVITY_STOP_ENABLED?: string;
  TRIAL_INACTIVITY_STOP_DRY_RUN?: string;
  SNOWFLAKE_ACCOUNT_HOST?: string;
  SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER?: string;
  SNOWFLAKE_USERNAME?: string;
  SNOWFLAKE_ROLE?: string;
  SNOWFLAKE_WAREHOUSE?: string;
  SNOWFLAKE_DATABASE?: string;
  SNOWFLAKE_SCHEMA?: string;
  SNOWFLAKE_PRIVATE_KEY_PEM?: string;
  SNOWFLAKE_PUBLIC_KEY_FINGERPRINT?: string;
};
