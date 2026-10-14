import * as z from 'zod';
import { ReasoningEffortSchema } from './reasoning';
import { TaxonomyRouteKeySchema } from './taxonomy';

/** Maximum Pool entries in an owner-configured Efficient model pool. */
export const MAX_POOL_ENTRIES = 10;

export const PoolEntrySchema = z.object({
  model: z.string().trim().min(1),
});
export type PoolEntry = z.infer<typeof PoolEntrySchema>;

export const BenchmarkPairSchema = PoolEntrySchema.extend({
  variant: z.string().trim().min(1).nullable(),
});
export type BenchmarkPair = z.infer<typeof BenchmarkPairSchema>;

export function poolEntryKey(entry: PoolEntry): string {
  return JSON.stringify([entry.model]);
}

export function benchmarkPairKey(entry: BenchmarkPair): string {
  return JSON.stringify([entry.model, entry.variant]);
}

function addDuplicatePoolEntryIssues(entries: PoolEntry[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const key = poolEntryKey(entry);
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: `Duplicate pool entry: ${key}`,
      });
    }
    seen.add(key);
  });
}

/** Owner-configured pool of unique models; null inherits the platform pool. */
export const EfficientModelPoolSchema = z
  .array(PoolEntrySchema)
  .min(1)
  .max(MAX_POOL_ENTRIES)
  .superRefine((entries, ctx) => {
    addDuplicatePoolEntryIssues(entries, ctx);
  });
export type EfficientModelPool = z.infer<typeof EfficientModelPoolSchema>;

export const PersistedEfficientModelPoolSchema = z
  .array(PoolEntrySchema)
  .transform(entries => [...new Map(entries.map(entry => [entry.model, entry])).values()])
  .pipe(EfficientModelPoolSchema);

/**
 * Reader precedence for candidate variant identity: prefer `variant`; when
 * absent, a valid legacy `reasoningEffort` string may be interpreted as the
 * legacy variant key. New writers emit `variant` only; old writers emitted
 * `reasoningEffort` only. Both non-null is malformed.
 */
export const RankedCandidateSchema = z
  .object({
    model: z.string().trim().min(1),
    // Benchmark accuracy in [0, 1] for this taxonomy route.
    accuracy: z.number().min(0).max(1),
    // Average observed OpenRouter cost per benchmark case, in USD credits.
    avgCostUsd: z.number().nonnegative(),
    meetsThreshold: z.boolean(),
    // Canonical catalog variant key the model was benchmarked with.
    // Optional so tables published before this field existed stay valid.
    variant: z.string().trim().min(1).nullable().optional(),
    // Legacy effort the model was benchmarked with; retained for rolling
    // deploy reads of old published tables. Prefer `variant` when present.
    reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  })
  .superRefine((candidate, ctx) => {
    if (candidate.variant != null && candidate.reasoningEffort != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['variant'],
        message: 'Candidate must not set both variant and reasoningEffort; emit variant only',
      });
    }
  });
export type RankedCandidate = z.infer<typeof RankedCandidateSchema>;

const routingTableFields = {
  // Benchmark run id.
  version: z.string().min(1),
  generatedAt: z.string().min(1),
  minAccuracy: z.number().min(0).max(1),
  // Keep a session's incumbent model unless the fresh pick is cheaper by
  // more than this factor (see BenchmarkConfigSchema.switchCostFactor).
  switchCostFactor: z.number().min(1),
  // In best-accuracy mode, keep a threshold-meeting incumbent unless the
  // fresh pick improves accuracy by more than this absolute delta.
  bestAccuracySwitchThreshold: z.number().min(0).max(1).default(0.05),
  source: z.enum(['benchmark']),
} as const;

function refineTaxonomyRouteKeys(routes: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(routes)) {
    if (!TaxonomyRouteKeySchema.safeParse(key).success) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Unknown taxonomy route ${key}`,
      });
    }
  }
}

/** Platform default routing table: every published route has ≥1 candidate. */
export const RoutingTableSchema = z.object({
  ...routingTableFields,
  routes: z.record(z.string(), z.array(RankedCandidateSchema).min(1)).superRefine((routes, ctx) => {
    refineTaxonomyRouteKeys(routes, ctx);
  }),
});
export type RoutingTable = z.infer<typeof RoutingTableSchema>;

/**
 * Sparse custom routing table assembled for an owner Efficient model pool.
 * Route keys with no graded candidates are omitted (not empty arrays).
 * Consumers must return no decision for an omitted route (balanced fallback);
 * existing `computeDecision` already does this.
 */
export const CustomRoutingTableSchema = z.object({
  ...routingTableFields,
  routes: z.record(z.string(), z.array(RankedCandidateSchema).min(1)).superRefine((routes, ctx) => {
    refineTaxonomyRouteKeys(routes, ctx);
  }),
});
export type CustomRoutingTable = z.infer<typeof CustomRoutingTableSchema>;

export const ROUTING_TABLE_KV_KEY = 'routing_table_v1';

// Accuracy comes from about 10 golden cases per route, so a candidate up to
// this far below `minAccuracy` is inside benchmark noise. Such a candidate
// competes on value with the candidates that meet the threshold.
const ACCURACY_NOISE_BAND = 0.05;
// Value = avgCostUsd * p50LatencyMs^LATENCY_WEIGHT / accuracy^ACCURACY_WEIGHT;
// lower is better. The accuracy weight makes a 0.9 candidate rank first only
// when its cost-latency product is about 4.9x better than a 1.0 candidate's.
const LATENCY_WEIGHT = 1.5;
const ACCURACY_WEIGHT = 15;
// Part of every registry table version: a policy change must republish tables
// built from unchanged measurements.
export const RANKING_POLICY_VERSION = 'value-latency-v1';

type RankInput = Omit<RankedCandidate, 'meetsThreshold'> & {
  meetsThreshold?: boolean;
  // Benchmark p50 latency for this route. Null ranks last among competitors.
  p50LatencyMs: number | null;
};

function rankValue(c: { avgCostUsd: number; accuracy: number; p50LatencyMs: number | null }) {
  if (c.p50LatencyMs === null) return Number.POSITIVE_INFINITY;
  return (c.avgCostUsd * c.p50LatencyMs ** LATENCY_WEIGHT) / c.accuracy ** ACCURACY_WEIGHT;
}

// Candidates within ACCURACY_NOISE_BAND of the threshold come first, best
// value first; the rest follow ordered by accuracy so a degenerate table still
// routes sensibly. `meetsThreshold` stays the strict `accuracy >= minAccuracy`
// flag that sticky routing reads.
export function rankCandidates(
  candidates: ReadonlyArray<RankInput>,
  minAccuracy: number
): RankedCandidate[] {
  const floor = minAccuracy - ACCURACY_NOISE_BAND;
  return candidates
    .map(({ p50LatencyMs, ...c }) => ({
      candidate: { ...c, meetsThreshold: c.accuracy >= minAccuracy },
      competes: c.accuracy > 0 && c.accuracy >= floor,
      value: rankValue({ ...c, p50LatencyMs }),
    }))
    .toSorted((a, b) => {
      if (a.competes !== b.competes) return a.competes ? -1 : 1;
      if (a.competes && a.value !== b.value) return a.value < b.value ? -1 : 1;
      const x = a.candidate;
      const y = b.candidate;
      return y.accuracy - x.accuracy || x.avgCostUsd - y.avgCostUsd;
    })
    .map(s => s.candidate);
}
