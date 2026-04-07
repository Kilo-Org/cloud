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
] as const;

export const BILLING_QUEUE_MAX_RETRIES = 3;

export type BillingSweepKind = (typeof BILLING_SWEEP_ORDER)[number];

export type BillingSweepMessage = {
  runId: string;
  sweep: BillingSweepKind;
};

export type ServiceFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type BillingWorkerEnv = {
  HYPERDRIVE: { connectionString: string };
  LIFECYCLE_QUEUE: Queue<BillingSweepMessage>;
  KILOCLAW: ServiceFetcher;
  KILOCODE_BACKEND_BASE_URL: string;
  INTERNAL_API_SECRET?: string;
  KILOCLAW_INTERNAL_API_SECRET?: string;
};
