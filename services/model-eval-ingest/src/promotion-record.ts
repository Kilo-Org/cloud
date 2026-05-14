import { z } from 'zod';

export const PromotionRecordSchema = z.object({
  bench_eval_name: z.string().min(1),
  bench_eval_url: z.string().url(),
  provider: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().nullable(),
  task_source: z.string().min(1),
  n_total_trials: z.number().int().nonnegative(),
  total_score: z.number(),
  overall_score: z.number(),
  n_errored: z.number().int().nonnegative(),
  avg_cost_usd: z.number().nullable(),
  avg_input_tokens: z.number().nullable(),
  avg_output_tokens: z.number().nullable(),
  avg_cache_read_tokens: z.number().nullable(),
  avg_execution_ms: z.number().nullable(),
  promoted_at: z.number().int().nonnegative(),
  promoted_by_email: z.string().email(),
  promotion_note: z.string().nullable(),
});

export const PromotionRecordsSchema = z.array(PromotionRecordSchema);

export type PromotionRecordInput = z.infer<typeof PromotionRecordSchema>;
