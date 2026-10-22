import * as z from 'zod';
import { ReasoningEffortSchema } from './reasoning';
import { TaxonomyRouteKeySchema } from './taxonomy';
import { DEFAULT_AUTO_ROUTER, type AutoRouter } from './router';

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

export const CandidatePricingSchema = z.object({
  promptUsdPerToken: z.number().nonnegative(),
  completionUsdPerToken: z.number().nonnegative(),
  cacheReadUsdPerToken: z.number().nonnegative().nullable(),
});
export type CandidatePricing = z.infer<typeof CandidatePricingSchema>;

export const ProductionTokenProfileSchema = z.object({
  uncachedInputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
});
export type ProductionTokenProfile = z.infer<typeof ProductionTokenProfileSchema>;

export function estimateRequestCostUsd(
  candidate: { avgCostUsd: number; pricing?: CandidatePricing | null },
  profile: ProductionTokenProfile | null
): number {
  if (profile === null || candidate.pricing == null) return candidate.avgCostUsd;
  return (
    candidate.avgCostUsd +
    profile.uncachedInputTokens * candidate.pricing.promptUsdPerToken +
    profile.cachedInputTokens *
      (candidate.pricing.cacheReadUsdPerToken ?? candidate.pricing.promptUsdPerToken)
  );
}
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
    cases: z.number().int().nonnegative().nullable().optional(),
    // Average observed OpenRouter cost per benchmark case, in USD credits.
    avgCostUsd: z.number().nonnegative(),
    meetsThreshold: z.boolean(),
    pricing: CandidatePricingSchema.nullable().optional(),
    estimatedRequestCostUsd: z.number().nonnegative().nullable().optional(),
    p50TtftMs: z.number().nonnegative().nullable().optional(),
    p50LatencyMs: z.number().nonnegative().nullable().optional(),
    // Canonical catalog variant key the model was benchmarked with.
    // Optional so tables published before this field existed stay valid.
    variant: z.string().trim().min(1).nullable().optional(),
    // Legacy effort the model was benchmarked with; retained for rolling
    // deploy reads of old published tables. Prefer `variant` when present.
    reasoningEffort: ReasoningEffortSchema.nullable().optional(),
    // True when the measurement behind this candidate is from an older engine
    // identity than the table's. Custom routers only (ADR 0005).
    stale: z.boolean().optional(),
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

export const ReasoningComplexitySchema = z.enum(['low', 'medium', 'high']);
export type ReasoningComplexity = z.infer<typeof ReasoningComplexitySchema>;
export const ComplexityLabelsSchema = z.record(z.string().min(1), ReasoningComplexitySchema);
export type ComplexityLabels = z.infer<typeof ComplexityLabelsSchema>;

export const EffortByComplexitySchema = z
  .record(
    z.string(),
    z.record(
      z.string().trim().min(1),
      z.partialRecord(ReasoningComplexitySchema, z.string().trim().min(1).nullable())
    )
  )
  .superRefine((routes, ctx) => {
    refineTaxonomyRouteKeys(routes, ctx);
  });
export type EffortByComplexity = z.infer<typeof EffortByComplexitySchema>;

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
  productionTokenProfile: ProductionTokenProfileSchema.nullable().optional(),
  effortByComplexity: EffortByComplexitySchema.optional(),
  switchHorizonTurns: z.number().int().positive().nullable().optional(),
  lowConfidenceThreshold: z.number().min(0).max(1).nullable().optional(),
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
export const FRONTIER_ROUTING_TABLE_KV_KEY = 'routing_table_frontier_v1';

export function routingTableKvKey(router: AutoRouter = DEFAULT_AUTO_ROUTER): string {
  return router === 'frontier' ? FRONTIER_ROUTING_TABLE_KV_KEY : ROUTING_TABLE_KV_KEY;
}

// Candidates within this raw-accuracy margin of minAccuracy compete on value.
const ACCURACY_NOISE_BAND = 0.05;
// Value uses the Wilson lower bound when the measured case count is known.
const LATENCY_WEIGHT = 1.5;
export const LATENCY_TOTAL_WEIGHT = 0.15;
const ACCURACY_WEIGHT = 15;
// Part of every registry table version: a policy change must republish tables
// built from unchanged measurements.
export const RANKING_POLICY_VERSION = 'value-ttft-prodcost-wilson-v5';

type RankInput = Omit<RankedCandidate, 'meetsThreshold'> & {
  meetsThreshold?: boolean;
  // Benchmark p50 latency for this route. Null ranks last among competitors.
  p50LatencyMs: number | null;
};

export function wilsonLowerBound(accuracy: number, n: number, z = 1.0): number {
  if (n <= 0) return 0;
  const zSquared = z * z;
  const denominator = 1 + zSquared / n;
  const center = accuracy + zSquared / (2 * n);
  const margin = z * Math.sqrt((accuracy * (1 - accuracy) + zSquared / (4 * n)) / n);
  return Math.max(0, (center - margin) / denominator);
}

export function effectiveLatencyMs(c: {
  p50LatencyMs: number | null;
  p50TtftMs?: number | null;
}): number | null {
  if (c.p50LatencyMs === null) return null;
  return c.p50TtftMs == null ? c.p50LatencyMs : c.p50TtftMs + LATENCY_TOTAL_WEIGHT * c.p50LatencyMs;
}

export function rankValue(c: {
  avgCostUsd: number;
  accuracy: number;
  cases?: number | null;
  p50LatencyMs: number | null;
  p50TtftMs?: number | null;
}) {
  const accuracy = c.cases == null ? c.accuracy : wilsonLowerBound(c.accuracy, c.cases);
  const effectiveLatency = effectiveLatencyMs(c);
  if (effectiveLatency === null || accuracy <= 0) return Number.POSITIVE_INFINITY;
  return (c.avgCostUsd * effectiveLatency ** LATENCY_WEIGHT) / accuracy ** ACCURACY_WEIGHT;
}

// ADR 0005: within the accuracy band a $0 candidate beats every paid one and takes no cost
// term. `estimatedRequestCostUsd === 0` is the only source, so observed paid cost keeps the
// value formula.
export function rankFreeValue(c: {
  accuracy: number;
  cases?: number | null;
  p50LatencyMs: number | null;
  p50TtftMs?: number | null;
}) {
  const accuracy = c.cases == null ? c.accuracy : wilsonLowerBound(c.accuracy, c.cases);
  const effectiveLatency = effectiveLatencyMs(c);
  if (effectiveLatency === null || accuracy <= 0) return Number.POSITIVE_INFINITY;
  return effectiveLatency ** LATENCY_WEIGHT / accuracy ** ACCURACY_WEIGHT;
}

// Candidates within ACCURACY_NOISE_BAND of the threshold come first, best
// value first; the rest follow ordered by accuracy so a degenerate table still
// routes sensibly. `meetsThreshold` stays the strict `accuracy >= minAccuracy`
// flag that sticky routing reads.
export function rankCandidates(
  candidates: ReadonlyArray<RankInput>,
  minAccuracy: number,
  options?: { profile?: ProductionTokenProfile | null; accuracyNoiseBand?: number }
): RankedCandidate[] {
  const floor = minAccuracy - (options?.accuracyNoiseBand ?? ACCURACY_NOISE_BAND);
  return candidates
    .map(({ p50LatencyMs, ...c }) => {
      const estimatedRequestCostUsd = estimateRequestCostUsd(c, options?.profile ?? null);
      const competes = c.accuracy > 0 && c.accuracy >= floor;
      const free = estimatedRequestCostUsd === 0;
      return {
        candidate: {
          ...c,
          p50LatencyMs,
          estimatedRequestCostUsd,
          meetsThreshold: c.accuracy >= minAccuracy,
        },
        competes,
        free,
        value: free
          ? rankFreeValue({
              accuracy: c.accuracy,
              cases: c.cases,
              p50LatencyMs,
              p50TtftMs: c.p50TtftMs,
            })
          : rankValue({
              avgCostUsd: estimatedRequestCostUsd,
              accuracy: c.accuracy,
              cases: c.cases,
              p50LatencyMs,
              p50TtftMs: c.p50TtftMs,
            }),
      };
    })
    .toSorted((a, b) => {
      if (a.competes !== b.competes) return a.competes ? -1 : 1;
      if (!a.competes) {
        const x = a.candidate;
        const y = b.candidate;
        return y.accuracy - x.accuracy || x.avgCostUsd - y.avgCostUsd;
      }
      if (a.free !== b.free) return a.free ? -1 : 1;
      if (a.value !== b.value) return a.value < b.value ? -1 : 1;
      const x = a.candidate;
      const y = b.candidate;
      return y.accuracy - x.accuracy || x.avgCostUsd - y.avgCostUsd;
    })
    .map(s => s.candidate);
}
