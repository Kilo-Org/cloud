export const BILLING_HOURLY_CRON = '0 * * * *';
export const TRIAL_INACTIVITY_DAILY_CRON = '0 8 * * *';
export const TRIAL_INACTIVITY_SWEEP = 'trial_inactivity_stop' as const;
export const TRIAL_INACTIVITY_STOP_CANDIDATE_SWEEP = 'trial_inactivity_stop_candidate' as const;

export const BILLING_SWEEP_ORDER = [
  'credit_renewal',
  'interrupted_auto_resume',
  'trial_expiry',
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
export type BillingMessageSweep = BillingSweepKind | TrialInactivitySweepKind;

export type LifecycleQueueMessage = {
  kind: 'lifecycle';
  runId: string;
  sweep: BillingSweepKind;
};

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

export type BillingQueueMessage = LifecycleQueueMessage | TrialInactivityQueueMessage;

export type ServiceFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type BillingWorkerEnv = {
  HYPERDRIVE: { connectionString: string };
  LIFECYCLE_QUEUE: Queue<LifecycleQueueMessage>;
  TRIAL_INACTIVITY_QUEUE: Queue<TrialInactivityQueueMessage>;
  KILOCLAW: ServiceFetcher;
  KILOCODE_BACKEND_BASE_URL: string;
  STRIPE_KILOCLAW_COMMIT_PRICE_ID: string;
  STRIPE_KILOCLAW_STANDARD_PRICE_ID: string;
  STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID: string;
  INTERNAL_API_SECRET?: string;
  KILOCLAW_INTERNAL_API_SECRET?: string;
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
