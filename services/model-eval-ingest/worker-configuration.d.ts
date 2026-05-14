declare type Hyperdrive = {
  connectionString: string;
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

declare type PromotionRecord = {
  bench_eval_name: string;
  bench_eval_url: string;
  provider: string;
  model: string;
  variant: string | null;
  task_source: string;
  n_total_trials: number;
  total_score: number;
  overall_score: number;
  n_errored: number;
  avg_cost_usd: number | null;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  avg_cache_read_tokens: number | null;
  avg_execution_ms: number | null;
  promoted_at: number;
  promoted_by_email: string;
  promotion_note: string | null;
};

declare type BenchDashboardBinding = {
  listPromotions(opts?: { sinceMs?: number; limit?: number }): Promise<PromotionRecord[]>;
  getPromotion(name: string): Promise<PromotionRecord | null>;
};

declare type CloudflareEnv = {
  HYPERDRIVE: Hyperdrive;
  BENCH_DASHBOARD: BenchDashboardBinding;
};
