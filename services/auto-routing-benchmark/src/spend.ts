import {
  BenchmarkPairSchema,
  type AutoRouter,
  type BenchmarkConfig,
  type BenchmarkPair,
  type BenchmarkRunPurpose,
  type BenchmarkSpendCapScope,
  type BenchmarkSpendForecast,
  type BenchmarkSpendForecastPair,
  type CandidatePricing,
} from '@kilocode/auto-routing-contracts';
import { variantToStorage } from './reasoning-effort';
import {
  deciderCasesForRouter,
  minimumCaseRevisions,
  type MeasuredCase,
} from './measurement-revision';
import { isProbeCase } from './datasets/probe-cases';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import { getSchedulerOverrides, resolveSchedulerConfig, spendCapsOf } from './scheduler';
import { snapshotPromptTokens } from './prompt-transport';

/**
 * Spend accounting for the benchmark.
 *
 * Three caps bound spending: `perRunUsd` (one run's fresh execution cost),
 * `perDayUsd` (every run's, over one UTC day) and `perOwnerDayUsd` (one
 * subscription owner's pairs, over one UTC day — benchmark calls are always
 * billed to the benchmark identity, so one owner's fan-out is Kilo's spend).
 *
 * The ledger is a running total per UTC day and owner, maintained as results are
 * persisted, so a dispatch tick reads one indexed row instead of scanning
 * `case_results`, which is large and overload-sensitive.
 */

/** UTC calendar day, the window every daily cap uses. */
export function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Ledger key. A platform run has no owner, and SQLite treats every NULL in a
 * unique index as distinct, so the platform row is stored as `''`/`''` — the
 * same convention the variant columns use for "no variant".
 */
export type SpendOwner = { ownerType: 'user' | 'org'; ownerId: string };

export type SpendLedgerKey = { day: string; owner: SpendOwner | null };

function ownerColumns(owner: SpendOwner | null): [string, string] {
  return owner === null ? ['', ''] : [owner.ownerType, owner.ownerId];
}

/** The cost a case actually incurred, or 0 when it recorded none. */
function recordedCost(costUsd: number | null | undefined): number {
  return typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
}

/** One fresh result's cost, added to its day total and its owner's. */
export function addSpendStatement(
  db: D1Database,
  key: SpendLedgerKey,
  costUsd: number | null | undefined,
  nowIso: string = new Date().toISOString()
): D1PreparedStatement {
  const [ownerType, ownerId] = ownerColumns(key.owner);
  return db
    .prepare(`
    INSERT INTO benchmark_spend_ledger (day, owner_type, owner_id, spent_usd, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (day, owner_type, owner_id) DO UPDATE SET
      spent_usd = benchmark_spend_ledger.spent_usd + ?4, updated_at = ?5
  `)
    .bind(key.day, ownerType, ownerId, recordedCost(costUsd), nowIso);
}

export async function addSpend(
  db: D1Database,
  key: SpendLedgerKey,
  costUsd: number | null | undefined,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  await addSpendStatement(db, key, costUsd, nowIso).run();
}

export type SpendTotals = {
  day: string;
  /** Every run's fresh cost today. */
  dayUsd: number;
  /** This owner's fresh cost today, or null when no owner was asked about. */
  ownerDayUsd: number | null;
};

/** Today's spend in one indexed range read: the day row plus, optionally, one owner's. */
const SPEND_TOTALS_SQL = `
  SELECT COALESCE(SUM(spent_usd), 0) AS day_usd,
    COALESCE(SUM(CASE WHEN owner_type = ?2 AND owner_id = ?3 THEN spent_usd ELSE 0 END), 0)
      AS owner_usd
  FROM benchmark_spend_ledger WHERE day = ?1
`;

/**
 * One insert that seeds today's ledger from the results this day actually recorded.
 *
 * The ledger only starts being maintained when this release deploys, so a day that
 * began under the previous image would read as $0 and let an already-running run
 * spend straight past the cap. This counts the day's *fresh* execution cost — results
 * joined to the paid-execution ledger, so a reused copy of an older run's row is not
 * charged to today — with the same freshness rule the cost skill uses.
 *
 * `INSERT … ON CONFLICT DO NOTHING` makes it idempotent: it seeds the day's row once
 * and never adds to a row being incremented in parallel.
 */
const SPEND_BACKFILL_SQL = `
  INSERT INTO benchmark_spend_ledger (day, owner_type, owner_id, spent_usd, updated_at)
  SELECT ?1, owner_key_type, owner_key_id, SUM(spend_usd), ?2
  FROM (
    SELECT result.cost_usd AS spend_usd,
      COALESCE(run.spend_owner_type, '') AS owner_key_type,
      COALESCE(run.spend_owner_id, '') AS owner_key_id
    FROM case_results AS result
    JOIN scheduler_executions AS execution
      ON execution.run_id = result.run_id AND execution.model = result.model
      AND execution.variant = result.variant AND execution.case_id = result.case_id
      AND execution.rep = result.rep
    JOIN benchmark_runs AS run ON run.id = result.run_id
    WHERE date(execution.started_at / 1000, 'unixepoch') = ?1
      AND result.cost_usd IS NOT NULL
  ) AS day_spend
  WHERE spend_usd > 0
  GROUP BY owner_key_type, owner_key_id
  HAVING SUM(spend_usd) > 0
  ON CONFLICT (day, owner_type, owner_id) DO NOTHING
`;

/**
 * Seeds today's ledger row from the day's recorded fresh results, at most once per day.
 *
 * The ledger only starts being maintained when this release deploys, so a day that
 * began under the previous image would read as $0 and let an already-running run spend
 * straight past the cap. This counts the day's *fresh* execution cost — results joined
 * to the paid-execution ledger, so a reused copy of an older run's row is not charged
 * to today — per owner, using the same freshness rule as the cost skill.
 *
 * Cheap on every tick but the first: the existence read is an index seek on the
 * ledger's primary key, and the aggregate runs only while the day has no row at all.
 * `ON CONFLICT DO NOTHING` keeps a concurrent first tick from adding twice.
 */
export async function backfillDayLedger(
  db: D1Database,
  day: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const existing = await db
    .prepare('SELECT 1 AS present FROM benchmark_spend_ledger WHERE day = ? LIMIT 1')
    .bind(day)
    .first();
  if (existing) return;
  const seeded = await db.prepare(SPEND_BACKFILL_SQL).bind(day, nowIso).run();
  if ((seeded.meta.changes ?? 0) > 0) {
    console.log(
      JSON.stringify({ event: 'benchmark_spend_ledger_backfilled', day, rows: seeded.meta.changes })
    );
  }
}

export async function readSpendTotals(
  db: D1Database,
  day: string,
  owner: SpendOwner | null = null,
  nowIso: string = new Date().toISOString()
): Promise<SpendTotals> {
  // Seed before reading: a day that began under an image without the ledger must still
  // report its real spend, or the first claim of an already-running run would see $0.
  await backfillDayLedger(db, day, nowIso);
  const [ownerType, ownerId] = ownerColumns(owner);
  const row = await db
    .prepare(SPEND_TOTALS_SQL)
    .bind(day, ownerType, ownerId)
    .first<{ day_usd: number; owner_usd: number }>();
  return {
    day,
    dayUsd: Number(row?.day_usd ?? 0),
    ownerDayUsd: owner === null ? null : Number(row?.owner_usd ?? 0),
  };
}

/**
 * Context-size bucket of one case, from its own definition — never from its id
 * string, so a renamed case keeps its bucket and a new long-context tier cannot be
 * silently forgotten. A probe replays a recorded history, which the CLI runs with no
 * snapshot, so it is its own bucket.
 */
export type CostBucket = 'plain' | 'long-32k' | 'long-96k' | 'long-160k' | 'probe';

export function costBucketOf(benchCase: MeasuredCase): CostBucket {
  if (isProbeCase(benchCase)) return 'probe';
  const target = benchCase.longContext?.targetTokens ?? 0;
  if (target >= 160_000) return 'long-160k';
  if (target >= 96_000) return 'long-96k';
  if (target >= 32_000) return 'long-32k';
  return 'plain';
}

/**
 * The oldest prompt revision whose cost is comparable with the live one, per bucket.
 * Revision-1 long-context calls omitted the snapshot from the request, so their cost
 * understates a current call; a probe only exists from revision 3.
 */
function comparablePromptRevision(bucket: CostBucket): number {
  if (bucket === 'probe') return 3;
  if (bucket === 'plain') return 1;
  return 2;
}

/** Measured per-case cost for one pair and bucket, from that pair's own graded rows. */
export type MeasuredBucketCost = { bucket: CostBucket; avgCostUsd: number; cases: number };

/**
 * A pair's measured per-case cost per bucket, from the newest completed run that
 * measured it under the live engine identity. The WHERE clause seeks that run's rows
 * by its primary key, so the read is bounded by the pair's own case count.
 */
const MEASURED_PAIR_COSTS_SQL = `
  WITH newest AS (
    SELECT run.id AS run_id
    FROM benchmark_runs AS run
    WHERE run.kind = 'decider' AND run.status = 'completed'
      AND run.router = ?1 AND run.engine_identity = ?2 AND run.repetitions = ?3
      AND EXISTS (
        SELECT 1 FROM case_results AS own
        WHERE own.run_id = run.id AND own.model = ?4 AND own.variant = ?5
          AND own.cost_usd IS NOT NULL
      )
    ORDER BY run.started_at DESC, run.id DESC LIMIT 1
  )
  SELECT result.case_id AS case_id, result.cost_usd AS cost_usd,
    result.prompt_revision AS prompt_revision
  FROM newest CROSS JOIN case_results AS result
  WHERE result.run_id = newest.run_id AND result.model = ?4 AND result.variant = ?5
    AND result.cost_usd IS NOT NULL AND result.error IS NULL AND result.timed_out = 0
`;

export async function measuredPairCosts(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    revision: number;
    pair: BenchmarkPair;
  }
): Promise<Map<CostBucket, MeasuredBucketCost> | null> {
  const rows = await db
    .prepare(MEASURED_PAIR_COSTS_SQL)
    .bind(
      params.router,
      params.engineIdentity,
      params.repetitions,
      params.pair.model,
      variantToStorage(params.pair.variant)
    )
    .all<{ case_id: string; cost_usd: number; prompt_revision: number }>();
  if (rows.results.length === 0) return null;
  const caseById = new Map(
    deciderCasesForRouter(params.router, params.revision).map(benchCase => [
      benchCase.id,
      benchCase,
    ])
  );
  const totals = new Map<CostBucket, { sum: number; cases: number }>();
  for (const row of rows.results) {
    const benchCase = caseById.get(row.case_id);
    if (!benchCase) continue;
    const bucket = costBucketOf(benchCase);
    if (row.prompt_revision < comparablePromptRevision(bucket)) continue;
    const entry = totals.get(bucket) ?? { sum: 0, cases: 0 };
    entry.sum += recordedCost(row.cost_usd);
    entry.cases += 1;
    totals.set(bucket, entry);
  }
  if (totals.size === 0) return null;
  return new Map(
    [...totals].map(([bucket, entry]) => [
      bucket,
      { bucket, avgCostUsd: entry.sum / entry.cases, cases: entry.cases },
    ])
  );
}

/** Output allowance per case, in the CLI's own terms: a short answer plus reasoning. */
const FALLBACK_OUTPUT_TOKENS = 4_000;

/**
 * Input tokens one case sends, measured from the case itself: its prompts, the
 * long-context snapshot it materializes, or the recorded history a probe replays.
 */
export function caseInputTokens(benchCase: MeasuredCase): number {
  if (isProbeCase(benchCase)) {
    return Math.ceil(JSON.stringify(benchCase.probe.transcript).length / 4);
  }
  const base = Math.ceil((benchCase.systemPrompt.length + benchCase.userPrompt.length) / 4);
  return base + snapshotPromptTokens(benchCase);
}

/**
 * Per-case cost per bucket from catalog pricing and the case's own token content.
 * Null when the catalog cannot price the model: a dynamic-price router reports `-1`,
 * which the catalog schema already turns into null, and inventing a number there
 * would miss the cap by orders of magnitude — the caller then bounds with the cap.
 */
export function pricedCaseCosts(
  router: AutoRouter,
  revision: number,
  pricing: CandidatePricing | null
): Map<CostBucket, number> | null {
  if (pricing === null) return null;
  const { promptUsdPerToken, completionUsdPerToken, cacheReadUsdPerToken } = pricing;
  if (
    !Number.isFinite(promptUsdPerToken) ||
    !Number.isFinite(completionUsdPerToken) ||
    promptUsdPerToken < 0 ||
    completionUsdPerToken < 0
  ) {
    return null;
  }
  // Assume no cache hits anywhere: an over-estimate refuses a run rather than overspends.
  const inputPrice = Math.max(promptUsdPerToken, cacheReadUsdPerToken ?? promptUsdPerToken);
  const costs = new Map<CostBucket, number>();
  for (const benchCase of deciderCasesForRouter(router, revision)) {
    const bucket = costBucketOf(benchCase);
    if (costs.has(bucket)) continue;
    costs.set(
      bucket,
      caseInputTokens(benchCase) * inputPrice + FALLBACK_OUTPUT_TOKENS * completionUsdPerToken
    );
  }
  return costs;
}

/** What one pair of a candidate run would pay for, and what it would copy instead. */
export type PairCaseForecast = {
  /** Cases per bucket this pair actually executes — the reused ones are not counted. */
  paid: Map<CostBucket, number>;
  reusedCases: number;
};

/**
 * The (case, repetition) pairs of a candidate run that will actually be executed,
 * derived from the run's own selection rules rather than a parallel model of them:
 *
 * 1. the dataset for `(router, revision)` — every case the run can schedule, for
 *    every repetition;
 * 2. minus what `initializeScheduledRun` copies instead of paying for: a re-measure
 *    copies its previous run's rows first, then the prior-results reuse copies each
 *    pair's newest compatible rows, and both skip results measured below the case's
 *    minimum revision (`minimumCaseRevisions`).
 *
 * A case below its minimum revision therefore stays payable, which is exactly how a
 * pair with revision-1 provenance re-runs its 87 affected cases plus its 22 probes.
 */
export async function forecastPairCases(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    revision: number;
    pairs: readonly BenchmarkPair[];
  }
): Promise<Map<string, PairCaseForecast>> {
  const cases = deciderCasesForRouter(params.router, params.revision);
  const minimumJson = JSON.stringify(minimumCaseRevisions(params.router, params.revision));
  const bucketById = new Map(cases.map(benchCase => [benchCase.id, costBucketOf(benchCase)]));
  const result = new Map<string, PairCaseForecast>();
  const provenance = await readPairProvenance(
    db,
    params.router,
    params.engineIdentity,
    params.repetitions,
    params.pairs
  );
  for (const pair of params.pairs) {
    const key = JSON.stringify([pair.model, pair.variant]);
    const variant = variantToStorage(pair.variant);
    const payable = new Set<string>();
    for (const benchCase of cases) {
      for (let rep = 0; rep < params.repetitions; rep++) payable.add(`${benchCase.id}\0${rep}`);
    }
    const provenanceRunId = provenance.get(key);
    const copied = provenanceRunId
      ? await copyableRows(db, {
          pair,
          variant,
          minimumJson,
          previousRunId: provenanceRunId,
          router: params.router,
          engineIdentity: params.engineIdentity,
          repetitions: params.repetitions,
        })
      : await reusableRows(db, {
          pair,
          variant,
          minimumJson,
          router: params.router,
          engineIdentity: params.engineIdentity,
          repetitions: params.repetitions,
        });
    let reusedCases = 0;
    for (const row of copied) {
      const before = payable.size;
      payable.delete(`${row.caseId}\0${row.rep}`);
      if (payable.size < before) reusedCases += 1;
    }
    const paid = new Map<CostBucket, number>();
    for (const entry of payable) {
      const caseId = entry.slice(0, entry.indexOf('\0'));
      const bucket = bucketById.get(caseId);
      if (bucket === undefined) continue;
      paid.set(bucket, (paid.get(bucket) ?? 0) + 1);
    }
    result.set(key, { paid, reusedCases });
  }
  return result;
}

type CopyScope = {
  pair: BenchmarkPair;
  variant: string;
  minimumJson: string;
  router: AutoRouter;
  engineIdentity: string;
  repetitions: number;
};

/** Latest ready run per pair under the live identity: what a re-measure would copy. */
async function readPairProvenance(
  db: D1Database,
  router: AutoRouter,
  engineIdentity: string,
  repetitions: number,
  pairs: readonly BenchmarkPair[]
): Promise<Map<string, string>> {
  if (pairs.length === 0) return new Map();
  const wanted = JSON.stringify(
    pairs.map(pair => JSON.stringify([pair.model, variantToStorage(pair.variant)]))
  );
  const rows = await db
    .prepare(`
      SELECT model, variant, run_id FROM benchmark_profiles
      WHERE router = ? AND engine_identity = ? AND repetitions = ?
        AND status = 'ready' AND run_id IS NOT NULL
        AND (SELECT 1 FROM json_each(?) AS pair WHERE pair.value = json_array(model, variant))
    `)
    .bind(router, engineIdentity, repetitions, wanted)
    .all<{ model: string; variant: string; run_id: string }>();
  return new Map(
    rows.results.map(row => [
      JSON.stringify([row.model, row.variant === '' ? null : row.variant]),
      row.run_id,
    ])
  );
}

type CopyableRow = { caseId: string; rep: number };

/** A re-measure copies every row of its previous run that clears the case minimums. */
async function copyableRows(
  db: D1Database,
  scope: CopyScope & { previousRunId: string }
): Promise<CopyableRow[]> {
  const rows = await db
    .prepare(`
      SELECT source.case_id AS case_id, source.rep AS rep
      FROM case_results AS source
      WHERE source.run_id = ? AND source.model = ? AND source.variant = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) AS minimum
          WHERE minimum.key = source.case_id AND source.prompt_revision < minimum.value)
    `)
    .bind(scope.previousRunId, scope.pair.model, scope.variant, scope.minimumJson)
    .all<{ case_id: string; rep: number }>();
  return rows.results.map(row => ({ caseId: row.case_id, rep: row.rep }));
}

/**
 * The newest compatible prior result per (case, rep) for this pair, under the same
 * predicate `PRIOR_CASE_RESULTS_REUSE_SQL` copies with — the forecast asks which rows
 * qualify, so it reprints the predicate instead of the INSERT.
 */
async function reusableRows(db: D1Database, scope: CopyScope): Promise<CopyableRow[]> {
  const rows = await db
    .prepare(`
      WITH ranked AS (
        SELECT source.case_id AS case_id, source.rep AS rep,
          ROW_NUMBER() OVER (
            PARTITION BY source.case_id, source.rep
            ORDER BY run.started_at DESC, run.id DESC
          ) AS reuse_rank
        FROM benchmark_runs AS run
        CROSS JOIN case_results AS source
        WHERE run.id = source.run_id
          AND run.kind = 'decider' AND run.status IN ('completed', 'failed')
          AND run.router = ? AND run.engine_identity = ? AND run.repetitions = ?
          AND source.model = ? AND source.variant = ?
          AND source.error IS NULL AND source.timed_out = 0 AND source.exit_code = 0
          AND NOT EXISTS (
            SELECT 1 FROM benchmark_profiles AS profile
            WHERE profile.router = run.router AND profile.engine_identity = run.engine_identity
              AND profile.repetitions = run.repetitions AND profile.model = source.model
              AND profile.variant = source.variant AND profile.invalidated_at IS NOT NULL
              AND run.started_at < profile.invalidated_at
          )
          AND NOT EXISTS (SELECT 1 FROM json_each(?) AS minimum
            WHERE minimum.key = source.case_id AND source.prompt_revision < minimum.value)
      )
      SELECT case_id, rep FROM ranked WHERE reuse_rank = 1
    `)
    .bind(
      scope.router,
      scope.engineIdentity,
      scope.repetitions,
      scope.pair.model,
      scope.variant,
      scope.minimumJson
    )
    .all<{ case_id: string; rep: number }>();
  return rows.results.map(row => ({ caseId: row.case_id, rep: row.rep }));
}

/**
 * What a pair's forecast costs and why. `measured` prices every bucket from the pair's
 * own graded rows; `pricing` prices at least one bucket from catalog price times the
 * case's own tokens; `cap_bound` means at least one bucket had neither, and the
 * per-run cap was charged for it — so an unpriceable model is refused, never admitted
 * as if it were free.
 */
export type PricedPairForecast = {
  entry: BenchmarkPair;
  /** Cases this pair executes in the whole run, all repetitions included. */
  cases: number;
  /** Cases per repetition, as the console shows it beside the cost. */
  casesPerRepetition: number;
  repetitions: number;
  estimateUsd: number;
  basis: BenchmarkSpendForecastPair['basis'];
  measuredCases: number;
};

export type RunSpendForecast = {
  totalUsd: number;
  pairs: PricedPairForecast[];
  perRunUsd: number;
  /** Today's total fresh spend, every run included. */
  daySpendUsd: number;
  perDayUsd: number;
  perOwnerDayUsd: number | null;
  ownerDaySpendUsd: number | null;
};

/** The wire shape, built from the priced estimate. */
export function toForecastResponse(forecast: RunSpendForecast): BenchmarkSpendForecast {
  return {
    totalUsd: forecast.totalUsd,
    pairs: forecast.pairs.map((pair): BenchmarkSpendForecastPair => ({
      entry: pair.entry,
      casesPerRepetition: pair.casesPerRepetition,
      repetitions: pair.repetitions,
      estimateUsd: pair.estimateUsd,
      basis: pair.basis,
      measuredCases: pair.measuredCases,
    })),
    perRunUsd: forecast.perRunUsd,
    daySpendUsd: forecast.daySpendUsd,
    perDayUsd: forecast.perDayUsd,
    perOwnerDayUsd: forecast.perOwnerDayUsd,
    ownerDaySpendUsd: forecast.ownerDaySpendUsd,
  };
}

export async function forecastRunSpend(
  db: D1Database,
  params: {
    kind: 'decider' | 'classifier';
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    revision: number;
    purpose: BenchmarkRunPurpose;
    owner: SpendOwner | null;
    caps: { perRunUsd: number; perDayUsd: number; perOwnerDayUsd: number };
    pairs: readonly BenchmarkPair[];
    prices: ReadonlyMap<string, CandidatePricing | null>;
    now?: Date;
  }
): Promise<RunSpendForecast> {
  const totals = await readSpendTotals(db, utcDayOf(params.now ?? new Date()), params.owner);
  const pairs =
    params.kind === 'classifier'
      ? await forecastClassifierPairs(db, params)
      : await forecastDeciderPairs(db, params);
  return {
    totalUsd: pairs.reduce((total, pair) => total + pair.estimateUsd, 0),
    pairs,
    perRunUsd: params.caps.perRunUsd,
    daySpendUsd: totals.dayUsd,
    perDayUsd: params.caps.perDayUsd,
    perOwnerDayUsd: params.owner === null ? null : params.caps.perOwnerDayUsd,
    ownerDaySpendUsd: totals.ownerDayUsd,
  };
}

/**
 * A classifier run repeats every configured model over its own small dataset, with
 * no reuse. Its per-case cost is measured from the model's newest completed
 * classifier run; without one, catalog price times the case's tokens; without that,
 * the cap bounds it.
 */
async function forecastClassifierPairs(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    revision: number;
    caps: { perRunUsd: number };
    pairs: readonly BenchmarkPair[];
    prices: ReadonlyMap<string, CandidatePricing | null>;
  }
): Promise<PricedPairForecast[]> {
  const caseCount = CLASSIFIER_CASES.length;
  const pairs: PricedPairForecast[] = [];
  for (const pair of params.pairs) {
    const measured = await measuredClassifierCaseCost(db, pair.model);
    const priced = pricedClassifierCaseCost(params.prices.get(pair.model) ?? null);
    const cases = caseCount * params.repetitions;
    if (measured !== null) {
      pairs.push(
        classifierForecast(pair, params.repetitions, cases, measured * cases, 'measured', cases)
      );
      continue;
    }
    if (priced !== null) {
      pairs.push(classifierForecast(pair, params.repetitions, cases, priced * cases, 'pricing', 0));
      continue;
    }
    pairs.push(classifierForecast(pair, params.repetitions, cases, 0, 'unknown', 0));
  }
  return pairs;
}

function classifierForecast(
  pair: BenchmarkPair,
  repetitions: number,
  cases: number,
  estimateUsd: number,
  basis: PricedPairForecast['basis'],
  measuredCases: number
): PricedPairForecast {
  return {
    entry: pair,
    cases,
    casesPerRepetition: Math.floor(cases / Math.max(1, repetitions)),
    repetitions,
    estimateUsd,
    basis,
    measuredCases,
  };
}

/**
 * Mean per-case cost of a model's newest completed classifier run, or null when it
 * has none. Classifier runs are one per router and cheap; the limit of one is what
 * keeps this a point read rather than a scan.
 */
async function measuredClassifierCaseCost(db: D1Database, model: string): Promise<number | null> {
  const row = await db
    .prepare(`
      SELECT AVG(result.cost_usd) AS avg_cost
      FROM (
        SELECT run.id AS run_id FROM benchmark_runs AS run
        WHERE run.kind = 'classifier' AND run.status = 'completed'
          AND EXISTS (SELECT 1 FROM case_results AS own
            WHERE own.run_id = run.id AND own.model = ?
              AND own.cost_usd IS NOT NULL AND own.error IS NULL)
        ORDER BY run.started_at DESC, run.id DESC LIMIT 1
      ) AS newest
      CROSS JOIN case_results AS result
      WHERE result.run_id = newest.run_id AND result.model = ?
        AND result.cost_usd IS NOT NULL AND result.error IS NULL
    `)
    .bind(model, model)
    .first<{ avg_cost: number | null }>();
  const average = row?.avg_cost;
  return typeof average === 'number' && Number.isFinite(average) && average > 0 ? average : null;
}

/** Classifier per-case cost from catalog price and the classifier prompt's own tokens. */
function pricedClassifierCaseCost(pricing: CandidatePricing | null): number | null {
  if (pricing === null) return null;
  const { promptUsdPerToken, completionUsdPerToken } = pricing;
  if (
    !Number.isFinite(promptUsdPerToken) ||
    !Number.isFinite(completionUsdPerToken) ||
    promptUsdPerToken < 0 ||
    completionUsdPerToken < 0
  ) {
    return null;
  }
  const inputTokens = CLASSIFIER_CASES.reduce(
    (total, benchCase) => total + Math.ceil(JSON.stringify(benchCase).length / 4),
    0
  );
  const averageInput = inputTokens / Math.max(1, CLASSIFIER_CASES.length);
  return averageInput * promptUsdPerToken + FALLBACK_OUTPUT_TOKENS * completionUsdPerToken;
}

async function forecastDeciderPairs(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    revision: number;
    caps: { perRunUsd: number };
    pairs: readonly BenchmarkPair[];
    prices: ReadonlyMap<string, CandidatePricing | null>;
  }
): Promise<PricedPairForecast[]> {
  const casesByPair = await forecastPairCases(db, {
    router: params.router,
    engineIdentity: params.engineIdentity,
    repetitions: params.repetitions,
    revision: params.revision,
    pairs: params.pairs,
  });
  const pairs: PricedPairForecast[] = [];
  for (const pair of params.pairs) {
    const key = JSON.stringify([pair.model, pair.variant]);
    const paid = casesByPair.get(key)?.paid ?? new Map<CostBucket, number>();
    const measured = await measuredPairCosts(db, {
      router: params.router,
      engineIdentity: params.engineIdentity,
      repetitions: params.repetitions,
      revision: params.revision,
      pair,
    });
    const priced = pricedCaseCosts(
      params.router,
      params.revision,
      params.prices.get(pair.model) ?? null
    );
    let estimateUsd = 0;
    let cases = 0;
    let measuredCases = 0;
    let basis: PricedPairForecast['basis'] = 'measured';
    for (const [bucket, count] of paid) {
      cases += count;
      const own = measured?.get(bucket);
      if (own !== undefined) {
        estimateUsd += own.avgCostUsd * count;
        measuredCases += count;
        continue;
      }
      const fallback = priced?.get(bucket);
      if (fallback !== undefined) {
        estimateUsd += fallback * count;
        if (basis === 'measured') basis = 'pricing';
        continue;
      }
      // Neither a measurement nor a usable catalog price: this pair's cost is
      // unknown, so it is never counted as free. `spendRefusal` refuses the batch
      // on the `unknown` basis, and the estimate it contributes is 0 only because
      // the refusal does not depend on the number.
      basis = 'unknown';
    }
    if (cases === 0) basis = 'measured';
    pairs.push({
      entry: pair,
      cases,
      casesPerRepetition: Math.floor(cases / Math.max(1, params.repetitions)),
      repetitions: params.repetitions,
      estimateUsd,
      basis,
      measuredCases,
    });
  }
  return pairs;
}

/** Which cap refuses a forecast, with the numbers an admin needs to act on it. */
export type SpendRefusal = {
  scope: BenchmarkSpendCapScope;
  capUsd: number;
  spentUsd: number;
  forecastUsd: number;
  remainingUsd: number;
};

/**
 * Fail closed. A forecast above the run cap, above the day's remaining budget, or
 * above the owner's remaining budget refuses admission; equality fits, because a run
 * expected to cost exactly what is left does not exceed it.
 */
export function spendRefusal(forecast: RunSpendForecast): SpendRefusal | null {
  // Fail closed on unknown cost before any numeric comparison: a pair whose cost
  // cannot be priced must never be admitted at any cap, because the cap cannot
  // bound a number nobody knows.
  const unknown = forecast.pairs.filter(pair => pair.basis === 'unknown');
  if (unknown.length > 0) {
    return {
      scope: 'unknown_cost',
      capUsd: forecast.perRunUsd,
      spentUsd: forecast.daySpendUsd,
      forecastUsd: forecast.totalUsd,
      remainingUsd: Math.max(0, forecast.perRunUsd - forecast.totalUsd),
    };
  }
  if (forecast.totalUsd > forecast.perRunUsd) {
    return {
      scope: 'run',
      capUsd: forecast.perRunUsd,
      spentUsd: 0,
      forecastUsd: forecast.totalUsd,
      remainingUsd: Math.max(0, forecast.perRunUsd - forecast.totalUsd),
    };
  }
  const dayRemaining = forecast.perDayUsd - forecast.daySpendUsd;
  if (forecast.totalUsd > dayRemaining) {
    return {
      scope: 'day',
      capUsd: forecast.perDayUsd,
      spentUsd: forecast.daySpendUsd,
      forecastUsd: forecast.totalUsd,
      remainingUsd: Math.max(0, dayRemaining),
    };
  }
  if (forecast.perOwnerDayUsd !== null && forecast.ownerDaySpendUsd !== null) {
    const ownerRemaining = forecast.perOwnerDayUsd - forecast.ownerDaySpendUsd;
    if (forecast.totalUsd > ownerRemaining) {
      return {
        scope: 'owner_day',
        capUsd: forecast.perOwnerDayUsd,
        spentUsd: forecast.ownerDaySpendUsd,
        forecastUsd: forecast.totalUsd,
        remainingUsd: Math.max(0, ownerRemaining),
      };
    }
  }
  return null;
}

/** Human-readable refusal, used as the run error and in the structured log event. */
export function describeSpendRefusal(refusal: SpendRefusal, pairs: readonly string[] = []): string {
  if (refusal.scope === 'unknown_cost') {
    const named = pairs.length > 0 ? ` (${pairs.join(', ')})` : '';
    return (
      `Held by the spend cap: this run's cost cannot be priced${named}. A pair with no ` +
      `prior measurement and no usable catalog price is refused rather than run unbounded.`
    );
  }
  const labels: Record<Exclude<BenchmarkSpendCapScope, 'unknown_cost'>, string> = {
    run: 'per-run',
    day: 'daily',
    owner_day: "this owner's daily",
  };
  return (
    `Held by the ${labels[refusal.scope]} spend cap: the run is estimated at ` +
    `$${refusal.forecastUsd.toFixed(2)} against $${refusal.remainingUsd.toFixed(2)} remaining ` +
    `of $${refusal.capUsd.toFixed(2)}.`
  );
}

/**
 * Records why a batch of pending pairs is still waiting. The rows stay `pending` in
 * the registry — a refusal never drops work — and the next drain that fits the caps
 * admits them; this row is what the console reads to say why they are waiting.
 */
export async function recordBudgetHolds(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    pairs: readonly BenchmarkPair[];
    refusal: SpendRefusal;
    owner: SpendOwner | null;
    /** Per-pair share of the estimate, so each held row names its own cost. */
    pairEstimatesUsd: ReadonlyMap<string, number>;
  },
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const [ownerType, ownerId] = ownerColumns(params.owner);
  const statements = params.pairs.map(pair =>
    db
      .prepare(`
        INSERT INTO benchmark_budget_holds (router, model, variant, engine_identity, repetitions,
          owner_type, owner_id, scope, estimate_usd, remaining_usd, held_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT (router, model, variant, engine_identity, repetitions) DO UPDATE SET
          owner_type = ?6, owner_id = ?7, scope = ?8, estimate_usd = ?9, remaining_usd = ?10,
          held_at = ?11
      `)
      .bind(
        params.router,
        pair.model,
        variantToStorage(pair.variant),
        params.engineIdentity,
        params.repetitions,
        ownerType,
        ownerId,
        params.refusal.scope,
        params.pairEstimatesUsd.get(JSON.stringify([pair.model, pair.variant])) ?? 0,
        params.refusal.remainingUsd,
        nowIso
      )
  );
  if (statements.length === 0) return;
  await db.batch(statements);
}

/** Drops holds that no longer apply: their pairs are claimed, measured, or gone. */
export async function clearStaleBudgetHolds(
  db: D1Database,
  params: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    pairs: readonly BenchmarkPair[];
  }
): Promise<void> {
  if (params.pairs.length === 0) return;
  const wanted = JSON.stringify(
    params.pairs.map(pair => JSON.stringify([pair.model, variantToStorage(pair.variant)]))
  );
  await db
    .prepare(`
      DELETE FROM benchmark_budget_holds
      WHERE router = ? AND engine_identity = ? AND repetitions = ?
        AND (SELECT 1 FROM json_each(?) AS pair
          WHERE pair.value = json_array(model, variant))
    `)
    .bind(params.router, params.engineIdentity, params.repetitions, wanted)
    .run();
}

export type BudgetHoldRow = {
  entry: BenchmarkPair;
  scope: BenchmarkSpendCapScope;
  estimateUsd: number;
  remainingUsd: number;
  ownerType: 'user' | 'org' | null;
  ownerId: string | null;
  heldAt: string;
};

/** Holds still current for pairs still pending in the registry. */
export async function listBudgetHolds(
  db: D1Database,
  params: { router: AutoRouter; engineIdentity: string; repetitions: number }
): Promise<BudgetHoldRow[]> {
  const rows = await db
    .prepare(`
      SELECT hold.model AS model, hold.variant AS variant, hold.scope AS scope,
        hold.estimate_usd AS estimate_usd, hold.remaining_usd AS remaining_usd,
        hold.owner_type AS owner_type, hold.owner_id AS owner_id, hold.held_at AS held_at
      FROM benchmark_budget_holds AS hold
      JOIN benchmark_profiles AS profile ON profile.router = hold.router
        AND profile.model = hold.model AND profile.variant = hold.variant
        AND profile.engine_identity = hold.engine_identity
        AND profile.repetitions = hold.repetitions
      WHERE hold.router = ? AND hold.engine_identity = ? AND hold.repetitions = ?
        AND profile.status = 'pending'
      ORDER BY hold.held_at, hold.model, hold.variant
    `)
    .bind(params.router, params.engineIdentity, params.repetitions)
    .all<{
      model: string;
      variant: string;
      scope: BenchmarkSpendCapScope;
      estimate_usd: number;
      remaining_usd: number;
      owner_type: string;
      owner_id: string;
      held_at: string;
    }>();
  return rows.results.map(row => ({
    entry: { model: row.model, variant: row.variant === '' ? null : row.variant },
    scope: row.scope,
    estimateUsd: Number(row.estimate_usd),
    remainingUsd: Number(row.remaining_usd),
    ownerType: row.owner_type === 'user' || row.owner_type === 'org' ? row.owner_type : null,
    ownerId: row.owner_id === '' ? null : row.owner_id,
    heldAt: row.held_at,
  }));
}

/** One statement bumping a run's own recorded spend; batched with the result insert. */
export function addRunSpendStatement(
  db: D1Database,
  runId: string,
  costUsd: number | null | undefined
): D1PreparedStatement {
  return db
    .prepare('UPDATE benchmark_runs SET spent_usd = spent_usd + ? WHERE id = ?')
    .bind(recordedCost(costUsd), runId);
}

/**
 * Ledger statements for one fresh result, written in the same batch as the result
 * row: one upsert on the day/owner key and one increment of the run's own total.
 * Both are primary-key writes — no scan, and nothing the caller has to sequence.
 *
 * Only a fresh execution reaches here. A reused copy is written by
 * `reuseDeciderCaseResults` and never passes through this path, so historical cost
 * never lands in today's spend. A re-delivered result is refused before grading by
 * the paid-execution ledger (`scheduler_executions`), so one execution is ledgered
 * once.
 */
export function freshResultSpendStatements(
  db: D1Database,
  params: {
    runId: string;
    costUsd: number | null | undefined;
    owner: SpendOwner | null;
  },
  now: Date = new Date()
): D1PreparedStatement[] {
  return [
    addSpendStatement(
      db,
      { day: utcDayOf(now), owner: params.owner },
      params.costUsd,
      now.toISOString()
    ),
    addRunSpendStatement(db, params.runId, params.costUsd),
  ];
}

export type RunSpend = { runId: string; spentUsd: number; owner: SpendOwner | null };

/** One run's recorded fresh spend and the owner budget it draws on. */
export async function readRunSpend(db: D1Database, runId: string): Promise<RunSpend | null> {
  const row = await db
    .prepare(`SELECT spent_usd, spend_owner_type, spend_owner_id FROM benchmark_runs WHERE id = ?`)
    .bind(runId)
    .first<{ spent_usd: number; spend_owner_type: string | null; spend_owner_id: string | null }>();
  if (!row) return null;
  const ownerType = row.spend_owner_type;
  return {
    runId,
    spentUsd: Number(row.spent_usd ?? 0),
    owner:
      (ownerType === 'user' || ownerType === 'org') && row.spend_owner_id
        ? { ownerType, ownerId: row.spend_owner_id }
        : null,
  };
}

export type RunSpendState = {
  runId: string;
  spentUsd: number;
  ownerUsd: number | null;
  owner: SpendOwner | null;
  dayUsd: number;
  paused: boolean;
  pauseScope: BenchmarkSpendCapScope | null;
};

/**
 * Everything the in-flight guard needs in two point reads: the run's own total from
 * its row, and today's day/owner total from the ledger.
 */
export async function readRunSpendState(
  db: D1Database,
  runId: string,
  now: Date = new Date()
): Promise<RunSpendState | null> {
  const run = await db
    .prepare(
      `SELECT spent_usd, spend_owner_type, spend_owner_id, spend_pause_scope
       FROM benchmark_runs WHERE id = ?`
    )
    .bind(runId)
    .first<{
      spent_usd: number;
      spend_owner_type: string | null;
      spend_owner_id: string | null;
      spend_pause_scope: BenchmarkSpendCapScope | null;
    }>();
  if (!run) return null;
  const owner: SpendOwner | null =
    (run.spend_owner_type === 'user' || run.spend_owner_type === 'org') && run.spend_owner_id
      ? { ownerType: run.spend_owner_type, ownerId: run.spend_owner_id }
      : null;
  const totals = await readSpendTotals(db, utcDayOf(now), owner);
  return {
    runId,
    spentUsd: Number(run.spent_usd ?? 0),
    ownerUsd: totals.ownerDayUsd,
    owner,
    dayUsd: totals.dayUsd,
    paused: run.spend_pause_scope !== null,
    pauseScope: run.spend_pause_scope,
  };
}

/**
 * Pauses dispatch for one run at `scope`, keeping every result it already measured.
 * A no-op if the run already stopped at a cap with the same scope, so a guard that
 * re-evaluates every tick does not rewrite the row.
 */
export async function pauseRunAtSpendCap(
  db: D1Database,
  runId: string,
  scope: BenchmarkSpendCapScope
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE benchmark_runs SET spend_pause_scope = ?
       WHERE id = ? AND status = 'running' AND spend_pause_scope IS NULL`
    )
    .bind(scope, runId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Clears a run's pause and reports whether it was paused. Used by the admin resume
 * and by the in-flight guard when a raised cap or a new UTC day leaves room again.
 */
export async function resumeRunFromSpendCap(db: D1Database, runId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE benchmark_runs SET spend_pause_scope = NULL
       WHERE id = ? AND status = 'running' AND spend_pause_scope IS NOT NULL`
    )
    .bind(runId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Clears a run's pause only when the caps leave room again — a raised cap, or a new
 * UTC day that reset the day total. Returns true when dispatch may continue.
 *
 * The check uses the run's recorded estimate as the bound on what it still may spend,
 * which over-estimates (part of it is already spent) and so errs toward staying
 * paused rather than overspending.
 */
export async function resumeIfCapsAllow(
  db: D1Database,
  params: {
    runId: string;
    caps: { perRunUsd: number; perDayUsd: number; perOwnerDayUsd: number };
    now?: Date;
  }
): Promise<boolean> {
  const state = await readRunSpendState(db, params.runId, params.now ?? new Date());
  if (!state) return false;
  if (!state.paused) return true;
  const runRoom = params.caps.perRunUsd - state.spentUsd;
  const dayRoom = params.caps.perDayUsd - state.dayUsd;
  const ownerRoom =
    state.owner === null
      ? Number.POSITIVE_INFINITY
      : params.caps.perOwnerDayUsd - (state.ownerUsd ?? 0);
  const room = Math.min(runRoom, dayRoom, ownerRoom);
  if (room <= 0) return false;
  // Any room at all lets the run measure at least some cases; it re-pauses the moment
  // its own recorded spend reaches the cap again.
  return resumeRunFromSpendCap(db, params.runId);
}

/**
 * The in-flight guard: whether dispatch may claim another chunk of this run. When a
 * cap is already reached it pauses the run (keeping what it measured) and reports
 * false; when caps leave room and the run was paused, it resumes it first.
 *
 * `paused` is sticky while no room exists, so a run that hit the day cap stays paused
 * for the rest of the day even if a later read shows a fraction of a cent of headroom.
 */
export type RunClaimDecision =
  | { allow: true }
  | { allow: false; scope: BenchmarkSpendCapScope; spentUsd: number; capUsd: number };

export async function evaluateRunClaim(
  db: D1Database,
  params: {
    runId: string;
    caps: { perRunUsd: number; perDayUsd: number; perOwnerDayUsd: number };
    now?: Date;
  }
): Promise<RunClaimDecision> {
  const state = await readRunSpendState(db, params.runId, params.now ?? new Date());
  if (!state) return { allow: false, scope: 'run', spentUsd: 0, capUsd: params.caps.perRunUsd };
  if (state.spentUsd >= params.caps.perRunUsd) {
    await pauseRunAtSpendCap(db, params.runId, 'run');
    return {
      allow: false,
      scope: 'run',
      spentUsd: state.spentUsd,
      capUsd: params.caps.perRunUsd,
    };
  }
  if (state.dayUsd >= params.caps.perDayUsd) {
    await pauseRunAtSpendCap(db, params.runId, 'day');
    return { allow: false, scope: 'day', spentUsd: state.dayUsd, capUsd: params.caps.perDayUsd };
  }
  if (state.owner !== null && (state.ownerUsd ?? 0) >= params.caps.perOwnerDayUsd) {
    await pauseRunAtSpendCap(db, params.runId, 'owner_day');
    return {
      allow: false,
      scope: 'owner_day',
      spentUsd: state.ownerUsd ?? 0,
      capUsd: params.caps.perOwnerDayUsd,
    };
  }
  if (state.paused) await resumeIfCapsAllow(db, params);
  return { allow: true };
}

/**
 * Which owner a user-queue pair is charged to. Benchmark calls are billed to the
 * benchmark identity, so a pair an owner's pool requested is that owner's spend.
 * A pair requested by several owners is charged to the first by (type, id), so the
 * attribution is stable; a pair with no subscribing owner is `unattributed` and is
 * refused rather than spending outside any owner budget.
 */
export type PairOwner =
  | { kind: 'owner'; owner: SpendOwner; entry: BenchmarkPair }
  | { kind: 'unattributed'; entry: BenchmarkPair };

export async function resolvePairOwners(
  db: D1Database,
  router: AutoRouter,
  entries: readonly BenchmarkPair[]
): Promise<PairOwner[]> {
  if (entries.length === 0) return [];
  const rows = await db
    .prepare(`
      SELECT owner_type, owner_id, snapshot FROM benchmark_subscriptions
      WHERE router = ? AND owner_type IN ('user', 'org')
      ORDER BY owner_type, owner_id
    `)
    .bind(router)
    .all<{ owner_type: string; owner_id: string; snapshot: string }>();
  const ownerByPair = new Map<string, SpendOwner>();
  for (const row of rows.results) {
    if (row.owner_type !== 'user' && row.owner_type !== 'org') continue;
    for (const pair of snapshotPairsFromStored(row.snapshot)) {
      const key = JSON.stringify([pair.model, pair.variant]);
      // Rows are ordered, so the first owner seen wins and the choice is stable.
      if (!ownerByPair.has(key)) {
        ownerByPair.set(key, { ownerType: row.owner_type, ownerId: row.owner_id });
      }
    }
  }
  return entries.map(entry => {
    const owner = ownerByPair.get(JSON.stringify([entry.model, entry.variant]));
    return owner === undefined
      ? { kind: 'unattributed' as const, entry }
      : { kind: 'owner' as const, owner, entry };
  });
}

/**
 * Pairs from one stored subscription snapshot, parsed defensively: a snapshot that
 * does not parse yields no pairs, so an unreadable row can only make attribution
 * stricter — the pair becomes unattributed and is refused — never looser.
 */
function snapshotPairsFromStored(stored: string): BenchmarkPair[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  const pairs: BenchmarkPair[] = [];
  for (const entry of entries) {
    const list = (entry as { pairs?: unknown } | null)?.pairs;
    if (!Array.isArray(list)) continue;
    for (const pair of list) {
      const parsedPair = BenchmarkPairSchema.safeParse(pair);
      if (parsedPair.success) pairs.push(parsedPair.data);
    }
  }
  return pairs;
}

export type BatchOwner =
  | { kind: 'platform' }
  | { kind: 'owner'; owner: SpendOwner }
  | { kind: 'unattributed' };

/**
 * One owner per run, so each run's estimate is charged to — and bounded by —
 * exactly one owner's daily budget. A batch that mixes owners, or holds a pair no
 * owner requested, is `unattributed` and refuses admission: charging it to a guessed
 * owner could spend one owner's budget on another's pairs.
 */
export async function batchOwnerFor(
  db: D1Database,
  router: AutoRouter,
  queue: BenchmarkRunPurpose,
  entries: readonly BenchmarkPair[]
): Promise<BatchOwner> {
  if (queue === 'platform') return { kind: 'platform' };
  const owners = await resolvePairOwners(db, router, entries);
  const distinct = new Set(
    owners.flatMap(item => (item.kind === 'owner' ? [ownerKey(item.owner)] : []))
  );
  if (owners.some(item => item.kind === 'unattributed') || distinct.size > 1) {
    return { kind: 'unattributed' };
  }
  const [only] = owners;
  return only !== undefined && only.kind === 'owner'
    ? { kind: 'owner', owner: only.owner }
    : { kind: 'unattributed' };
}

/** Stable owner key for grouping and logging. */
export function ownerKey(owner: SpendOwner): string {
  return `${owner.ownerType}:${owner.ownerId}`;
}

/**
 * Pauses every running run whose own recorded fresh spend reached `perRunUsd`, in one
 * UPDATE from each run's own column. This is the per-run half of the in-flight guard:
 * it is what turns "claims nothing" into a visible `paused` state, and it applies to a
 * run that was already running when the cap shipped, because the column is seeded for
 * every run and the condition is re-evaluated each pass.
 */
export async function pauseRunsAtRunCap(
  db: D1Database,
  perRunUsd: number
): Promise<Array<{ runId: string; scope: 'run' }>> {
  const rows = await db
    .prepare(
      `UPDATE benchmark_runs SET spend_pause_scope = 'run'
       WHERE status = 'running' AND spend_pause_scope IS NULL AND spent_usd >= ?
       RETURNING id`
    )
    .bind(perRunUsd)
    .all<{ id: string }>();
  return rows.results.map(row => ({ runId: row.id, scope: 'run' as const }));
}

/**
 * Pauses every running run the day or owner caps have reached, in two statements —
 * one read of the day's ledger rows, one UPDATE — and returns what it paused.
 *
 * This is the cross-run half of the in-flight guard: the per-run cap is enforced at
 * claim time from each run's own column, while a day or owner cap belongs to the
 * whole fleet and has to be evaluated once per dispatch pass.
 */
export async function pauseRunsAtDailyCaps(
  db: D1Database,
  caps: { perDayUsd: number; perOwnerDayUsd: number },
  now: Date = new Date()
): Promise<Array<{ runId: string; scope: 'day' | 'owner_day' }>> {
  const day = utcDayOf(now);
  const ledger = await db
    .prepare(`SELECT owner_type, owner_id, spent_usd FROM benchmark_spend_ledger WHERE day = ?`)
    .bind(day)
    .all<{ owner_type: string; owner_id: string; spent_usd: number }>();
  let dayUsd = 0;
  const overOwner = new Map<string, SpendOwner>();
  for (const row of ledger.results) {
    dayUsd += Number(row.spent_usd);
    const isOwner = row.owner_type === 'user' || row.owner_type === 'org';
    if (isOwner && Number(row.spent_usd) >= caps.perOwnerDayUsd) {
      overOwner.set(`${row.owner_type}:${row.owner_id}`, {
        ownerType: row.owner_type as 'user' | 'org',
        ownerId: row.owner_id,
      });
    }
  }
  const paused: Array<{ runId: string; scope: 'day' | 'owner_day' }> = [];
  const statements: D1PreparedStatement[] = [];
  if (dayUsd >= caps.perDayUsd) {
    const rows = await db
      .prepare(
        `UPDATE benchmark_runs SET spend_pause_scope = 'day'
         WHERE status = 'running' AND spend_pause_scope IS NULL RETURNING id`
      )
      .all<{ id: string }>();
    for (const row of rows.results) paused.push({ runId: row.id, scope: 'day' });
    return paused;
  }
  for (const owner of overOwner.values()) {
    statements.push(
      db
        .prepare(
          `UPDATE benchmark_runs SET spend_pause_scope = 'owner_day'
           WHERE status = 'running' AND spend_pause_scope IS NULL
             AND spend_owner_type = ? AND spend_owner_id = ?
           RETURNING id`
        )
        .bind(owner.ownerType, owner.ownerId)
    );
  }
  if (statements.length === 0) return paused;
  const results = await db.batch<{ id: string }>(statements);
  for (const result of results) {
    for (const row of result.results) paused.push({ runId: row.id, scope: 'owner_day' });
  }
  return paused;
}

/** What an admission attempt decided, so a drain can report why it started nothing. */
export type AdmissionSkipReason =
  | 'spend_cap_run'
  | 'spend_cap_day'
  | 'spend_cap_owner_day'
  | 'spend_cap_unknown_cost';

export type AdmissionRefusal = {
  skipReason: AdmissionSkipReason;
  refusal: SpendRefusal;
  forecast: RunSpendForecast;
};

const SKIP_REASON_BY_SCOPE: Record<BenchmarkSpendCapScope, AdmissionSkipReason> = {
  run: 'spend_cap_run',
  day: 'spend_cap_day',
  owner_day: 'spend_cap_owner_day',
  unknown_cost: 'spend_cap_unknown_cost',
};

/**
 * The caps in force, from the scheduler config: admin override, then
 * `BENCHMARK_SCHEDULER_CONFIG`, then the conservative defaults. They live in the
 * same config the scheduler limits use, so one admin save raises both without a deploy.
 */
export async function resolveSpendCaps(
  db: D1Database,
  envConfig: string | undefined
): Promise<{ perRunUsd: number; perDayUsd: number; perOwnerDayUsd: number }> {
  const { config } = resolveSchedulerConfig(envConfig, (await getSchedulerOverrides(db)).overrides);
  return spendCapsOf(config);
}

export type Admission =
  | { admitted: true; forecast: RunSpendForecast; owner: SpendOwner | null }
  | { admitted: false; refusal: AdmissionRefusal };

/**
 * The one admission gate every path uses before a run row is written: forecast the
 * batch's spend from this run's own case selection, compare it with the caps, and —
 * when it does not fit — record the hold and refuse.
 *
 * A refusal never drops work: the pairs stay `pending`, a `benchmark_budget_holds`
 * row names the cap, the estimate and the remaining budget, and a structured event
 * says the same. The next drain that fits the caps admits the same pairs.
 */
export async function admitAgainstSpendCaps(
  env: { BENCH_DB: D1Database },
  params: {
    queue: BenchmarkRunPurpose;
    router: AutoRouter;
    /** Live measurement revision the run would start under. */
    revision: number;
    engineIdentity: string;
    repetitions: number;
    entries: readonly { model: string; variant: string | null }[];
    owner: BatchOwner;
    caps: { perRunUsd: number; perDayUsd: number; perOwnerDayUsd: number };
    prices: ReadonlyMap<string, CandidatePricing | null>;
  }
): Promise<Admission> {
  const owner = params.owner.kind === 'owner' ? params.owner.owner : null;
  const pairs = params.entries.map(entry => ({ model: entry.model, variant: entry.variant }));
  const forecast = await forecastRunSpend(env.BENCH_DB, {
    kind: 'decider',
    router: params.router,
    engineIdentity: params.engineIdentity,
    repetitions: params.repetitions,
    revision: params.revision,
    purpose: params.queue,
    owner,
    caps: params.caps,
    pairs,
    prices: params.prices,
  });
  const refusal = spendRefusal(forecast);
  // A user batch whose pairs no single owner requested cannot be bounded by an owner
  // budget, so it is refused on the owner scope rather than admitted against nobody.
  const effective =
    refusal ??
    (params.owner.kind === 'unattributed'
      ? ({
          scope: 'owner_day',
          capUsd: params.caps.perOwnerDayUsd,
          spentUsd: 0,
          forecastUsd: forecast.totalUsd,
          remainingUsd: 0,
        } satisfies SpendRefusal)
      : null);
  if (effective === null) return { admitted: true, forecast, owner };
  await recordBudgetHolds(env.BENCH_DB, {
    router: params.router,
    engineIdentity: params.engineIdentity,
    repetitions: params.repetitions,
    pairs: forecast.pairs.map(pair => pair.entry),
    refusal: effective,
    owner,
    pairEstimatesUsd: new Map(
      forecast.pairs.map(pair => [
        JSON.stringify([pair.entry.model, pair.entry.variant]),
        pair.estimateUsd,
      ])
    ),
  });
  console.log(
    JSON.stringify({
      event: 'benchmark_admission_spend_cap_refused',
      queue: params.queue,
      router: params.router,
      scope: effective.scope,
      owner: owner === null ? null : ownerKey(owner),
      pairs: forecast.pairs.length,
      forecastUsd: Number(forecast.totalUsd.toFixed(4)),
      runCapUsd: params.caps.perRunUsd,
      dayCapUsd: params.caps.perDayUsd,
      daySpentUsd: Number(forecast.daySpendUsd.toFixed(4)),
      ownerCapUsd: forecast.perOwnerDayUsd,
      ownerSpentUsd: forecast.ownerDaySpendUsd,
      unattributed: params.owner.kind === 'unattributed',
      unpricedPairs: forecast.pairs
        .filter(pair => pair.basis === 'unknown')
        .map(pair => pair.entry.model),
    })
  );
  return {
    admitted: false,
    refusal: {
      skipReason: SKIP_REASON_BY_SCOPE[effective.scope],
      refusal: effective,
      forecast,
    },
  };
}
