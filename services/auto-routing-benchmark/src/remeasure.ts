import type { AutoRouter, CandidatePricing } from '@kilocode/auto-routing-contracts';
import type { DeciderCase } from './datasets/decider-cases';
import { isProbeCase } from './datasets/probe-cases';
import {
  deciderCasesForRouter,
  minimumCaseRevisions,
  type MeasuredCase,
} from './measurement-revision';
import { REMEASURE_FRONTIER_INNER_QUOTE_CASES, snapshotPromptTokens } from './prompt-transport';
import { variantFromStorage, variantToStorage } from './reasoning-effort';

export type RemeasureAction = 'dry-run' | 'request' | 'cancel';

export type RemeasurePairReport = {
  model: string;
  variant: string | null;
  queues: Array<'platform' | 'user'>;
  /** Queued: waiting for a drain; running: claimed by `runId`; null: not requested. */
  state: 'queued' | 'running' | null;
  runId: string | null;
  affectedResults: number;
  /** Results of current cases the provenance run never measured; not in the projection. */
  unmeasuredResults: number;
  projectedCostUsd: number;
};

export type RemeasureRouterReport = {
  router: AutoRouter;
  engineIdentity: string;
  repetitions: number;
  promptRevision: number;
  frontierInnerQuotes: boolean;
  affectedCaseIds: string[];
  pairs: number;
  affectedResults: number;
  unmeasuredResults: number;
  projectedCostUsd: number;
  /** Results without a measured cost, or long-context results of a model without a catalog price. */
  unknownCostResults: number;
  /** Pairs newly queued by `request`, or queued rows removed by `cancel`. */
  changed: number;
  pairDetails: RemeasurePairReport[];
};

type PairRow = {
  model: string;
  variant: string;
  platform_requested: number;
  user_requested: number;
  remeasure_run_id: string | null;
  remeasure_queued: number;
};

type AffectedRow = PairRow & { case_id: string; cost_usd: number | null };

type MeasuredRow = PairRow & { measured: number };

const PAIR_COLUMNS = `p.model, p.variant, p.platform_requested, p.user_requested,
  r.run_id AS remeasure_run_id, (r.router IS NOT NULL) AS remeasure_queued`;

const REMEASURE_JOIN = `LEFT JOIN profile_remeasures AS r ON r.router = p.router
  AND r.model = p.model AND r.variant = p.variant AND r.engine_identity = p.engine_identity
  AND r.repetitions = p.repetitions`;

const READY_PAIR_FILTER = `p.router = ? AND p.engine_identity = ? AND p.repetitions = ?
  AND p.status = 'ready' AND (p.platform_requested = 1 OR p.user_requested = 1)`;

/**
 * Current-identity ready pairs of one router whose provenance run lacks a valid measurement
 * of a case of `revision`: a result below its case's minimum revision
 * (src/measurement-revision.ts), or no result at all for a case added since. Projected spend
 * covers the results below their minimum: each one's measured cost, plus the snapshot prompt
 * tokens at the model's catalog prompt price for long-context cases. Added cases have no
 * measured cost, so the projection leaves them out and `unmeasuredResults` counts them.
 * `request` queues the pairs in `profile_remeasures`; `cancel` removes queued rows that no run
 * has claimed. A dry run reads only.
 */
export async function planPromptTransportRemeasure(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    revision: number;
    action: RemeasureAction;
    prices: ReadonlyMap<string, CandidatePricing | null>;
    frontierInnerQuotes?: boolean;
    /** Restrict the plan to these exact pairs; absent means every ready pair. */
    pairs?: readonly { model: string; variant: string | null }[];
    nowIso?: string;
  }
): Promise<RemeasureRouterReport> {
  const frontierInnerQuotes = params.frontierInnerQuotes ?? REMEASURE_FRONTIER_INNER_QUOTE_CASES;
  const minimums = minimumCaseRevisions(params.router, params.revision, {
    frontierInnerQuotes,
  });
  const cases = deciderCasesForRouter(params.router, params.revision);
  const affected = cases.filter(benchCase => benchCase.id in minimums);
  const casesById = new Map<string, MeasuredCase>(affected.map(c => [c.id, c]));
  // Materializing a snapshot builds a few hundred KB, so price each case once. A probe case
  // has no prompt to materialize: it replays a recorded history.
  const snapshotTokensByCase = new Map(
    affected
      .filter((benchCase): benchCase is DeciderCase => !isProbeCase(benchCase))
      .filter(benchCase => benchCase.longContext)
      .map(benchCase => [benchCase.id, snapshotPromptTokens(benchCase)])
  );
  const pairBindings = [params.router, params.engineIdentity, params.repetitions];
  // An explicit pair list measures exactly those pairs, so the operator can request the
  // probe measurement of a chosen set instead of the whole pool — and a `cancel` with one
  // removes only those pairs' queued rows.
  const scopedPairs = params.pairs && params.pairs.length > 0 ? params.pairs : null;
  const pairFilter = scopedPairs
    ? `AND (SELECT 1 FROM json_each(?) AS wanted
         WHERE wanted.value = json_array(p.model, p.variant))`
    : '';
  const pairFilterBindings = scopedPairs
    ? [
        JSON.stringify(
          scopedPairs.map(pair => JSON.stringify([pair.model, variantToStorage(pair.variant)]))
        ),
      ]
    : [];
  const [{ results }, { results: measured }] = await Promise.all([
    db
      .prepare(`
        SELECT ${PAIR_COLUMNS}, source.case_id, source.cost_usd
        FROM benchmark_profiles AS p
        JOIN case_results AS source ON source.run_id = p.run_id
          AND source.model = p.model AND source.variant = p.variant
        ${REMEASURE_JOIN}
        WHERE ${READY_PAIR_FILTER}
          ${pairFilter}
          AND EXISTS (SELECT 1 FROM json_each(?) AS minimum
            WHERE minimum.key = source.case_id AND source.prompt_revision < minimum.value)
        ORDER BY p.model, p.variant
      `)
      .bind(...pairBindings, ...pairFilterBindings, JSON.stringify(minimums))
      .all<AffectedRow>(),
    db
      .prepare(`
        SELECT ${PAIR_COLUMNS},
          (SELECT COUNT(*) FROM case_results AS source
            WHERE source.run_id = p.run_id AND source.model = p.model
              AND source.variant = p.variant
              AND source.case_id IN (SELECT value FROM json_each(?))) AS measured
        FROM benchmark_profiles AS p
        ${REMEASURE_JOIN}
        WHERE ${READY_PAIR_FILTER}
          ${pairFilter}
        ORDER BY p.model, p.variant
      `)
      .bind(
        JSON.stringify(cases.map(benchCase => benchCase.id)),
        ...pairBindings,
        ...pairFilterBindings
      )
      .all<MeasuredRow>(),
  ]);

  const pairs = new Map<string, RemeasurePairReport>();
  const pairOf = (row: PairRow) => {
    const key = JSON.stringify([row.model, row.variant]);
    const existing = pairs.get(key);
    if (existing) return existing;
    const pair: RemeasurePairReport = {
      model: row.model,
      variant: variantFromStorage(row.variant),
      queues: [
        ...(row.platform_requested ? ['platform' as const] : []),
        ...(row.user_requested ? ['user' as const] : []),
      ],
      state: row.remeasure_run_id ? 'running' : row.remeasure_queued ? 'queued' : null,
      runId: row.remeasure_run_id,
      affectedResults: 0,
      unmeasuredResults: 0,
      projectedCostUsd: 0,
    };
    pairs.set(key, pair);
    return pair;
  };
  let projectedCostUsd = 0;
  let unknownCostResults = 0;
  for (const row of results) {
    const pair = pairOf(row);
    pair.affectedResults += 1;
    const snapshotTokens = snapshotTokensByCase.get(row.case_id) ?? 0;
    const promptPrice = params.prices.get(row.model)?.promptUsdPerToken;
    if (row.cost_usd === null || (snapshotTokens > 0 && promptPrice === undefined)) {
      unknownCostResults += 1;
      continue;
    }
    const cost = row.cost_usd + snapshotTokens * (promptPrice ?? 0);
    pair.projectedCostUsd += cost;
    projectedCostUsd += cost;
  }
  let unmeasuredResults = 0;
  for (const row of measured) {
    const missing = cases.length * params.repetitions - row.measured;
    if (missing <= 0) continue;
    pairOf(row).unmeasuredResults += missing;
    unmeasuredResults += missing;
  }

  const pairDetails = [...pairs.values()];
  const changed =
    params.action === 'request'
      ? await queueRemeasures(db, params, pairDetails, params.nowIso ?? new Date().toISOString())
      : params.action === 'cancel'
        ? await cancelQueuedRemeasures(db, params, scopedPairs)
        : 0;

  return {
    router: params.router,
    engineIdentity: params.engineIdentity,
    repetitions: params.repetitions,
    promptRevision: params.revision,
    frontierInnerQuotes,
    affectedCaseIds: [...casesById.keys()],
    pairs: pairDetails.length,
    affectedResults: results.length,
    unmeasuredResults,
    projectedCostUsd,
    unknownCostResults,
    changed,
    pairDetails,
  };
}

async function queueRemeasures(
  db: D1Database,
  current: { router: AutoRouter; engineIdentity: string; repetitions: number },
  pairs: readonly RemeasurePairReport[],
  nowIso: string
): Promise<number> {
  const statements = pairs
    .filter(pair => pair.state === null)
    .map(pair =>
      db
        .prepare(`
          INSERT INTO profile_remeasures
            (router, model, variant, engine_identity, repetitions, run_id, requested_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT DO NOTHING
        `)
        .bind(
          current.router,
          pair.model,
          pair.variant ?? '',
          current.engineIdentity,
          current.repetitions,
          nowIso
        )
    );
  if (statements.length === 0) return 0;
  const results = await db.batch(statements);
  return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
}

async function cancelQueuedRemeasures(
  db: D1Database,
  current: { router: AutoRouter; engineIdentity: string; repetitions: number },
  scopedPairs: readonly { model: string; variant: string | null }[] | null
): Promise<number> {
  const pairFilter = scopedPairs
    ? `AND (SELECT 1 FROM json_each(?) AS wanted
         WHERE wanted.value = json_array(model, variant))`
    : '';
  const pairFilterBindings = scopedPairs
    ? [
        JSON.stringify(
          scopedPairs.map(pair => JSON.stringify([pair.model, variantToStorage(pair.variant)]))
        ),
      ]
    : [];
  const result = await db
    .prepare(`
      DELETE FROM profile_remeasures
      WHERE router = ? AND engine_identity = ? AND repetitions = ? AND run_id IS NULL
        ${pairFilter}
    `)
    .bind(current.router, current.engineIdentity, current.repetitions, ...pairFilterBindings)
    .run();
  return result.meta.changes ?? 0;
}
