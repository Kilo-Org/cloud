import {
  taxonomyRouteKey,
  type AutoRoutingDecision,
  type ClassifierOutput,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

export function computeDecision(
  classification: ClassifierOutput,
  table: RoutingTable | null,
  incumbentModel: string | null,
  deniedModelIds: ReadonlySet<string> = new Set()
): AutoRoutingDecision | null {
  if (!table) return null;
  const routeKey = taxonomyRouteKey(classification);
  const candidates = table.routes[routeKey]?.filter(c => !deniedModelIds.has(c.model));
  if (!candidates?.length) return null;
  const freshPick = candidates[0];

  // Keep the session on its incumbent model when it is still good enough for
  // the current taxonomy route. A model switch discards the provider's prompt cache,
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
      taskType: classification.taskType,
      subtaskType: classification.subtaskType,
      source: table.source,
      tableVersion: table.version,
      reasoningEffort: incumbent.reasoningEffort ?? null,
      sticky: true,
    };
  }

  return {
    model: freshPick.model,
    taskType: classification.taskType,
    subtaskType: classification.subtaskType,
    source: table.source,
    tableVersion: table.version,
    reasoningEffort: freshPick.reasoningEffort ?? null,
    sticky: false,
  };
}
