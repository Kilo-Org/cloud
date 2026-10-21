import type { AutoRouter, CandidatePricing } from '@kilocode/auto-routing-contracts';
import type { DeciderCase } from './datasets/decider-cases';
import {
  argvAffectedCases,
  PROMPT_TRANSPORT_REVISION,
  REMEASURE_FRONTIER_INNER_QUOTE_CASES,
  snapshotPromptTokens,
} from './prompt-transport';
import { variantFromStorage } from './reasoning-effort';

export type RemeasureAction = 'dry-run' | 'request' | 'cancel';

export type RemeasurePairReport = {
  model: string;
  variant: string | null;
  queues: Array<'platform' | 'user'>;
  /** Queued: waiting for a drain; running: claimed by `runId`; null: not requested. */
  state: 'queued' | 'running' | null;
  runId: string | null;
  affectedResults: number;
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
  projectedCostUsd: number;
  /** Results without a measured cost, or long-context results of a model without a catalog price. */
  unknownCostResults: number;
  /** Pairs newly queued by `request`, or queued rows removed by `cancel`. */
  changed: number;
  pairDetails: RemeasurePairReport[];
};

type AffectedRow = {
  model: string;
  variant: string;
  platform_requested: number;
  user_requested: number;
  case_id: string;
  cost_usd: number | null;
  remeasure_run_id: string | null;
  remeasure_queued: number;
};

/**
 * Current-identity ready pairs of one router whose provenance run holds results of
 * affected cases measured under an older prompt transport, with projected spend: each
 * result's measured cost, plus the snapshot prompt tokens at the model's catalog prompt
 * price for long-context cases. `request` queues them in `profile_remeasures`; `cancel`
 * removes queued rows that no run has claimed. A dry run reads only.
 */
export async function planPromptTransportRemeasure(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    action: RemeasureAction;
    prices: ReadonlyMap<string, CandidatePricing | null>;
    frontierInnerQuotes?: boolean;
    nowIso?: string;
  }
): Promise<RemeasureRouterReport> {
  const frontierInnerQuotes = params.frontierInnerQuotes ?? REMEASURE_FRONTIER_INNER_QUOTE_CASES;
  const affected = argvAffectedCases(params.router, { frontierInnerQuotes });
  const casesById = new Map<string, DeciderCase>(affected.map(c => [c.id, c]));
  // Materializing a snapshot builds a few hundred KB, so price each case once.
  const snapshotTokensByCase = new Map(
    affected
      .filter(benchCase => benchCase.longContext)
      .map(benchCase => [benchCase.id, snapshotPromptTokens(benchCase)])
  );
  const { results } = await db
    .prepare(`
      SELECT p.model, p.variant, p.platform_requested, p.user_requested,
        source.case_id, source.cost_usd,
        r.run_id AS remeasure_run_id, (r.router IS NOT NULL) AS remeasure_queued
      FROM benchmark_profiles AS p
      JOIN case_results AS source ON source.run_id = p.run_id
        AND source.model = p.model AND source.variant = p.variant
      LEFT JOIN profile_remeasures AS r ON r.router = p.router AND r.model = p.model
        AND r.variant = p.variant AND r.engine_identity = p.engine_identity
        AND r.repetitions = p.repetitions
      WHERE p.router = ? AND p.engine_identity = ? AND p.repetitions = ?
        AND p.status = 'ready' AND (p.platform_requested = 1 OR p.user_requested = 1)
        AND source.prompt_revision < ?
        AND source.case_id IN (SELECT value FROM json_each(?))
      ORDER BY p.model, p.variant
    `)
    .bind(
      params.router,
      params.engineIdentity,
      params.repetitions,
      PROMPT_TRANSPORT_REVISION,
      JSON.stringify([...casesById.keys()])
    )
    .all<AffectedRow>();

  const pairs = new Map<string, RemeasurePairReport>();
  let projectedCostUsd = 0;
  let unknownCostResults = 0;
  for (const row of results) {
    const key = JSON.stringify([row.model, row.variant]);
    let pair = pairs.get(key);
    if (!pair) {
      pair = {
        model: row.model,
        variant: variantFromStorage(row.variant),
        queues: [
          ...(row.platform_requested ? ['platform' as const] : []),
          ...(row.user_requested ? ['user' as const] : []),
        ],
        state: row.remeasure_run_id ? 'running' : row.remeasure_queued ? 'queued' : null,
        runId: row.remeasure_run_id,
        affectedResults: 0,
        projectedCostUsd: 0,
      };
      pairs.set(key, pair);
    }
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

  const pairDetails = [...pairs.values()];
  const changed =
    params.action === 'request'
      ? await queueRemeasures(db, params, pairDetails, params.nowIso ?? new Date().toISOString())
      : params.action === 'cancel'
        ? await cancelQueuedRemeasures(db, params)
        : 0;

  return {
    router: params.router,
    engineIdentity: params.engineIdentity,
    repetitions: params.repetitions,
    promptRevision: PROMPT_TRANSPORT_REVISION,
    frontierInnerQuotes,
    affectedCaseIds: [...casesById.keys()],
    pairs: pairDetails.length,
    affectedResults: results.length,
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
  current: { router: AutoRouter; engineIdentity: string; repetitions: number }
): Promise<number> {
  const result = await db
    .prepare(`
      DELETE FROM profile_remeasures
      WHERE router = ? AND engine_identity = ? AND repetitions = ? AND run_id IS NULL
    `)
    .bind(current.router, current.engineIdentity, current.repetitions)
    .run();
  return result.meta.changes ?? 0;
}
