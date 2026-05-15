import * as z from 'zod';

export const PromotionRecordSchema = z.object({
  bench_eval_name: z.string().min(1),
  bench_eval_url: z.string().url(),
  provider: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().nullable(),
  task_source: z.string().min(1),
  n_total_trials: z.number().int().nonnegative(),
  total_score: z.number().finite(),
  overall_score: z.number().finite(),
  n_errored: z.number().int().nonnegative(),
  avg_cost_usd: z.number().finite().nullable(),
  avg_input_tokens: z.number().finite().nullable(),
  avg_output_tokens: z.number().finite().nullable(),
  avg_cache_read_tokens: z.number().finite().nullable(),
  avg_execution_ms: z.number().finite().nullable(),
  promoted_at: z.number().int().nonnegative(),
  promoted_by_email: z.string().min(1),
  promotion_note: z.string().nullable(),
});

export type PromotionRecord = z.infer<typeof PromotionRecordSchema>;

export type KiloBenchEval = {
  taskSource: string;
  overallScore: number;
  totalScore: number;
  avgCostUsd: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgCacheReadTokens: number | null;
  avgExecutionMs: number | null;
  nTotalTrials: number;
  nErrored: number;
  lastPromotedAt: string;
};

export type KiloBenchBenchmarks = {
  overallScore: number;
  evals: Record<string, KiloBenchEval>;
};

export type LatestPromotion = {
  taskSource: string;
  totalScore: number;
  overallScore: number;
  avgCostMicrodollars: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgCacheReadTokens: number | null;
  avgExecutionMs: number | null;
  nTotalTrials: number;
  nErrored: number;
  promotedAt: string;
};

export type ModelStatsTarget = {
  id: string;
  model: string;
};

export type PromotionTuple = {
  provider: string;
  model: string;
  variant: string | null;
  modelStatsId: string;
};

export type SyncResult = {
  inserted: number;
  alreadyHad: number;
  cacheRecomputes: number;
  fetched: number;
};
