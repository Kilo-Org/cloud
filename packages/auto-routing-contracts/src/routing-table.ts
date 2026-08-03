import * as z from 'zod';
import { ReasoningEffortSchema } from './reasoning';
import { TaxonomyRouteKeySchema } from './taxonomy';

/** Maximum Pool entries in an owner-configured Efficient model pool. */
export const MAX_POOL_ENTRIES = 10;

/**
 * One concrete managed model plus its canonical catalog variant key.
 * `variant` is null only for models that expose no variants; catalog
 * enforcement happens at the web boundary, not here.
 */
export const PoolEntrySchema = z.object({
  model: z.string().trim().min(1),
  variant: z.string().trim().min(1).nullable(),
});
export type PoolEntry = z.infer<typeof PoolEntrySchema>;

/**
 * Collision-safe canonical key for a Pool entry. Prefer this over delimiter
 * concatenation so model/variant values cannot collide across encoding.
 */
export function poolEntryKey(entry: PoolEntry): string {
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

/**
 * Owner-configured Efficient model pool: 1–10 unique exact (model, variant)
 * pairs. A null configured pool means inherit; an empty array is invalid.
 */
export const EfficientModelPoolSchema = z
  .array(PoolEntrySchema)
  .min(1)
  .max(MAX_POOL_ENTRIES)
  .superRefine((entries, ctx) => {
    addDuplicatePoolEntryIssues(entries, ctx);
  });
export type EfficientModelPool = z.infer<typeof EfficientModelPoolSchema>;

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

// "Best bang for buck": candidates meeting the accuracy threshold come first,
// lowest cost per unit of accuracy first; below-threshold candidates follow
// ordered by accuracy so a degenerate table still routes sensibly.
export function rankCandidates(
  candidates: ReadonlyArray<Omit<RankedCandidate, 'meetsThreshold'> & { meetsThreshold?: boolean }>,
  minAccuracy: number
): RankedCandidate[] {
  const flagged = candidates.map(c => ({ ...c, meetsThreshold: c.accuracy >= minAccuracy }));
  return flagged.toSorted((a, b) => {
    if (a.meetsThreshold !== b.meetsThreshold) return a.meetsThreshold ? -1 : 1;
    if (a.meetsThreshold) {
      return a.avgCostUsd / a.accuracy - b.avgCostUsd / b.accuracy || b.accuracy - a.accuracy;
    }
    return b.accuracy - a.accuracy || a.avgCostUsd - b.avgCostUsd;
  });
}
