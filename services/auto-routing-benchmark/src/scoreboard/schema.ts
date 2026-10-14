import * as z from 'zod';
import {
  CandidatePricingSchema,
  EffortByComplexitySchema,
  ProductionTokenProfileSchema,
  RankedCandidateSchema,
  RoutingTableSchema,
} from '@kilocode/auto-routing-contracts';

const nullableMetric = z.number().nonnegative().nullable();
const nullableRate = z.number().min(0).max(1).nullable();
const routeMixSchema = z.record(z.string(), z.number().min(0).max(1));
const perRequestUsdSchema = z.object({ mean: nullableMetric, p50: nullableMetric });

export const DistSchema = z.object({
  n: z.number().int().nonnegative(),
  p50: nullableMetric,
  p90: nullableMetric,
  p99: nullableMetric,
});
export type Dist = z.infer<typeof DistSchema>;

export const ProdMetricsSchema = z.object({
  kind: z.literal('prod'),
  window: z.object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  }),
  gatewayDecideMs: DistSchema.nullable(),
  workerDecideMs: DistSchema.nullable(),
  workerPhasesMs: z.record(z.string(), DistSchema).nullable(),
  cacheHitRate: nullableRate,
  classifierPerRequestUsd: nullableMetric,
  switchRate: nullableRate,
  routeMix: routeMixSchema,
  modelTtftMs: DistSchema.nullable(),
  prodPerRequestUsd: perRequestUsdSchema,
  prodCacheReadShare: nullableRate,
});
export type ProdMetrics = z.infer<typeof ProdMetricsSchema>;

const replayScenariosSchema = z.object({
  cold: DistSchema.extend({
    errors: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  warm_new_turn: DistSchema.extend({
    errors: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  exact_repeat: DistSchema.extend({
    errors: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
});
export const ReplayMetricsSchema = z.object({
  kind: z.literal('replay'),
  target: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  sessions: z.number().int().nonnegative(),
  turnGapMs: z.number().nonnegative().optional(),
  scenarios: replayScenariosSchema,
});
export type ReplayMetrics = z.infer<typeof ReplayMetricsSchema>;

export const OfflineSweepSummarySchema = z.object({
  model: z.string().trim().min(1),
  variant: z.string().trim().min(1).nullable(),
  routeKey: z.string().min(1),
  split: z.enum(['train', 'heldOut']),
  accuracy: z.number().min(0).max(1).nullable(),
  cases: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative().optional(),
  avgCostUsd: z.number().nonnegative().nullable(),
  p50LatencyMs: z.number().nonnegative().nullable(),
  p50TtftMs: nullableMetric.optional(),
});
export type OfflineSweepSummary = z.infer<typeof OfflineSweepSummarySchema>;

export const OfflineSweepSchema = z.object({
  startedAt: z.iso.datetime({ offset: true }),
  suite: z.enum(['efficient', 'frontier']).optional(),
  truncated: z.boolean(),
  costUsd: z.number().nonnegative(),
  graderCostUsd: z.number().nonnegative(),
  pairs: z.array(
    z.object({
      model: z.string().trim().min(1),
      variant: z.string().trim().min(1).nullable(),
      results: z.array(
        z.object({
          caseId: z.string().min(1),
          rep: z.number().int().nonnegative(),
          routeKey: z.string().min(1),
          split: z.enum(['train', 'heldOut']),
          score: z.number().min(0).max(1).nullable().default(null),
          costUsd: z.number().nonnegative().nullable().default(null),
          graderCostUsd: z.number().nonnegative(),
          latencyMs: z.number().nonnegative(),
          ttftMs: nullableMetric.optional(),
          error: z.string().nullable(),
          output: z.string().nullable().optional(),
        })
      ),
    })
  ),
  summaries: z.array(OfflineSweepSummarySchema),
});
export type OfflineSweep = z.infer<typeof OfflineSweepSchema>;

export const ScoreboardSchema = z.object({
  version: z.literal(1),
  label: z.string(),
  generatedAt: z.iso.datetime({ offset: true }),
  latency: z.object({
    routerOverheadMs: z.object({
      gateway: DistSchema.nullable(),
      worker: DistSchema.nullable(),
      replay: replayScenariosSchema.nullable(),
    }),
    workerPhasesMs: z.record(z.string(), DistSchema).nullable(),
    cacheHitRate: nullableRate,
    modelTtftMs: z.object({ prod: DistSchema.nullable(), benchmarkP50Weighted: nullableMetric }),
  }),
  cost: z.object({
    prodPerRequestUsd: perRequestUsdSchema,
    prodCacheReadShare: nullableRate,
    classifierPerRequestUsd: nullableMetric,
    switchRate: nullableRate,
    benchmarkPerTaskUsdWeighted: nullableMetric,
    estimatedRequestUsdWeighted: nullableMetric,
  }),
  quality: z.object({
    benchmarkAccuracyWeighted: nullableRate,
    classifierRouteAccuracy: nullableRate,
    heldOut: z
      .object({
        accuracyWeighted: nullableRate,
        estimatedRequestUsdWeighted: nullableMetric,
        p50LatencyMsWeighted: nullableMetric,
        p50TtftMsWeighted: nullableMetric.optional(),
        routes: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
  routeMix: routeMixSchema,
});
export type Scoreboard = z.infer<typeof ScoreboardSchema>;

const candidateWithLatencySchema = RankedCandidateSchema.safeExtend({
  p50LatencyMs: nullableMetric.optional(),
});
export const ScoreboardRoutingTableSchema = RoutingTableSchema.extend({
  routes: z
    .record(z.string(), z.array(candidateWithLatencySchema).min(1))
    .superRefine((routes, ctx) => {
      const parsed = RoutingTableSchema.shape.routes.safeParse(routes);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
        }
      }
    }),
});
export type ScoreboardRoutingTable = z.infer<typeof ScoreboardRoutingTableSchema>;

const storedJsonSchema = z.string().transform((value): unknown => JSON.parse(value));

export const LiveScoreboardTableRowSchema = z.object({
  run_id: z.string(),
  published_at: z.string(),
  generated_at: z.string(),
  min_accuracy: z.number(),
  switch_cost_factor: z.number(),
  best_accuracy_switch_threshold: z.number(),
  production_token_profile: storedJsonSchema
    .pipe(ProductionTokenProfileSchema)
    .nullish()
    .transform(value => value ?? null),
  switch_horizon_turns: z
    .number()
    .int()
    .positive()
    .nullish()
    .transform(value => value ?? null),
  low_confidence_threshold: nullableRate.optional().transform(value => value ?? null),
  effort_by_complexity: storedJsonSchema
    .pipe(EffortByComplexitySchema)
    .nullish()
    .transform(value => value ?? null),
  source: z.string(),
});

export const LiveScoreboardCandidateRowSchema = z.object({
  run_id: z.string(),
  route_key: z.string(),
  rank: z.number().int(),
  model: z.string(),
  accuracy: z.number(),
  avg_cost_usd: z.number(),
  meets_threshold: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform(value => Boolean(value)),
  reasoning_effort: z.string().nullable(),
  variant: z.string(),
  pricing: storedJsonSchema
    .pipe(CandidatePricingSchema)
    .nullish()
    .transform(value => value ?? null),
  estimated_request_cost_usd: nullableMetric.optional().transform(value => value ?? null),
  cases: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .transform(value => value ?? null),
  p50LatencyMs: nullableMetric,
});
