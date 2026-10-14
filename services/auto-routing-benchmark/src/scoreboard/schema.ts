import * as z from 'zod';
import { RankedCandidateSchema, RoutingTableSchema } from '@kilocode/auto-routing-contracts';

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

export const ShadowOutcomesSchema = z.record(
  z.string(),
  z.object({
    requests: z.number().int().nonnegative(),
    errorRate: nullableRate,
    abortRate: nullableRate,
    inputTokensPerRequest: nullableMetric,
    outputTokensPerRequest: nullableMetric,
    cacheReadTokensPerRequest: nullableMetric,
    costUsdPerRequest: nullableMetric,
  })
);

export const ShadowMetricsSchema = z.object({
  observedDecisions: z.number().int().nonnegative(),
  differsRate: nullableRate,
  outcomesByDecidedModel: ShadowOutcomesSchema.nullable(),
});
export type ShadowMetrics = z.infer<typeof ShadowMetricsSchema>;

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
  shadow: ShadowMetricsSchema.nullable().default(null),
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
  }),
  quality: z.object({
    benchmarkAccuracyWeighted: nullableRate,
    classifierRouteAccuracy: nullableRate,
    heldOut: z.null(),
  }),
  routeMix: routeMixSchema,
  shadow: ShadowMetricsSchema.nullable().default(null),
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
