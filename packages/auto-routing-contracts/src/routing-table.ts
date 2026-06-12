import * as z from 'zod';
import { ReasoningEffortSchema } from './tiers';

export const RankedCandidateSchema = z.object({
  model: z.string().trim().min(1),
  // Benchmark accuracy in [0, 1] for this tier.
  accuracy: z.number().min(0).max(1),
  // Average observed OpenRouter cost per benchmark case, in USD credits.
  avgCostUsd: z.number().nonnegative(),
  meetsThreshold: z.boolean(),
  // Reasoning effort the model was benchmarked with; serving mirrors it.
  // Optional so tables published before this field existed stay valid.
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
});
export type RankedCandidate = z.infer<typeof RankedCandidateSchema>;

export const RoutingTableSchema = z.object({
  // Benchmark run id.
  version: z.string().min(1),
  generatedAt: z.string().min(1),
  minAccuracy: z.number().min(0).max(1),
  // Keep a session's incumbent model unless the fresh pick is cheaper by
  // more than this factor (see BenchmarkConfigSchema.switchCostFactor).
  switchCostFactor: z.number().min(1),
  source: z.enum(['benchmark']),
  tiers: z.object({
    low: z.array(RankedCandidateSchema).min(1),
    medium: z.array(RankedCandidateSchema).min(1),
    high: z.array(RankedCandidateSchema).min(1),
  }),
});
export type RoutingTable = z.infer<typeof RoutingTableSchema>;

export const ROUTING_TABLE_KV_KEY = 'routing_table_v1';

// "Best bang for buck": candidates meeting the accuracy threshold come
// first, cheapest first (accuracy breaks ties); below-threshold candidates
// follow ordered by accuracy so a degenerate table still routes sensibly.
export function rankCandidates(
  candidates: ReadonlyArray<Omit<RankedCandidate, 'meetsThreshold'> & { meetsThreshold?: boolean }>,
  minAccuracy: number
): RankedCandidate[] {
  const flagged = candidates.map(c => ({ ...c, meetsThreshold: c.accuracy >= minAccuracy }));
  return flagged.toSorted((a, b) => {
    if (a.meetsThreshold !== b.meetsThreshold) return a.meetsThreshold ? -1 : 1;
    if (a.meetsThreshold) {
      return a.avgCostUsd - b.avgCostUsd || b.accuracy - a.accuracy;
    }
    return b.accuracy - a.accuracy || a.avgCostUsd - b.avgCostUsd;
  });
}
