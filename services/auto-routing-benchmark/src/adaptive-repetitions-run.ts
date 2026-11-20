import type { AutoRouter } from '@kilocode/auto-routing-contracts';
import {
  decideRepetitionPlan,
  measureRoutes,
  MIN_LEAD_REPS,
  pairKey,
  type PairRepetitionState,
} from './adaptive-repetitions';
import { variantToStorage } from './reasoning-effort';

/** Knobs one run's repetition plans are decided against. */
export type PairPlanContext = {
  router: AutoRouter;
  minAccuracy: number;
  accuracyNoiseBand: number;
  /** The router's decider repetitions: what a boundary pair is measured to. */
  boundaryTargetReps: number;
  /** Route keys of the run's dataset. */
  routeKeys: readonly string[];
  /** Accuracy each route already publishes; absent before a table exists. */
  leaderAccuracy: ReadonlyMap<string, number>;
};

export type PairPlan = {
  model: string;
  variant: string;
  measuredReps: number;
  requiredReps: number;
  state: PairRepetitionState;
  routes: string[];
};

type Row = {
  model: string;
  variant: string;
  routeKey: string | null;
  caseId: string;
  score: number;
};

/**
 * Repetitions a pair may owe: the router's own count, and never fewer than a
 * route lead needs (#16395) — a would-be leader is measured that far even when
 * the router measures everything else once.
 */
export function maxRequiredReps(context: { boundaryTargetReps: number }): number {
  return Math.max(MIN_LEAD_REPS, context.boundaryTargetReps);
}

/**
 * Repetition plan for every enqueued pair of a run, decided on the rows the run
 * already holds.
 *
 * The accuracy a pair has to beat on a route is the accuracy the route already
 * publishes; before the first table (or for a route no published table covers)
 * it is the run's best *other* pair on that route. A route only this pair
 * measured has no target, which the decision reads as "would lead" — so the
 * strongest pair is raised to the repetitions a route lead requires (#16395)
 * instead of leading on a single fluke run.
 */
export function planRunRepetitions(params: {
  rows: readonly Row[];
  enqueued: readonly { model: string; variant: string }[];
  /** Repetitions each pair already holds; absent means none measured yet. */
  measuredReps: ReadonlyMap<string, number>;
  context: PairPlanContext;
  /** Pairs whose plan is already written keep it. */
  settled?: ReadonlySet<string>;
}): PairPlan[] {
  const rowsByPair = new Map<string, Row[]>();
  for (const row of params.rows) {
    const key = JSON.stringify([row.model, row.variant]);
    const rows = rowsByPair.get(key);
    if (rows) rows.push(row);
    else rowsByPair.set(key, [row]);
  }
  const measured = new Map(
    params.enqueued.map(entry => {
      const key = pairKey(entry.model, variantToStorage(entry.variant) || null);
      return [key, measureRoutes(rowsByPair.get(key) ?? [])] as const;
    })
  );
  const target = new Map<string, number>(params.context.leaderAccuracy);
  for (const routeKey of params.context.routeKeys) {
    if (target.has(routeKey)) continue;
    const accuracies: number[] = [];
    for (const routes of measured.values()) {
      const route = routes.find(entry => entry.routeKey === routeKey);
      if (route) accuracies.push(route.accuracy);
    }
    // The runner-up: the best accuracy that is not the pair's own.
    const runnerUp = accuracies.toSorted((a, b) => b - a)[1];
    if (runnerUp !== undefined) target.set(routeKey, runnerUp);
  }
  return params.enqueued.map(entry => {
    const key = pairKey(entry.model, variantToStorage(entry.variant) || null);
    const measuredReps = params.measuredReps.get(key) ?? 0;
    if (params.settled?.has(key)) {
      return {
        model: entry.model,
        variant: entry.variant,
        measuredReps,
        requiredReps: Math.max(1, measuredReps),
        state: 'complete',
        routes: [],
      };
    }
    const decision = decideRepetitionPlan({
      routes: measured.get(key) ?? [],
      target,
      minAccuracy: params.context.minAccuracy,
      accuracyNoiseBand: params.context.accuracyNoiseBand,
      measuredReps,
      boundaryTargetReps: params.context.boundaryTargetReps,
      leadTargetReps: maxRequiredReps(params.context),
    });
    return {
      model: entry.model,
      variant: entry.variant,
      measuredReps,
      requiredReps:
        decision.state === 'escalated'
          ? Math.min(maxRequiredReps(params.context), decision.requiredReps)
          : Math.max(1, measuredReps),
      state: decision.state,
      routes: decision.routes,
    };
  });
}

/** Pairs still owed repetitions beyond what they hold. */
export function pairsOwingRepetitions(
  plans: readonly PairPlan[]
): Array<{ model: string; variant: string; requiredReps: number }> {
  return plans
    .filter(plan => plan.requiredReps > plan.measuredReps)
    .map(plan => ({ model: plan.model, variant: plan.variant, requiredReps: plan.requiredReps }));
}
