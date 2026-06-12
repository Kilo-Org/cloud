import {
  rankCandidates,
  RoutingTableSchema,
  type BenchmarkConfig,
  type BenchmarkModelSummary,
  type DifficultyTier,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

// Builds the routing table from per-(model, tier) decider summaries. Models
// with zero graded cases in a tier are excluded from that tier. Throws when
// any tier ends up empty so the caller keeps the previous published table.
export function buildRoutingTable(params: {
  runId: string;
  generatedAt: string;
  config: BenchmarkConfig;
  summaries: BenchmarkModelSummary[];
}): RoutingTable {
  const { runId, generatedAt, config, summaries } = params;
  const modelConfigById = new Map(config.deciderModels.map(m => [m.id, m] as const));

  const tierCandidates = (t: DifficultyTier) =>
    rankCandidates(
      summaries
        .filter(s => s.tier === t && s.cases > 0)
        .map(s => ({
          model: s.model,
          accuracy: s.accuracy,
          avgCostUsd: s.avgCostUsd ?? 0,
          // Spread into a mutable array so tsgo is happy with the readonly type.
          supportedApiKinds: [
            ...(modelConfigById.get(s.model)?.supportedApiKinds ?? (['chat_completions'] as const)),
          ],
          reasoningEffort: modelConfigById.get(s.model)?.reasoningEffort ?? null,
        })),
      config.minAccuracy
    );

  const table: RoutingTable = {
    version: runId,
    generatedAt,
    minAccuracy: config.minAccuracy,
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
