import {
  deriveDifficultyTier,
  type AutoRoutingDecision,
  type ClassifierOutput,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

export function computeDecision(
  classification: ClassifierOutput,
  table: RoutingTable | null,
  incumbentModel: string | null
): AutoRoutingDecision | null {
  if (!table) return null;
  const tier = deriveDifficultyTier(classification);
  const candidates = table.tiers[tier];
  // A parsed table guarantees a non-empty tier (schema .min(1)), so with a
  // table and a classification a decision always exists.
  const freshPick = candidates[0];

  // Keep the session on its incumbent model when it is still good enough for
  // the current tier. A model switch discards the provider's prompt cache,
  // and rebuilding it costs full-price input tokens (4-10x cache-read rates)
  // on a context that dominates agent-session spend — so a switch is only
  // worth it when the fresh pick's recurring per-turn savings clearly exceed
  // that one-time penalty, i.e. it is cheaper by more than switchCostFactor.
  const incumbent =
    incumbentModel === null ? undefined : candidates.find(c => c.model === incumbentModel);
  if (
    incumbent &&
    incumbent.meetsThreshold &&
    incumbent.model !== freshPick.model &&
    !(freshPick.avgCostUsd * table.switchCostFactor < incumbent.avgCostUsd)
  ) {
    return {
      model: incumbent.model,
      tier,
      source: table.source,
      tableVersion: table.version,
      reasoningEffort: incumbent.reasoningEffort ?? null,
      sticky: true,
    };
  }

  return {
    model: freshPick.model,
    tier,
    source: table.source,
    tableVersion: table.version,
    reasoningEffort: freshPick.reasoningEffort ?? null,
    sticky: false,
  };
}
