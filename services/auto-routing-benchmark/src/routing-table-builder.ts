import {
  rankCandidates,
  RoutingTableSchema,
  type BenchmarkDeciderModel,
  type BenchmarkModelSummary,
  type DifficultyTier,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

// Builds the routing table from per-(model, tier) decider summaries. Models
// with zero graded cases in a tier are excluded from that tier, as are
// models with no cost signal at all (avgCostUsd null means every case failed
// to report cost; ranking such a model as cheapest would hand it the tier).
// Throws when any tier ends up empty so the caller keeps the previous
// published table. deciderModels/minAccuracy/switchCostFactor come from the
// run's snapshot, not live config.
export function buildRoutingTable(params: {
  runId: string;
  generatedAt: string;
  minAccuracy: number;
  switchCostFactor: number;
  deciderModels: BenchmarkDeciderModel[];
  summaries: BenchmarkModelSummary[];
}): RoutingTable {
  const { runId, generatedAt, minAccuracy, switchCostFactor, deciderModels, summaries } = params;
  const modelConfigById = new Map(deciderModels.map(m => [m.id, m] as const));

  const tierCandidates = (t: DifficultyTier) =>
    rankCandidates(
      summaries
        .filter(s => s.tier === t && s.cases > 0 && s.avgCostUsd !== null)
        .map(s => ({
          model: s.model,
          accuracy: s.accuracy,
          avgCostUsd: s.avgCostUsd ?? 0,
          reasoningEffort: modelConfigById.get(s.model)?.reasoningEffort ?? null,
        })),
      minAccuracy
    );

  const table: RoutingTable = {
    version: runId,
    generatedAt,
    minAccuracy,
    switchCostFactor,
    source: 'benchmark',
    tiers: {
      low: tierCandidates('low'),
      medium: tierCandidates('medium'),
      high: tierCandidates('high'),
    },
  };

  // RoutingTableSchema enforces .min(1) on each tier array; throws ZodError
  // when a tier is empty — caller logs and skips publish, keeping the previous
  // live table intact.
  return RoutingTableSchema.parse(table);
}
