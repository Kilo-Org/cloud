declare type Hyperdrive = {
  connectionString: string;
};

declare type SecretBinding = {
  get(): Promise<string>;
};

declare type ScheduledController = {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
};

declare type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

declare type PromotionRecord = import('./src/types').PromotionRecord;

declare type BenchDashboardService = {
  listPromotions(opts?: { sinceMs?: number; limit?: number }): Promise<PromotionRecord[]>;
  getPromotion(name: string): Promise<PromotionRecord | null>;
};

declare type CloudflareEnv = {
  HYPERDRIVE: Hyperdrive;
  BENCH_DASHBOARD: BenchDashboardService;
  INTERNAL_API_SECRET: SecretBinding | string;
  BETTERSTACK_HEARTBEAT_URL: string | undefined;
};
