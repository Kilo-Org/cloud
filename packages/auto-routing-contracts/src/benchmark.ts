import * as z from 'zod';
import { ClassifierApiKindSchema, RoutingTableSchema } from './routing-table';
import { DifficultyTierSchema } from './tiers';

export const BenchmarkKindSchema = z.enum(['classifier', 'decider']);
export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>;

export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const BenchmarkDeciderModelSchema = z.object({
  id: z.string().trim().min(1),
  // Which gateway API kinds this model can serve when chosen by the router.
  // The benchmark itself always exercises chat completions.
  supportedApiKinds: z.array(ClassifierApiKindSchema).min(1).default(['chat_completions']),
  // Passed to the kilo CLI as --variant during the benchmark and carried into
  // the routing table so serving uses the same effort the model was graded
  // with. Null for models without (or not using) configurable reasoning.
  reasoningEffort: ReasoningEffortSchema.nullable().default(null),
});
export type BenchmarkDeciderModel = z.infer<typeof BenchmarkDeciderModelSchema>;

export const BenchmarkConfigSchema = z.object({
  classifierModels: z.array(z.string().trim().min(1)).min(1),
  deciderModels: z.array(BenchmarkDeciderModelSchema).min(1),
  // Accuracy threshold for "gets the job done" (per tier).
  minAccuracy: z.number().min(0).max(1),
  // Parallel OpenRouter calls per queue message.
  maxConcurrency: z.number().int().min(1).max(16),
  // The Kilo user whose identity/billing the decider CLI runs execute under.
  // Null until an admin configures it; decider runs fail fast while null.
  benchmarkUserId: z.string().trim().min(1).nullable(),
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
export const StartBenchmarkRunRequestSchema = z.object({
  kind: BenchmarkKindSchema,
  // Re-run every configured model even when prior results exist.
  force: z.boolean().default(false),
});
export const StartBenchmarkRunResponseSchema = z.object({
  runId: z.string(),
  enqueuedModels: z.number().int(),
  skippedModels: z.array(z.string()).default([]),
});

export const BenchmarkRoutingTableResponseSchema = z.object({
  table: RoutingTableSchema.nullable(),
  publishedAt: z.string().nullable(),
});
export type BenchmarkRoutingTableResponse = z.infer<typeof BenchmarkRoutingTableResponseSchema>;

// Published to the auto-routing KV namespace when a classifier benchmark run
// completes: the cheapest candidate meeting the accuracy threshold.
export const ClassifierWinnerSchema = z.object({
  model: z.string().trim().min(1),
  runId: z.string(),
  accuracy: z.number(),
  generatedAt: z.string(),
});
export type ClassifierWinner = z.infer<typeof ClassifierWinnerSchema>;

export const CLASSIFIER_WINNER_KV_KEY = 'classifier_benchmark_winner';
