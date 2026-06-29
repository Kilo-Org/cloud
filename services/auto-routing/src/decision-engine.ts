import {
  taxonomyRouteKey,
  DEFAULT_AUTO_ROUTING_MODE,
  isVirtualAutoModelId,
  type AutoRoutingDecision,
  type AutoRoutingMode,
  type ClassifierOutput,
  type RankedCandidate,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

function pickFreshCandidate(
  candidates: ReadonlyArray<RankedCandidate>,
  mode: AutoRoutingMode
): RankedCandidate {
  if (mode === 'best_accuracy') {
    const [candidate] = candidates.toSorted(
      (a, b) => b.accuracy - a.accuracy || a.avgCostUsd - b.avgCostUsd
    );
    if (!candidate) {
      throw new Error('Expected at least one routing candidate');
    }
    return candidate;
  }
  const [candidate] = candidates;
  if (!candidate) {
    throw new Error('Expected at least one routing candidate');
  }
  return candidate;
}

export function computeDecision(
  classification: ClassifierOutput,
  table: RoutingTable | null,
  incumbentModel: string | null,
  deniedModelIds: ReadonlySet<string> = new Set(),
  mode: AutoRoutingMode = DEFAULT_AUTO_ROUTING_MODE
): AutoRoutingDecision | null {
  if (!table) return null;
  const routeKey = taxonomyRouteKey(classification);
  const candidates = table.routes[routeKey]?.filter(
    c => !deniedModelIds.has(c.model) && !isVirtualAutoModelId(c.model)
  );
  if (!candidates?.length) return null;
  const freshPick = pickFreshCandidate(candidates, mode);

  // Keep the session on its incumbent model when it is still good enough for
  // the current taxonomy route. A model switch discards the provider's prompt cache,
  // and rebuilding it costs full-price input tokens (4-10x cache-read rates)
  // on a context that dominates agent-session spend — so a switch is only
  // worth it when the fresh pick's recurring per-turn savings clearly exceed
  // that one-time penalty, i.e. it is cheaper by more than switchCostFactor.
  const incumbent =
    incumbentModel === null ? undefined : candidates.find(c => c.model === incumbentModel);
  const stickyIncumbent =
    incumbent &&
    incumbent.meetsThreshold &&
    incumbent.model !== freshPick.model &&
    ((mode === 'cost_per_accuracy' &&
      !(freshPick.avgCostUsd * table.switchCostFactor < incumbent.avgCostUsd)) ||
      (mode === 'best_accuracy' &&
        !(freshPick.accuracy - incumbent.accuracy > table.bestAccuracySwitchThreshold)));

  if (stickyIncumbent) {
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
