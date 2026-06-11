import * as z from 'zod';
import { ClassifierApiKindSchema } from './routing-table';
import { DifficultyTierSchema } from './tiers';

export const BenchmarkKindSchema = z.enum(['classifier', 'decider']);
export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>;

export const BenchmarkDeciderModelSchema = z.object({
  id: z.string().trim().min(1),
  // Which gateway API kinds this model can serve when chosen by the router.
  // The benchmark itself always exercises chat completions.
  supportedApiKinds: z.array(ClassifierApiKindSchema).min(1).default(['chat_completions']),
});
export type BenchmarkDeciderModel = z.infer<typeof BenchmarkDeciderModelSchema>;

export const BenchmarkConfigSchema = z.object({
  classifierModels: z.array(z.string().trim().min(1)).min(1),
  deciderModels: z.array(BenchmarkDeciderModelSchema).min(1),
  // Accuracy threshold for "gets the job done" (per tier).
  minAccuracy: z.number().min(0).max(1),
  // Parallel OpenRouter calls per queue message.
  maxConcurrency: z.number().int().min(1).max(16),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

export const BenchmarkRunStatusSchema = z.enum(['running', 'completed', 'failed']);

export const BenchmarkModelSummarySchema = z.object({
  model: z.string(),
  // '*' for classifier runs (no tiering), otherwise the difficulty tier.
  tier: z.union([DifficultyTierSchema, z.literal('*')]),
  accuracy: z.number(),
  avgCostUsd: z.number().nullable(),
  avgLatencyMs: z.number(),
  p50LatencyMs: z.number().nullable(),
  cases: z.number().int(),
  errors: z.number().int(),
});
export type BenchmarkModelSummary = z.infer<typeof BenchmarkModelSummarySchema>;

export const BenchmarkRunSchema = z.object({
  id: z.string(),
  kind: BenchmarkKindSchema,
  status: BenchmarkRunStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  summaries: z.array(BenchmarkModelSummarySchema),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

export const BenchmarkRunsResponseSchema = z.object({ runs: z.array(BenchmarkRunSchema) });
export const BenchmarkConfigResponseSchema = z.object({
  config: BenchmarkConfigSchema,
  defaults: BenchmarkConfigSchema,
});
export const StartBenchmarkRunRequestSchema = z.object({ kind: BenchmarkKindSchema });
export const StartBenchmarkRunResponseSchema = z.object({
  runId: z.string(),
  enqueuedModels: z.number().int(),
});
