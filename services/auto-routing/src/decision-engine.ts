import {
  taxonomyRouteKey,
  DEFAULT_AUTO_ROUTING_MODE,
  isVirtualAutoModelId,
  type AutoRoutingDecision,
  type AutoRoutingMode,
  type ClassifierOutput,
  type RankedCandidate,
  type RoutingConstraints,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import type { ModelCapabilities, ModelCapabilitiesMap } from './model-capabilities';

// Modalities the worker actively enforces against `model_stats.input_modalities`.
// Required modalities outside this set are intentionally ignored: they pass
// the filter today even though we have no way to confirm candidate support.
// Vocabulary evidence: `image` is folded from `image` / `image_url` per the
// existing web-side `modelSupportsImages` helper, and `file` is a confirmed
// OpenRouter `architecture.input_modalities` value (documented enum:
// `text | image | file | audio | video`), mirrored verbatim into
// `model_stats.inputModalities` (`apps/web/src/lib/model-stats/sync-openrouter.ts:77,95,124`).
export const ENFORCED_MODALITIES: ReadonlyArray<string> = ['image', 'file'];

// Single source of the constraint policy shared by benchmark routing
// (`applyCapabilityFilters`) and the coding-plan short-circuit in `decide.ts`.
// Keeping these in one place stops the two paths from silently diverging when
// the policy changes.

// A required+enforced modality the model does not (or might not) support fails
// closed: unknown capability data is treated as unsupported.
export function satisfiesRequiredModalities(
  caps: ModelCapabilities | undefined,
  constraints: RoutingConstraints
): boolean {
  const enforcedAndRequired = (constraints.requiredInputModalities ?? []).filter(m =>
    ENFORCED_MODALITIES.includes(m)
  );
  if (enforcedAndRequired.length === 0) return true;
  if (!caps) return false;
  return enforcedAndRequired.every(modality => caps.inputModalities.has(modality));
}

// True only when the model has a known context length provably smaller than the
// estimate. Unknown context length is NOT proof of unfitness (keeps its rank).
export function contextProvablyTooSmall(
  caps: ModelCapabilities | undefined,
  constraints: RoutingConstraints
): boolean {
  const estimate = constraints.promptTokensEstimate;
  return (
    typeof estimate === 'number' &&
    !!caps &&
    typeof caps.contextLength === 'number' &&
    caps.contextLength < estimate
  );
}

// Combined fitness used by the coding-plan short-circuit, which needs a single
// yes/no. Benchmark routing calls the two predicates separately because a
// modality miss drops the candidate while a too-small context only demotes it.
export function modelSatisfiesConstraints(
  caps: ModelCapabilities | undefined,
  constraints: RoutingConstraints
): boolean {
  return (
    satisfiesRequiredModalities(caps, constraints) && !contextProvablyTooSmall(caps, constraints)
  );
}

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

// Apply the modality and context filters to the route candidates.
//
//   * `ENFORCED_MODALITIES` is the only vocabulary we check: required
//     modalities outside the set are ignored (no fail-closed for unknown
//     vocabulary) so a future gateway sending `audio` does not break routing
//     before the worker learns to honour it.
//   * Missing capability data is treated the same as "no modalities" and
//     fails the modality check; that matches the existing fail-closed web-
//     side behaviour for image support.
//   * Unknown context length is NOT proof of unfitness: a candidate whose
//     row is missing `context_length` keeps its rank inside the eligible
//     set. Only candidates with a known, provably-too-small context are
//     excluded.
//   * When every candidate's known context is provably too small, fall
//     back to the candidates sharing the maximum known context so a
//     large-but-still-too-small model is preferred over a slightly-smaller
//     one we know cannot fit either.
function applyCapabilityFilters(
  candidates: ReadonlyArray<RankedCandidate>,
  constraints: RoutingConstraints | undefined,
  capabilityMap: ModelCapabilitiesMap | undefined
): { filtered: ReadonlyArray<RankedCandidate>; reason: 'empty' | 'no_constraints' | 'ok' } {
  if (!constraints) {
    return { filtered: candidates, reason: 'no_constraints' };
  }

  const afterModality = candidates.filter(c =>
    satisfiesRequiredModalities(capabilityMap?.get(c.model), constraints)
  );
  if (afterModality.length === 0) {
    return { filtered: [], reason: 'empty' };
  }

  const eligible: RankedCandidate[] = [];
  const provablyTooSmall: RankedCandidate[] = [];
  for (const candidate of afterModality) {
    if (contextProvablyTooSmall(capabilityMap?.get(candidate.model), constraints)) {
      provablyTooSmall.push(candidate);
    } else {
      eligible.push(candidate);
    }
  }

  if (eligible.length > 0) {
    return { filtered: eligible, reason: 'ok' };
  }

  // Every candidate's known context is too small. Pick the candidates
  // sharing the maximum known context so the largest-context option wins.
  let maxKnown = -Infinity;
  for (const candidate of provablyTooSmall) {
    const caps = capabilityMap?.get(candidate.model);
    if (caps && typeof caps.contextLength === 'number' && caps.contextLength > maxKnown) {
      maxKnown = caps.contextLength;
    }
  }
  const maxContextFallback = provablyTooSmall.filter(candidate => {
    const caps = capabilityMap?.get(candidate.model);
    return caps?.contextLength === maxKnown;
  });
  return { filtered: maxContextFallback, reason: 'ok' };
}

// A route's accuracy is graded on 10 distinct benchmark cases
// (datasets/decider-cases.ts, >=10 per taxonomy route; repetitions re-run the
// same prompts and add no independent tasks). At n=10 the one-sided 95% Wilson
// upper bound only drops below a 0.95 bar at an observed accuracy of ~0.837, so
// pass/fail at 0.95 flips on binomial noise — and each flip ejects every session
// parked on that model, paying a full prompt-cache rebuild for a difference the
// benchmark cannot resolve. Keep a cost-mode incumbent inside the band instead.
// This is a fixed band, not a per-route interval: replace it with a published
// Wilson bound once the routing table carries per-route case counts. 0.10 is
// deliberately inside the [0.0833, 0.1167) plateau where behaviour is identical
// on the current table, and stricter than the n=10 boundary (~0.113), so it never
// keeps a model a real interval would eject. Do not nudge it toward either edge:
// published accuracies are toFixed(4) roundings of k/30, so 0.083 rounds the floor
// above 26/30 and silently drops that entire tier of retained incumbents (not
// the single largest group, which sits at 27/30 and is unaffected).
const STICKY_ACCURACY_TOLERANCE = 0.1;

export function computeDecision(
  classification: ClassifierOutput,
  table: RoutingTable | null,
  incumbentModel: string | null,
  deniedModelIds: ReadonlySet<string> = new Set(),
  mode: AutoRoutingMode = DEFAULT_AUTO_ROUTING_MODE,
  options: {
    constraints?: RoutingConstraints | undefined;
    capabilityMap?: ModelCapabilitiesMap | undefined;
  } = {}
): AutoRoutingDecision | null {
  if (!table) return null;
  const routeKey = taxonomyRouteKey(classification);
  const routeCandidates = table.routes[routeKey]?.filter(
    c => !deniedModelIds.has(c.model) && !isVirtualAutoModelId(c.model)
  );
  if (!routeCandidates?.length) return null;

  const { filtered: candidates, reason } = applyCapabilityFilters(
    routeCandidates,
    options.constraints,
    options.capabilityMap
  );
  if (reason === 'empty' || candidates.length === 0) {
    return null;
  }

  const freshPick = pickFreshCandidate(candidates, mode);

  // Keep the session on its incumbent model when it is still good enough for
  // the current taxonomy route. A model switch discards the provider's prompt cache,
  // and rebuilding it costs full-price input tokens (4-10x cache-read rates)
  // on a context that dominates agent-session spend — so a switch is only
  // worth it when the fresh pick's recurring per-turn savings clearly exceed
  // that one-time penalty, i.e. it is cheaper by more than switchCostFactor.
  // Sticky lookup is performed against the filtered candidate set so an
  // incumbent that is modality-incapable or provably too small is replaced
  // by a fresh pick from the eligible set, not kept.
  const incumbent =
    incumbentModel === null ? undefined : candidates.find(c => c.model === incumbentModel);
  // Sticky eligibility, shared by the keep decision and the switchReason
  // telemetry below so the two can never disagree. best_accuracy keeps the
  // strict bar (that mode exists to buy accuracy); cost_per_accuracy keeps
  // any incumbent inside the benchmark noise band.
  const incumbentStickyEligible = (candidate: RankedCandidate): boolean =>
    mode === 'best_accuracy'
      ? candidate.meetsThreshold
      : candidate.accuracy >= table.minAccuracy - STICKY_ACCURACY_TOLERANCE;
  const stickyIncumbent =
    incumbent &&
    incumbentStickyEligible(incumbent) &&
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
      switchReason: null,
    };
  }

  const switched = incumbentModel !== null && incumbentModel !== freshPick.model;
  return {
    model: freshPick.model,
    taskType: classification.taskType,
    subtaskType: classification.subtaskType,
    source: table.source,
    tableVersion: table.version,
    reasoningEffort: freshPick.reasoningEffort ?? null,
    sticky: false,
    // 'cost': the incumbent was eligible but the mode's switch condition
    // (cost factor / accuracy gap) made the fresh pick worth it;
    // 'capability': the modality/context filters ejected it from the route;
    // 'threshold': it is denied, off the route, or outside the accuracy band.
    switchReason: !switched
      ? null
      : incumbent
        ? incumbentStickyEligible(incumbent)
          ? 'cost'
          : 'threshold'
        : routeCandidates.some(c => c.model === incumbentModel)
          ? 'capability'
          : 'threshold',
  };
}
