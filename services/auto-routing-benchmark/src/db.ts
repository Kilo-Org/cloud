import type {
  AutoRouter,
  BenchmarkKind,
  BenchmarkModelSummary,
  BenchmarkProfileFailureClass,
  BenchmarkProfileStatus,
  BenchmarkRegistryFailedEntry,
  BenchmarkRun,
  BenchmarkRunPurpose,
  ClassifierWinner,
  RankedCandidate,
  PolicySettingComputedMap,
  PolicySettingOverrides,
  ProductionTokenProfile,
  RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { benchmarkPairKey, RoutingTableSchema } from '@kilocode/auto-routing-contracts';
import type { BenchmarkPair } from '@kilocode/auto-routing-contracts';
import { POLICY_SETTINGS } from '@kilocode/auto-routing-contracts';
import type { BatchItem } from 'drizzle-orm/batch';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as z from 'zod';
import {
  benchmarkConfig,
  benchmarkProfiles,
  benchmarkRuns,
  caseResults,
  configClassifierModels,
  configDeciderModels,
  modelSummaries,
  pendingDeciderOutputs,
  profileRemeasures,
  routingTableCandidates,
  routingTables,
  runLaneFailures,
  runModels,
} from './db-schema';
import { pickClassifierWinner } from './winner';
import {
  parsePersistedReasoningEffort,
  variantFromStorage,
  variantToStorage,
} from './reasoning-effort';
import type { OfflineSweep } from './scoreboard/schema';
import { noLiveBenchmarkChunks } from './profile-entry-claims';
import { platformCoverageStatements } from './paid-case-store';
import { ACTIVE_MEASUREMENT_REVISION } from './measurement-revision';
import {
  aliasReadinessClearSql,
  aliasReadinessFenceReadStatement,
  aliasReadinessSampleClockStatement,
} from './alias-readiness-lease';
import {
  parseProfileState,
  profileFailureAssignments,
  profileFailureResetAssignments,
  wireProfileFailure,
  type ProfileFailure,
} from './profile-failure';

export type CaseResultRow = typeof caseResults.$inferSelect;
export type RunRow = typeof benchmarkRuns.$inferSelect;
export type RunModelRow = typeof runModels.$inferSelect;
export type ConfigDeciderModelRow = Omit<typeof configDeciderModels.$inferSelect, 'router'> & {
  router?: AutoRouter;
};
type ModelSummaryRow = typeof modelSummaries.$inferSelect;

// D1 rejects statements with too many bound variables. A model summary insert
// binds 18 values per row (including variant), so 5 rows keeps each INSERT
// below the 100-variable ceiling while still batching the delete plus inserts.
const MODEL_SUMMARY_INSERT_BATCH_SIZE = 5;

const ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE = 7;

// Run model rows bind 5 values per row. Keep each INSERT comfortably under D1's
// 100-variable ceiling; the profile drain claims batches of up to 33 entries,
// and an unchunked 33-row insert fails with "too many SQL variables", which
// stranded every pending Benchmark profile in production.
const RUN_MODEL_INSERT_BATCH_SIZE = 18;

// Statements that name a set of exact pairs bind two variables per entry on top
// of a small fixed clause. 30 keeps each one well inside D1's 100-variable
// ceiling — the same ceiling that once stranded every pending profile in prod.
const PROFILE_ENTRY_FILTER_BATCH_SIZE = 30;

// Statements that filter on a page of run ids bind one variable per id plus the
// fixed clause. `GET /admin/runs` caps a page at 100 ids, so 90 leaves room for
// that clause inside D1's 100-variable ceiling.
const RUN_ID_FILTER_BATCH_SIZE = 90;

/**
 * Rows per config INSERT. D1 allows 100 bound variables per statement and the
 * widest of these tables is 4 columns, so 20 rows always fits. The decider
 * lists are catalog-sized and grow on their own — the auto list is refilled by
 * a nightly sync — so they cannot go in one statement.
 */
const CONFIG_INSERT_BATCH_SIZE = 20;

function batchRows<T>(rows: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += CONFIG_INSERT_BATCH_SIZE) {
    batches.push(rows.slice(i, i + CONFIG_INSERT_BATCH_SIZE));
  }
  return batches;
}

export function mapSummaryRow(row: ModelSummaryRow): BenchmarkModelSummary {
  return {
    model: row.model,
    variant: variantFromStorage(row.variant),
    routeKey: row.route_key as BenchmarkModelSummary['routeKey'],
    accuracy: row.accuracy,
    avgCostUsd: row.avg_cost_usd,
    avgInputTokens: row.avg_input_tokens,
    avgCachedInputTokens: row.avg_cached_input_tokens,
    avgOutputTokens: row.avg_output_tokens,
    avgReasoningTokens: row.avg_reasoning_tokens,
    avgLatencyMs: row.avg_latency_ms,
    p50LatencyMs: row.p50_latency_ms,
    p95LatencyMs: row.p95_latency_ms,
    cases: row.cases,
    costedCases: row.costed_cases,
    errors: row.errors,
    timeouts: row.timeouts,
    routeAccuracy: row.route_accuracy,
  };
}

/**
 * Summary row with provenance run identity. Used by custom-table assembly so
 * candidates are bound to the measuring run, not collapsed across runs.
 */
export type BenchmarkModelSummaryWithRun = BenchmarkModelSummary & { runId: string };

export function mapSummaryRowWithRun(row: ModelSummaryRow): BenchmarkModelSummaryWithRun {
  return {
    ...mapSummaryRow(row),
    runId: row.run_id,
  };
}

export function mapRunRow(row: RunRow): BenchmarkRun {
  return {
    id: row.id,
    router: row.router ?? 'efficient',
    kind: row.kind,
    purpose: row.purpose === 'user' ? 'user' : 'platform',
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

export async function getConfigRows(
  db: D1Database,
  router: AutoRouter = 'efficient'
): Promise<{
  config: typeof benchmarkConfig.$inferSelect | null;
  classifierModels: string[];
  deciderModels: ConfigDeciderModelRow[];
}> {
  const orm = drizzle(db);
  const [configRows, classifierRows, deciderRows] = await Promise.all([
    orm.select().from(benchmarkConfig).where(eq(benchmarkConfig.router, router)).limit(1),
    orm.select().from(configClassifierModels).where(eq(configClassifierModels.router, router)),
    orm.select().from(configDeciderModels).where(eq(configDeciderModels.router, router)),
  ]);
  return {
    config: configRows[0] ?? null,
    classifierModels: classifierRows.map(r => r.model),
    deciderModels: deciderRows,
  };
}

// Retired per-config lane budgets. Nothing in this worker reads them, but the
// columns are NOT NULL and the previously deployed worker sizes runs from them
// and rejects configs unless efficient max + efficient user + frontier max <=
// 200. Writing today's production values on every save (80 + 40 + 80 = 200)
// keeps that worker valid during rollout.
const ROLLBACK_SAFE_LEGACY_LANE_BUDGETS = {
  max_concurrency: 80,
  user_max_concurrency: 40,
};

// The seven fixed policy columns are legacy: nothing in this worker reads them
// back, but they are NOT NULL and the previously deployed worker still reads
// them, so every save writes the canonical fixed policy value for its router.
function rollbackSafeLegacyFixedPolicy(router: AutoRouter) {
  return {
    frontier_min_accuracy_delta: POLICY_SETTINGS.frontierMinAccuracyDelta.fixed,
    switch_cost_factor: POLICY_SETTINGS.switchCostFactor.fixed,
    best_accuracy_switch_threshold: POLICY_SETTINGS.bestAccuracySwitchThreshold.fixed,
    low_confidence_threshold: POLICY_SETTINGS.lowConfidenceThreshold.fixed,
    classifier_repetitions: POLICY_SETTINGS.classifierRepetitions.fixed,
    decider_repetitions: POLICY_SETTINGS.deciderRepetitions.fixedByRouter[router],
    classifier_max_p95_latency_ms: POLICY_SETTINGS.classifierMaxP95LatencyMs.fixed,
  };
}

export async function replaceConfig(
  db: D1Database,
  config: {
    min_accuracy: number;
    accuracy_noise_band?: number;
    production_token_profile?: ProductionTokenProfile | null;
    switch_horizon_turns?: number | null;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    policy_overrides?: PolicySettingOverrides | null;
    updated_at: string;
    updated_by: string | null;
  },
  classifierModels: string[],
  deciderModels: ConfigDeciderModelRow[],
  router: AutoRouter = 'efficient'
): Promise<void> {
  const orm = drizzle(db);
  const legacyFixedPolicy = rollbackSafeLegacyFixedPolicy(router);
  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm
      .insert(benchmarkConfig)
      .values({
        id: router === 'efficient' ? 1 : 2,
        ...config,
        ...ROLLBACK_SAFE_LEGACY_LANE_BUDGETS,
        ...legacyFixedPolicy,
        router,
      })
      .onConflictDoUpdate({
        target: benchmarkConfig.router,
        set: {
          ...config,
          ...ROLLBACK_SAFE_LEGACY_LANE_BUDGETS,
          ...legacyFixedPolicy,
        },
      }),
    orm.delete(configClassifierModels).where(eq(configClassifierModels.router, router)),
    orm.delete(configDeciderModels).where(eq(configDeciderModels.router, router)),
  ];
  for (const batch of batchRows(classifierModels)) {
    stmts.push(orm.insert(configClassifierModels).values(batch.map(m => ({ model: m, router }))));
  }
  for (const batch of batchRows(deciderModels)) {
    stmts.push(orm.insert(configDeciderModels).values(batch.map(row => ({ ...row, router }))));
  }
  await orm.batch(stmts);
}

/** Which registry queue a run drains: the platform decider list, or owner pools. */
export type { BenchmarkRunPurpose };

/**
 * Record the daily system-optimal computation for one router. Only the computed
 * map is written, so admin provenance (updated_at/updated_by) is untouched.
 */
export async function savePolicyComputed(
  db: D1Database,
  router: AutoRouter,
  computed: PolicySettingComputedMap
): Promise<void> {
  await drizzle(db)
    .update(benchmarkConfig)
    .set({ policy_computed: computed })
    .where(eq(benchmarkConfig.router, router));
}

export async function getLiveContainerLanes(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS lanes FROM scheduler_chunks WHERE status IN ('queued', 'active')")
    .first<{ lanes: number }>();
  return row?.lanes ?? 0;
}

/** Active decider runs one (router, queue) may hold at once. */
export const MAX_RUNNING_RUNS_PER_QUEUE = 4;

const QueueRunOccupancySchema = z.object({
  activeRuns: z.number().int(),
  startingRunId: z.string().nullable(),
});
export type QueueRunOccupancy = z.infer<typeof QueueRunOccupancySchema>;

export type RunAdmission =
  | { admitted: true }
  | { admitted: false; occupancy: QueueRunOccupancy }
  | { admitted: false; operatorHold: true };

/**
 * Running decider runs of one (router ?1, queue ?2), and the oldest of them that
 * has not finished materializing its chunks (no `scheduler_runs` marker yet).
 */
const QUEUE_RUN_OCCUPANCY_SQL = `
  SELECT COUNT(*) AS activeRuns,
    MIN(CASE WHEN NOT EXISTS (SELECT 1 FROM scheduler_runs WHERE scheduler_runs.run_id = run.id)
      THEN run.id END) AS startingRunId
  FROM benchmark_runs AS run
  WHERE run.router = ?1 AND run.kind = 'decider' AND run.purpose = ?2 AND run.status = 'running'
`;

/**
 * Admission predicate for a *live operator pause* on the dispatch lock row (id 1,
 * `operator-pause-*`, `lease_until` in the future). The hold exists to freeze the queues: the
 * lease stops chunk claims, but nothing before the claim, so without this predicate a start
 * under the hold still writes a `running` run and claims work no dispatch can start. Only that
 * token prefix is a hold — an ordinary dispatch pass or the deploy intent on another row keeps
 * admitting platform work, and an expired operator token blocks nothing.
 *
 * Each admitting statement closes the `NOT EXISTS (` with its own admission-instant bind.
 */
const OPERATOR_HOLD_CLEAR_PREDICATE_SQL = `
    SELECT 1 FROM scheduler_dispatch_lock AS held
    WHERE held.id = 1
      AND held.token LIKE 'operator-pause-%'
      AND held.lease_until > `;

/**
 * Inserts a decider run only while its (router ?2, queue ?15) has no starting run
 * and fewer than ?17 active runs, so the check and the insert are one statement.
 * The run records the measurement revision it was started under (?16).
 */
const ADMIT_DECIDER_RUN_SQL = `
  INSERT INTO benchmark_runs (id, router, accuracy_noise_band, frontier_min_accuracy_delta,
    kind, status, started_at, min_accuracy, switch_cost_factor, best_accuracy_switch_threshold,
    max_concurrency, benchmark_user_id, benchmark_org_id, repetitions,
    classifier_max_p95_latency_ms, engine_identity, purpose, measurement_revision,
    admission_marker)
  SELECT ?1, ?2, ?3, ?4, 'decider', 'running', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
    ?16, ?18
  WHERE NOT EXISTS (
    SELECT 1 FROM benchmark_runs AS active
    WHERE active.router = ?2 AND active.kind = 'decider' AND active.purpose = ?15
      AND active.status = 'running'
      AND NOT EXISTS (SELECT 1 FROM scheduler_runs WHERE scheduler_runs.run_id = active.id)
  ) AND (
    SELECT COUNT(*) FROM benchmark_runs AS active
    WHERE active.router = ?2 AND active.kind = 'decider' AND active.purpose = ?15
      AND active.status = 'running'
  ) < ?17
  AND NOT EXISTS (${OPERATOR_HOLD_CLEAR_PREDICATE_SQL}?19)
`;

/**
 * Inserts a classifier run only while no operator pause holds the dispatch lock (?17). The
 * classifier path keeps no occupancy or starting-run predicate: the admin start picks the one
 * run, and the unique partial index is its backstop.
 */
const ADMIT_CLASSIFIER_RUN_SQL = `
  INSERT INTO benchmark_runs (id, router, accuracy_noise_band, frontier_min_accuracy_delta,
    kind, status, started_at, min_accuracy, switch_cost_factor, best_accuracy_switch_threshold,
    max_concurrency, benchmark_user_id, benchmark_org_id, repetitions,
    classifier_max_p95_latency_ms, engine_identity, purpose, measurement_revision)
  SELECT ?1, ?2, ?3, ?4, 'classifier', 'running', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
    ?15, ?16
  WHERE NOT EXISTS (${OPERATOR_HOLD_CLEAR_PREDICATE_SQL}?17)
`;

export async function getQueueRunOccupancy(
  db: D1Database,
  router: AutoRouter,
  purpose: BenchmarkRunPurpose
): Promise<QueueRunOccupancy> {
  return QueueRunOccupancySchema.parse(
    await db.prepare(QUEUE_RUN_OCCUPANCY_SQL).bind(router, purpose).first()
  );
}

/**
 * Writes a run with its model rows and carried summaries in one batch. A decider
 * run is admitted by the same statement that inserts it: only while no run of its
 * (router, queue) is still starting and fewer than MAX_RUNNING_RUNS_PER_QUEUE are
 * active, so overlapping drains cannot both start one. A classifier run is admitted
 * by its own insert only while no operator pause holds the dispatch lock. A refused
 * run leaves no rows.
 */
export async function insertRun(
  db: D1Database,
  run: {
    id: string;
    router?: AutoRouter;
    accuracy_noise_band?: number;
    frontier_min_accuracy_delta?: number;
    kind: BenchmarkKind;
    startedAt: string;
    min_accuracy: number;
    switch_cost_factor: number;
    best_accuracy_switch_threshold: number;
    max_concurrency: number;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    engine_identity: string;
    measurement_revision?: number;
    purpose?: BenchmarkRunPurpose;
  },
  models: RunModelRow[],
  carriedSummaries: BenchmarkModelSummary[]
): Promise<RunAdmission> {
  const orm = drizzle(db);
  const row = {
    id: run.id,
    router: run.router ?? 'efficient',
    accuracy_noise_band: run.accuracy_noise_band ?? 0.05,
    frontier_min_accuracy_delta: run.frontier_min_accuracy_delta ?? 0,
    kind: run.kind,
    status: 'running',
    started_at: run.startedAt,
    min_accuracy: run.min_accuracy,
    switch_cost_factor: run.switch_cost_factor,
    best_accuracy_switch_threshold: run.best_accuracy_switch_threshold,
    max_concurrency: run.max_concurrency,
    benchmark_user_id: run.benchmark_user_id,
    benchmark_org_id: run.benchmark_org_id,
    repetitions: run.repetitions,
    classifier_max_p95_latency_ms: run.classifier_max_p95_latency_ms,
    engine_identity: run.engine_identity,
    measurement_revision: run.measurement_revision ?? ACTIVE_MEASUREMENT_REVISION,
    purpose: run.purpose ?? 'platform',
  } satisfies typeof benchmarkRuns.$inferInsert;

  const dependents = [];
  for (let i = 0; i < models.length; i += RUN_MODEL_INSERT_BATCH_SIZE) {
    dependents.push(orm.insert(runModels).values(models.slice(i, i + RUN_MODEL_INSERT_BATCH_SIZE)));
  }

  for (let i = 0; i < carriedSummaries.length; i += MODEL_SUMMARY_INSERT_BATCH_SIZE) {
    const summaryChunk = carriedSummaries.slice(i, i + MODEL_SUMMARY_INSERT_BATCH_SIZE);
    dependents.push(
      orm.insert(modelSummaries).values(
        summaryChunk.map(s => ({
          run_id: run.id,
          model: s.model,
          variant: variantToStorage(s.variant),
          route_key: s.routeKey,
          accuracy: s.accuracy,
          avg_cost_usd: s.avgCostUsd,
          avg_input_tokens: s.avgInputTokens ?? null,
          avg_cached_input_tokens: s.avgCachedInputTokens ?? null,
          avg_output_tokens: s.avgOutputTokens ?? null,
          avg_reasoning_tokens: s.avgReasoningTokens ?? null,
          avg_latency_ms: s.avgLatencyMs,
          p50_latency_ms: s.p50LatencyMs,
          p95_latency_ms: s.p95LatencyMs,
          cases: s.cases,
          costed_cases: s.costedCases,
          errors: s.errors,
          timeouts: s.timeouts,
          route_accuracy: s.routeAccuracy,
          carried: true,
        }))
      )
    );
  }

  const dependentStatements = dependents.map(query => {
    const built = query.toSQL();
    return db.prepare(built.sql).bind(...built.params);
  });
  // D1 runs a batch as one transaction: a refused run's model and summary rows are
  // written under its id and deleted again before the batch commits.
  const refusedRunCleanup =
    dependents.length > 0
      ? ['run_models', 'model_summaries'].map(table =>
          db
            .prepare(
              `DELETE FROM ${table} WHERE run_id = ?1
                AND NOT EXISTS (SELECT 1 FROM benchmark_runs WHERE id = ?1)`
            )
            .bind(row.id)
        )
      : [];

  if (row.kind === 'classifier') {
    const [inserted] = await db.batch([
      db
        .prepare(ADMIT_CLASSIFIER_RUN_SQL)
        .bind(
          row.id,
          row.router,
          row.accuracy_noise_band,
          row.frontier_min_accuracy_delta,
          row.started_at,
          row.min_accuracy,
          row.switch_cost_factor,
          row.best_accuracy_switch_threshold,
          row.max_concurrency,
          row.benchmark_user_id,
          row.benchmark_org_id,
          row.repetitions,
          row.classifier_max_p95_latency_ms,
          row.engine_identity,
          row.purpose,
          row.measurement_revision,
          Date.now()
        ),
      ...dependentStatements,
      ...refusedRunCleanup,
    ]);
    if ((inserted.meta.changes ?? 0) > 0) return { admitted: true };
    return { admitted: false, operatorHold: true };
  }

  const [inserted, occupancy] = await db.batch([
    db.prepare(ADMIT_DECIDER_RUN_SQL).bind(
      row.id,
      row.router,
      row.accuracy_noise_band,
      row.frontier_min_accuracy_delta,
      row.started_at,
      row.min_accuracy,
      row.switch_cost_factor,
      row.best_accuracy_switch_threshold,
      row.max_concurrency,
      row.benchmark_user_id,
      row.benchmark_org_id,
      row.repetitions,
      row.classifier_max_p95_latency_ms,
      row.engine_identity,
      row.purpose,
      row.measurement_revision,
      MAX_RUNNING_RUNS_PER_QUEUE,
      // Post-cutover admission provenance: only a Worker that owns the paid flow writes
      // it, so a run admitted by an older image during the deploy overlap stays NULL and
      // is never claimable, initializable or dispatchable.
      crypto.randomUUID(),
      // The admission instant the operator-hold predicate compares the lease against.
      Date.now()
    ),
    db.prepare(QUEUE_RUN_OCCUPANCY_SQL).bind(row.router, row.purpose),
    ...dependentStatements,
    ...refusedRunCleanup,
  ]);
  if ((inserted.meta.changes ?? 0) > 0) return { admitted: true };
  return {
    admitted: false,
    occupancy: QueueRunOccupancySchema.parse(occupancy.results[0]),
  };
}

export async function getRunWithModels(
  db: D1Database,
  runId: string
): Promise<{ run: RunRow; models: RunModelRow[] } | null> {
  const orm = drizzle(db);
  const [run, models] = await Promise.all([
    orm.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, runId)).get(),
    orm.select().from(runModels).where(eq(runModels.run_id, runId)),
  ]);
  if (!run) return null;
  return { run, models };
}

const CASE_RESULT_COLUMNS = [
  'run_id',
  'model',
  'variant',
  'case_id',
  'route_key',
  'score',
  'latency_ms',
  'cost_usd',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'error',
  'fallback_reason',
  'route_hit',
  'retried',
  'exit_code',
  'output_prefix',
  'event_count',
  'last_event_types',
  'tool_calls',
  'tool_names',
  'step_count',
  'final_finish_reason',
  'rep',
  'timed_out',
  'prompt_revision',
] as const satisfies readonly (keyof CaseResultRow)[];

/**
 * Raw upsert so its statements can join a settlement batch. A paid case settles its
 * payer split in the same D1 transaction as the graded result
 * (`settlePaidCaseStatements`, src/paid-case-store.ts); `orm.batch` cannot take those
 * prepared statements, so the result write is prepared here instead.
 */
const CASE_RESULT_UPSERT_SQL = `
  INSERT INTO case_results (${CASE_RESULT_COLUMNS.join(', ')})
  VALUES (${CASE_RESULT_COLUMNS.map((_, index) => `?${index + 1}`).join(', ')})
  ON CONFLICT (run_id, model, variant, case_id, rep) DO UPDATE SET
    ${CASE_RESULT_COLUMNS.filter(column => column !== 'run_id' && column !== 'rep')
      .map(column => `${column} = excluded.${column}`)
      .join(',\n    ')}
`;

function caseResultParams(row: CaseResultRow): Array<string | number | null> {
  const bind = (value: unknown): string | number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string') return value;
    throw new Error(`Unsupported case result value type: ${typeof value}`);
  };
  return CASE_RESULT_COLUMNS.map(column => bind(row[column]));
}

/**
 * The graded result write and the pending-output cleanup, prepared. A settlement
 * batch appends the payer split (and any late-result restoration) after them.
 */
export function caseResultStatements(
  db: D1Database,
  row: CaseResultRow
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db.prepare(CASE_RESULT_UPSERT_SQL).bind(...caseResultParams(row)),
    db
      .prepare(
        `DELETE FROM pending_decider_outputs
        WHERE run_id = ? AND model = ? AND variant = ? AND case_id = ? AND rep = ?`
      )
      .bind(row.run_id, row.model, row.variant, row.case_id, row.rep),
  ];
}

/**
 * Write one graded case, optionally with statements that must commit atomically with
 * it (a paid case run's settlement). Returns each statement's result so a caller can
 * tell whether the settlement transition applied to its generation.
 */
export async function upsertCaseResult(
  db: D1Database,
  row: CaseResultRow,
  settlement: readonly D1PreparedStatement[] = []
): Promise<D1Result[]> {
  return db.batch([...caseResultStatements(db, row), ...settlement]);
}

/**
 * Statement {@link reuseDeciderCaseResults} runs per entry; exported for the query-plan test.
 * D1 keeps no planner statistics, so with a plain JOIN SQLite may scan every case_results
 * row per entry. CROSS JOIN pins the order: filter the runs, then seek each run's pair.
 */
export const PRIOR_CASE_RESULTS_REUSE_SQL = `
  WITH ranked AS (
    SELECT source.*,
      ROW_NUMBER() OVER (
        PARTITION BY source.case_id, source.rep
        ORDER BY run.started_at DESC, run.id DESC
      ) AS reuse_rank
    FROM benchmark_runs AS run
    CROSS JOIN case_results AS source
    WHERE run.id = source.run_id
      AND run.kind = 'decider' AND run.status IN ('completed', 'failed')
      AND run.router = ? AND run.engine_identity = ?
      -- A prior run of any repetition count contributes only the repetitions it
      -- measured, and only the repetitions this run measures: repetition r fills
      -- repetition r, so one stored repetition is never copied to two.
      AND source.rep < ?
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
  INSERT INTO case_results (
    run_id, model, variant, case_id, route_key, score, latency_ms, cost_usd,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    error, fallback_reason, route_hit, retried, exit_code, output_prefix,
    event_count, last_event_types, tool_calls, tool_names, step_count,
    final_finish_reason, rep, timed_out, prompt_revision
  )
  SELECT ?, model, variant, case_id, route_key, score, latency_ms, cost_usd,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    error, fallback_reason, route_hit, retried, exit_code, output_prefix,
    event_count, last_event_types, tool_calls, tool_names, step_count,
    final_finish_reason, rep, timed_out, prompt_revision
  FROM ranked WHERE reuse_rank = 1
  ON CONFLICT (run_id, model, variant, case_id, rep) DO NOTHING
`;

/** Pending-output twin of {@link PRIOR_CASE_RESULTS_REUSE_SQL}, with the same join order. */
export const PRIOR_PENDING_OUTPUTS_REUSE_SQL = `
  WITH ranked AS (
    SELECT source.*,
      ROW_NUMBER() OVER (
        PARTITION BY source.case_id, source.rep
        ORDER BY run.started_at DESC, run.id DESC
      ) AS reuse_rank
    FROM benchmark_runs AS run
    CROSS JOIN pending_decider_outputs AS source
    WHERE run.id = source.run_id
      AND run.kind = 'decider' AND run.status IN ('completed', 'failed')
      AND run.router = ? AND run.engine_identity = ?
      -- Same repetition rule as PRIOR_CASE_RESULTS_REUSE_SQL.
      AND source.rep < ?
      AND source.model = ? AND source.variant = ?
      AND NOT EXISTS (
        SELECT 1 FROM benchmark_profiles AS profile
        WHERE profile.router = run.router AND profile.engine_identity = run.engine_identity
          AND profile.repetitions = run.repetitions AND profile.model = source.model
          AND profile.variant = source.variant AND profile.invalidated_at IS NOT NULL
          AND run.started_at < profile.invalidated_at
      )
      AND CASE WHEN json_valid(source.payload) THEN
        json_type(source.payload, '$.result.exitCode') = 'integer'
        AND json_extract(source.payload, '$.result.exitCode') = 0
        AND json_type(source.payload, '$.result.timedOut') = 'false'
        AND json_extract(source.payload, '$.result.unavailableModelId') IS NULL
      ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM json_each(?) AS minimum
        WHERE minimum.key = source.case_id AND source.prompt_revision < minimum.value)
      AND NOT EXISTS (
        SELECT 1 FROM case_results AS graded
        WHERE graded.run_id = source.run_id AND graded.model = source.model
          AND graded.variant = source.variant AND graded.case_id = source.case_id
          AND graded.rep = source.rep
      )
  )
  INSERT INTO pending_decider_outputs (run_id, model, variant, case_id, rep, payload,
    prompt_revision)
  SELECT ?, model, variant, case_id, rep, payload, prompt_revision FROM ranked
  WHERE reuse_rank = 1 AND NOT EXISTS (
    SELECT 1 FROM case_results AS destination
    WHERE destination.run_id = ? AND destination.model = ranked.model
      AND destination.variant = ranked.variant AND destination.case_id = ranked.case_id
      AND destination.rep = ranked.rep
  )
  ON CONFLICT (run_id, model, variant, case_id, rep) DO NOTHING
`;

/**
 * Copy each pair's newest compatible graded case (and recoverable pending output) from
 * earlier runs into this run. A result measured below its case's entry in
 * `minimumRevisions` (src/measurement-revision.ts) is never copied, so that case runs again.
 *
 * Repetitions are compared per index, not per run: a prior run's repetition `r` is one
 * valid independent draw for this run's repetition `r` whenever this run takes more than
 * `r` repetitions, whatever the prior run's repetition count was. A three-repetition run
 * therefore reuses one-repetition priors for its first repetition and measures the rest,
 * and a one-repetition run reuses a longer prior's first repetition only.
 */
export async function reuseDeciderCaseResults(
  db: D1Database,
  params: {
    runId: string;
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    entries: readonly BenchmarkPair[];
    minimumRevisions: Readonly<Record<string, number>>;
  }
): Promise<number> {
  const minimumRevisions = JSON.stringify(params.minimumRevisions);
  let copied = 0;
  for (let offset = 0; offset < params.entries.length; offset += 10) {
    const statements: D1PreparedStatement[] = [];
    for (const entry of params.entries.slice(offset, offset + 10)) {
      if (entry.model.startsWith('~')) continue;
      const bindings = [
        params.router,
        params.engineIdentity,
        params.repetitions,
        entry.model,
        variantToStorage(entry.variant),
        minimumRevisions,
        params.runId,
      ];
      statements.push(
        db.prepare(PRIOR_CASE_RESULTS_REUSE_SQL).bind(...bindings),
        db.prepare(PRIOR_PENDING_OUTPUTS_REUSE_SQL).bind(...bindings, params.runId),
        db
          .prepare(`
            DELETE FROM pending_decider_outputs
            WHERE model = ? AND variant = ? AND EXISTS (
              SELECT 1 FROM case_results AS graded
              WHERE graded.run_id = pending_decider_outputs.run_id
                AND graded.model = pending_decider_outputs.model
                AND graded.variant = pending_decider_outputs.variant
                AND graded.case_id = pending_decider_outputs.case_id
                AND graded.rep = pending_decider_outputs.rep
            )
          `)
          .bind(entry.model, variantToStorage(entry.variant))
      );
    }
    if (statements.length === 0) continue;
    const results = await db.batch(statements);
    for (let index = 0; index < results.length; index += 3) {
      copied += results[index].meta.changes ?? 0;
    }
  }
  return copied;
}

/**
 * Adopt the newest compatible measured result for one exact case slot, from any run of
 * this engine (settled, failed or still running), into `runId`. The last check before a
 * paid inference: another run may have measured this case after this run materialized its
 * chunks, and paying again for it would be a duplicate. Same eligibility predicates as
 * {@link PRIOR_CASE_RESULTS_REUSE_SQL}: successful exit, not timed out, above the case's
 * minimum revision, and not preceded by the profile's invalidation.
 */
const ADOPT_CASE_RESULT_SQL = `
  INSERT INTO case_results (
    run_id, model, variant, case_id, route_key, score, latency_ms, cost_usd,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    error, fallback_reason, route_hit, retried, exit_code, output_prefix,
    event_count, last_event_types, tool_calls, tool_names, step_count,
    final_finish_reason, rep, timed_out, prompt_revision
  )
  SELECT ?1, candidate.model, candidate.variant, candidate.case_id, candidate.route_key,
    candidate.score, candidate.latency_ms, candidate.cost_usd, candidate.input_tokens,
    candidate.cached_input_tokens, candidate.output_tokens, candidate.reasoning_tokens,
    candidate.error, candidate.fallback_reason, candidate.route_hit, candidate.retried,
    candidate.exit_code, candidate.output_prefix, candidate.event_count,
    candidate.last_event_types, candidate.tool_calls, candidate.tool_names,
    candidate.step_count, candidate.final_finish_reason, candidate.rep, candidate.timed_out,
    candidate.prompt_revision
  FROM (
    SELECT source.*
    FROM benchmark_runs AS run
    CROSS JOIN case_results AS source
    WHERE run.id = source.run_id
      AND run.kind = 'decider' AND run.status IN ('completed', 'failed', 'running')
      AND run.router = ?2 AND run.engine_identity = ?3
      AND source.model = ?4 AND source.variant = ?5 AND source.rep = ?6
      AND source.case_id = ?7
      AND source.error IS NULL AND source.timed_out = 0 AND source.exit_code = 0
      AND source.prompt_revision >= ?8
      AND NOT EXISTS (
        SELECT 1 FROM benchmark_profiles AS profile
        WHERE profile.router = run.router AND profile.engine_identity = run.engine_identity
          AND profile.repetitions = run.repetitions AND profile.model = source.model
          AND profile.variant = source.variant AND profile.invalidated_at IS NOT NULL
          AND run.started_at < profile.invalidated_at
      )
    ORDER BY run.started_at DESC, run.id DESC
    LIMIT 1
  ) AS candidate
  -- SQLite requires a WHERE between a derived-table alias and ON CONFLICT in
  -- INSERT…SELECT; without it the whole statement fails to prepare.
  WHERE true
  ON CONFLICT (run_id, model, variant, case_id, rep) DO NOTHING
`;

/** Pending-output twin of {@link ADOPT_CASE_RESULT_SQL}, for an ungraded durable output. */
const ADOPT_PENDING_OUTPUT_SQL = `
  INSERT INTO pending_decider_outputs (run_id, model, variant, case_id, rep, payload,
    prompt_revision)
  SELECT ?1, candidate.model, candidate.variant, candidate.case_id, candidate.rep,
    candidate.payload, candidate.prompt_revision
  FROM (
    SELECT source.*
    FROM benchmark_runs AS run
    CROSS JOIN pending_decider_outputs AS source
    WHERE run.id = source.run_id
      AND run.kind = 'decider' AND run.status IN ('completed', 'failed', 'running')
      AND run.router = ?2 AND run.engine_identity = ?3
      AND source.model = ?4 AND source.variant = ?5 AND source.rep = ?6
      AND source.case_id = ?7
      AND NOT EXISTS (
        SELECT 1 FROM benchmark_profiles AS profile
        WHERE profile.router = run.router AND profile.engine_identity = run.engine_identity
          AND profile.repetitions = run.repetitions AND profile.model = source.model
          AND profile.variant = source.variant AND profile.invalidated_at IS NOT NULL
          AND run.started_at < profile.invalidated_at
      )
      AND CASE WHEN json_valid(source.payload) THEN
        json_type(source.payload, '$.result.exitCode') = 'integer'
        AND json_extract(source.payload, '$.result.exitCode') = 0
        AND json_type(source.payload, '$.result.timedOut') = 'false'
        AND json_extract(source.payload, '$.result.unavailableModelId') IS NULL
      ELSE 0 END
      AND source.prompt_revision >= ?8
      AND NOT EXISTS (
        SELECT 1 FROM case_results AS graded
        WHERE graded.run_id = source.run_id AND graded.model = source.model
          AND graded.variant = source.variant AND graded.case_id = source.case_id
          AND graded.rep = source.rep
      )
    ORDER BY run.started_at DESC, run.id DESC
    LIMIT 1
  ) AS candidate
  -- SQLite requires a WHERE between a derived-table alias and ON CONFLICT in
  -- INSERT…SELECT; without it the whole statement fails to prepare.
  WHERE true
  ON CONFLICT (run_id, model, variant, case_id, rep) DO NOTHING
`;

export type CaseResultAdoption = 'graded' | 'pending' | 'none';

/**
 * Copy one case slot's reusable measurement (graded result, else recoverable pending
 * output) into `runId`. Returns what landed: a graded row, a pending output to grade, or
 * nothing. Idempotent — a slot this run already holds is left alone.
 */
export async function adoptReusableCaseResult(
  db: D1Database,
  input: {
    runId: string;
    router: AutoRouter;
    engineIdentity: string;
    model: string;
    /** Storage-form variant ('' = default). */
    variant: string;
    rep: number;
    caseId: string;
    minimumRevision: number;
  }
): Promise<CaseResultAdoption> {
  const bindings = [
    input.runId,
    input.router,
    input.engineIdentity,
    input.model,
    input.variant,
    input.rep,
    input.caseId,
    input.minimumRevision,
  ];
  const results = await db.batch<{ hits: number }>([
    db.prepare(ADOPT_CASE_RESULT_SQL).bind(...bindings),
    db.prepare(ADOPT_PENDING_OUTPUT_SQL).bind(...bindings),
    db
      .prepare(
        `DELETE FROM pending_decider_outputs
        WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
          AND EXISTS (
            SELECT 1 FROM case_results AS graded
            WHERE graded.run_id = ?1 AND graded.model = ?2 AND graded.variant = ?3
              AND graded.case_id = ?4 AND graded.rep = ?5
          )`
      )
      .bind(input.runId, input.model, input.variant, input.caseId, input.rep),
    db
      .prepare(
        `SELECT COUNT(*) AS hits FROM case_results
        WHERE run_id = ? AND model = ? AND variant = ? AND case_id = ? AND rep = ?`
      )
      .bind(input.runId, input.model, input.variant, input.caseId, input.rep),
    db
      .prepare(
        `SELECT COUNT(*) AS hits FROM pending_decider_outputs
        WHERE run_id = ? AND model = ? AND variant = ? AND case_id = ? AND rep = ?`
      )
      .bind(input.runId, input.model, input.variant, input.caseId, input.rep),
  ]);
  if ((results[3]?.results[0]?.hits ?? 0) > 0) return 'graded';
  if ((results[4]?.results[0]?.hits ?? 0) > 0) return 'pending';
  return 'none';
}

/**
 * Cases each lane is expected to produce, from its materialized chunks. A run whose
 * chunks hold only the slots that actually need measuring (a paid request after reuse)
 * is complete at that count; a platform run's chunks cover the full case list, so this
 * equals the catalog count. Empty when the run has no chunks yet (whole-run legacy work).
 */
export async function laneCaseExpectations(
  db: D1Database,
  runId: string
): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT model, variant, rep, SUM(json_array_length(case_ids)) AS n
      FROM scheduler_chunks WHERE run_id = ? GROUP BY model, variant, rep`
    )
    .bind(runId)
    .all<{ model: string; variant: string; rep: number; n: number }>();
  return new Map(
    rows.results.map(row => [JSON.stringify([row.model, row.variant, row.rep]), Number(row.n)])
  );
}

/**
 * The queued case slots of a paid request that an executor may still claim: its own case
 * rows still `queued`, whose global case run is queued (claimable) or running (another
 * scan of the fence will adopt it). Terminal case runs are left out, so a run neither
 * waits on nor fails over a case nobody can measure any more.
 */
export async function listPaidRequestCasePlan(
  db: D1Database,
  input: { requestId: string }
): Promise<
  Array<{ engine_identity: string; model: string; variant: string; rep: number; case_id: string }>
> {
  const rows = await db
    .prepare(
      `SELECT request_case.engine_identity, request_case.model, request_case.variant,
        request_case.rep, request_case.case_id
      FROM paid_benchmark_request_cases AS request_case
      JOIN benchmark_case_runs AS case_run
        ON case_run.engine_identity = request_case.engine_identity
        AND case_run.model = request_case.model AND case_run.variant = request_case.variant
        AND case_run.rep = request_case.rep AND case_run.case_id = request_case.case_id
      WHERE request_case.request_id = ? AND request_case.status = 'queued'
        AND case_run.status IN ('queued', 'running')
      ORDER BY request_case.model, request_case.variant, request_case.rep,
        request_case.case_id`
    )
    .bind(input.requestId)
    .all<{
      engine_identity: string;
      model: string;
      variant: string;
      rep: number;
      case_id: string;
    }>();
  return rows.results;
}

/**
 * Exact (model, variant) pairs a live paid request of this owner still owes work for, in one
 * scoped read.
 *
 * These are the pairs `enrollPaidPairStatements` creates with both demand flags off and
 * `releaseUncommittedRunClaimsStatement` returns to `pending` after a capped launch, and whose
 * `ready`→`pending` reopen keeps the original request time. The registry row therefore looks
 * inert to a queue probe while the explicit request is really waiting on it, so the status
 * readers consult this scoped evidence instead of loosening the flag rule.
 *
 * Rows come from this owner's request for this router and engine identity only, across all
 * repetitions (a reopen is not repetition-scoped), and only while the request is `preparing` or
 * `active`. A pair whose request cases are all terminal (`reused`, `done`, `failed`, `paused`)
 * is not waiting: it falls back to the registry row alone.
 */
export async function listPaidRequestedPairs(
  db: D1Database,
  input: {
    ownerType: 'user' | 'org';
    ownerId: string;
    router: AutoRouter;
    engineIdentity: string;
    models: readonly string[];
  }
): Promise<Set<string>> {
  if (input.models.length === 0) return new Set();
  const rows = await db
    .prepare(
      `SELECT DISTINCT rq.model, rq.variant
      FROM paid_benchmark_requests AS req
      JOIN paid_benchmark_request_cases AS rq ON rq.request_id = req.id
      WHERE req.owner_type = ? AND req.owner_id = ? AND req.router = ?
        AND req.engine_identity = ? AND req.status IN ('preparing', 'active')
        AND rq.model IN (SELECT value FROM json_each(?))
        AND rq.status IN ('queued', 'running')`
    )
    .bind(
      input.ownerType === 'org' ? 'organization' : 'user',
      input.ownerId,
      input.router,
      input.engineIdentity,
      JSON.stringify([...new Set(input.models)])
    )
    .all<{ model: string; variant: string }>();
  return new Set(rows.results.map(row => exactPairKey(row.model, row.variant)));
}

/** True while the exact pair is a member of the automatic platform pool. */
export async function isPlatformPoolPair(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  model: string,
  variant: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM benchmark_profiles
      WHERE router = ? AND model = ? AND variant = ? AND engine_identity = ?
        AND repetitions = ? AND platform_requested = 1
      LIMIT 1`
    )
    .bind(
      current.router ?? 'efficient',
      model,
      variant,
      current.engineIdentity,
      current.repetitions
    )
    .first();
  return row !== null;
}

/**
 * The cutover instant, read from the single marker row. The first post-cutover pass claims
 * it (`ensureBenchmarkCutover`), so every worker sees the same timestamp. A missing table
 * throws: callers fail closed rather than schedule legacy work.
 */
export async function readBenchmarkCutover(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare('SELECT cutover_at FROM benchmark_cutover WHERE id = 1')
    .first<{ cutover_at: string }>();
  return row?.cutover_at ?? null;
}

/**
 * The router's readiness epoch: one exact-key read, bumped inside the same transaction as every
 * readiness or provenance change to a profile row (migration 0039's triggers). A caller compares it
 * with the epoch its cached table recorded; a mismatch means the served ranking may have moved.
 *
 * A missing row or a failed read throws: the serving Worker must fail retryably rather than keep
 * serving a table it cannot prove current.
 */
export async function readBenchmarkReadinessEpoch(
  db: D1Database,
  router: AutoRouter
): Promise<number> {
  const row = await db
    .prepare('SELECT epoch FROM benchmark_readiness_epoch WHERE router = ?')
    .bind(router)
    .first<{ epoch: number }>();
  if (!row) throw new Error(`benchmark readiness epoch missing for ${router}`);
  return row.epoch;
}

/** Claim the cutover instant if nobody has; returns the durable one. */
export async function ensureBenchmarkCutover(
  db: D1Database,
  nowIso: string = new Date().toISOString()
): Promise<string> {
  await db
    .prepare(
      'INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?) ON CONFLICT (id) DO NOTHING'
    )
    .bind(nowIso)
    .run();
  const cutoverAt = await readBenchmarkCutover(db);
  // A successful insert that cannot be read back leaves this pass with its own instant:
  // the row is the durable marker for every later pass, and a *failing* read still throws
  // out of `readBenchmarkCutover` (the caller then fails closed).
  return cutoverAt ?? nowIso;
}

/**
 * `requested_at` of work that is parked: earlier than any cutover, so the drain's
 * `requested_at >= cutover` filter never picks it up. An explicit admin requeue or a new
 * membership commit re-stamps it.
 */
export const PARKED_REQUESTED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Park the registry claims of the given runs, without touching measurement rows or
 * failure counters: rows go back to `pending` with no owner and a parked request time,
 * and their re-measure claims are dropped. The pair keeps its previous `ready`
 * measurement (a re-measure claim never changes it) and no drain picks it up again until
 * someone explicitly re-requests it.
 */
export async function quarantineProfileClaimsForRuns(
  db: D1Database,
  runIds: readonly string[],
  nowIso: string = new Date().toISOString()
): Promise<number> {
  let moved = 0;
  for (let offset = 0; offset < runIds.length; offset += RUN_ID_FILTER_BATCH_SIZE) {
    const ids = runIds.slice(offset, offset + RUN_ID_FILTER_BATCH_SIZE);
    const placeholders = ids.map(() => '?').join(', ');
    const [profiles, remeasures] = await db.batch([
      db
        .prepare(
          // Only a live claim is parked. A run can still be pointed at by a `ready` row it
          // measured (a partially measured legacy run, or an admin-cancelled run whose
          // completed entries were published): that row keeps its measurement, its
          // provenance and its place in the routing table. Parking it would strip a valid
          // result from the pool and re-admit work nobody asked for again.
          `UPDATE benchmark_profiles
          SET status = 'pending', run_id = NULL, requested_at = ?, updated_at = ?
          WHERE run_id IN (${placeholders}) AND status = 'running'`
        )
        .bind(PARKED_REQUESTED_AT, nowIso, ...ids),
      db
        .prepare(
          `UPDATE profile_remeasures SET run_id = NULL, claimed_at = NULL
          WHERE run_id IN (${placeholders})`
        )
        .bind(...ids),
    ]);
    moved += profiles.meta.changes ?? 0;
    moved += remeasures.meta.changes ?? 0;
  }
  return moved;
}

/**
 * Slots a paid lane no longer has to produce because their case run was cancelled (a
 * payer paused or the platform run was cancelled) and holds no usable result. They are
 * subtracted from the lane's materialized expectation so the run settles instead of
 * waiting forever, and the pair is left unpublished rather than ranked on a gap.
 */
export async function laneCancelledCaseCounts(
  db: D1Database,
  runId: string
): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT chunk.model, chunk.variant, chunk.rep, COUNT(*) AS n
      FROM benchmark_runs AS run
      CROSS JOIN scheduler_chunks AS chunk
      CROSS JOIN json_each(chunk.case_ids) AS planned
      JOIN benchmark_case_runs AS case_run
        ON case_run.engine_identity = run.engine_identity
        AND case_run.model = chunk.model AND case_run.variant = chunk.variant
        AND case_run.rep = chunk.rep AND case_run.case_id = planned.value
      WHERE chunk.run_id = ? AND run.id = chunk.run_id
        AND case_run.status IN ('cancelled', 'paused') AND case_run.result_usable = 0
      GROUP BY chunk.model, chunk.variant, chunk.rep`
    )
    .bind(runId)
    .all<{ model: string; variant: string; rep: number; n: number }>();
  return new Map(
    rows.results.map(row => [JSON.stringify([row.model, row.variant, row.rep]), Number(row.n)])
  );
}

/**
 * The generation of a case run this run is executing right now, if any. A result written
 * by this run settles exactly that generation; an adopted result (executed by another run)
 * resolves to null and never touches a payer set.
 */
export async function readOwnedCaseGeneration(
  db: D1Database,
  runId: string,
  key: { engineIdentity: string; model: string; variant: string; rep: number; caseId: string }
): Promise<{ runId: string; token: string; generation: number } | null> {
  const row = await db
    .prepare(
      `SELECT executor_token, generation FROM benchmark_case_runs
      WHERE engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
        AND executor_run_id = ? AND executor_token IS NOT NULL AND status = 'running'`
    )
    .bind(key.engineIdentity, key.model, key.variant, key.rep, key.caseId, runId)
    .first<{ executor_token: string; generation: number }>();
  if (!row) return null;
  return { runId, token: row.executor_token, generation: row.generation };
}

/**
 * Move a running generation's canonical start to a further paid call its own run and
 * claim token make. The launch fence compares `started_at` to ISO(attemptStartedAt), so a
 * retry that moved only the run's ledger row would be refused as `not_live`.
 */
export function restartPaidCaseRunStatement(
  db: D1Database,
  input: {
    key: { engineIdentity: string; model: string; variant: string; rep: number; caseId: string };
    executor: { runId: string; token: string };
    startedAt: number;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE benchmark_case_runs SET started_at = ?, updated_at = ?
      WHERE engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
        AND executor_run_id = ? AND executor_token = ? AND status = 'running'`
    )
    .bind(
      new Date(input.startedAt).toISOString(),
      new Date(input.startedAt).toISOString(),
      input.key.engineIdentity,
      input.key.model,
      input.key.variant,
      input.key.rep,
      input.key.caseId,
      input.executor.runId,
      input.executor.token
    );
}

/**
 * Settle the canonical case run when a result is saved: the terminal `settled` transition
 * and `result_usable` commit in the same D1 batch as the graded row, so a settled case run
 * can never exist without a usable result. Billing is charged just in time per model
 * request by the gateway, not here — no payer split, no charge row, no outbox.
 *
 * Result indexes: [0] running→settled for this exact generation, [1] late-result usable
 * flag on an already terminal case.
 */
export function completePaidCaseStatements(
  db: D1Database,
  input: {
    key: { engineIdentity: string; model: string; variant: string; rep: number; caseId: string };
    generation: { runId: string; token: string; generation: number };
    resultUsable: boolean;
    settlementId: string;
    now?: number;
  }
): D1PreparedStatement[] {
  const at = new Date(input.now ?? Date.now()).toISOString();
  const keyPredicate = `engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?`;
  return [
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'settled', settled_at = ?, updated_at = ?, settlement_id = ?,
          result_usable = ?, failure_reason = NULL
        WHERE ${keyPredicate} AND status = 'running'
          AND executor_run_id = ? AND executor_token = ? AND generation = ?`
      )
      .bind(
        at,
        at,
        input.settlementId,
        input.resultUsable ? 1 : 0,
        input.key.engineIdentity,
        input.key.model,
        input.key.variant,
        input.key.rep,
        input.key.caseId,
        input.generation.runId,
        input.generation.token,
        input.generation.generation
      ),
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET result_usable = CASE WHEN ? = 1 THEN 1 ELSE result_usable END, updated_at = ?
        WHERE ${keyPredicate} AND status IN ('settled', 'cancelled', 'failed')
          AND executor_run_id = ? AND executor_token = ? AND generation = ?`
      )
      .bind(
        input.resultUsable ? 1 : 0,
        at,
        input.key.engineIdentity,
        input.key.model,
        input.key.variant,
        input.key.rep,
        input.key.caseId,
        input.generation.runId,
        input.generation.token,
        input.generation.generation
      ),
  ];
}

/**
 * Terminalize the paid case rows of one pair's case runs: the pair is permanently
 * unavailable, so its queued/running generations become `failed` with the exact reason and
 * their request rows show `failed`. Without this the request would wait forever on a case
 * that can never be measured. Settled rows and their results are never touched.
 */
/**
 * The paid-link terminalization statements, prepared so a caller can commit them in the same
 * D1 batch as the scheduler transition that killed the lane (`failDeadLaneAndPaidLinks`,
 * src/run.ts). Both commit or neither does: a paid link can never survive the lane failure
 * that made it unmeasurable, and a lane can never die while its links wait forever.
 */
export function failPaidCasesForUnavailablePairStatements(
  db: D1Database,
  input: {
    engineIdentity: string;
    model: string;
    variant: string;
    reason: string;
    transitionId: string;
    /**
     * The exact scheduler claim that owns this lane, when the caller is a scheduler pass.
     * Both statements then require that claim to still be `active` under its own id and
     * token, so a stale claim that lost the lane writes nothing at all — not even the paid
     * links. Omitted for a direct, non-scheduler caller, which is the only case allowed to
     * terminalize without proving a live claim.
     */
    claim?: { id: string; token: string };
    now?: number;
  }
): D1PreparedStatement[] {
  const at = new Date(input.now ?? Date.now()).toISOString();
  const pairPredicate = `engine_identity = ? AND model = ? AND variant = ?`;
  const pairBindings = [input.engineIdentity, input.model, input.variant];
  const claimPredicate = input.claim
    ? `EXISTS (
        SELECT 1 FROM scheduler_chunks AS owner
        WHERE owner.id = ? AND owner.token = ? AND owner.status = 'active'
      )`
    : '1 = 1';
  const claimBindings: Array<string> = input.claim ? [input.claim.id, input.claim.token] : [];
  // Two independent fences, both required:
  // 1. the exact pair (`engine_identity`, `model`, `variant`) — a `rep`/`case_id` pair is
  //    shared by every model measured on the same cases, so correlating on those alone would
  //    fail a different model's rows;
  // 2. the transition id this call just wrote, so only rows whose own case run was failed by
  //    this batch move. Covered, settled, completed and later generations keep their state.
  // A scheduler caller additionally fences both writes on its own live claim, so a stale
  // claim can never terminalize a link another pass is about to measure.
  return [
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'failed', failure_reason = ?, settled_at = ?, settlement_id = ?,
          updated_at = ?
        WHERE ${pairPredicate} AND status IN ('queued', 'running') AND platform_covered = 0
          AND ${claimPredicate}
          -- Liveness comes from the owned claim and the live status, not from settlement
          -- metadata: a reclaimed generation legitimately carries a *stale* settlement_id
          -- (the store bumps generation without clearing it), and this statement overwrites
          -- it with this batch's own id below. Idempotency is the status predicate: a repeat
          -- pass finds the row already terminal and matches nothing.`
      )
      .bind(input.reason, at, input.transitionId, at, ...pairBindings, ...claimBindings),
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases
        SET status = 'failed', reason = ?, updated_at = ?
        WHERE ${pairPredicate}
          AND status IN ('queued', 'running')
          AND ${claimPredicate}
          AND EXISTS (
            SELECT 1 FROM benchmark_case_runs AS case_run
            WHERE case_run.engine_identity = paid_benchmark_request_cases.engine_identity
              AND case_run.model = paid_benchmark_request_cases.model
              AND case_run.variant = paid_benchmark_request_cases.variant
              AND case_run.rep = paid_benchmark_request_cases.rep
              AND case_run.case_id = paid_benchmark_request_cases.case_id
              AND case_run.status = 'failed'
              AND case_run.settlement_id = ?
          )`
      )
      .bind(input.reason, at, ...pairBindings, ...claimBindings, input.transitionId),
  ];
}

export async function failPaidCasesForUnavailablePair(
  db: D1Database,
  input: {
    engineIdentity: string;
    model: string;
    variant: string;
    reason: string;
    transitionId: string;
    now?: number;
  }
): Promise<number> {
  const [runs] = await db.batch(failPaidCasesForUnavailablePairStatements(db, input));
  return runs.meta.changes ?? 0;
}

/**
 * Enroll a pair the platform has never seen, on an explicit paid confirmation only.
 *
 * A pair with no registry row cannot be claimed by a run, so the first-ever paid benchmark
 * of a custom-only model needs the row created. It is created `pending` with **both demand
 * flags off**: the platform queue never picks it up, and only the confirmed request's own
 * claim moves it to `running`. An existing row is left exactly as it is
 * (`ON CONFLICT DO NOTHING`), so a ready pair is reused rather than re-queued.
 */
export function enrollPaidPairStatements(
  db: D1Database,
  input: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    entries: readonly BenchmarkPair[];
    requestedAt: string;
  }
): D1PreparedStatement[] {
  return input.entries.map(entry =>
    db
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity,
          repetitions, status, run_id, failure_reason, requested_at, updated_at,
          completed_at, platform_requested, user_requested)
        VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, 0, 0)
        ON CONFLICT (router, model, variant, engine_identity, repetitions) DO NOTHING`
      )
      .bind(
        input.router,
        entry.model,
        variantToStorage(entry.variant),
        input.engineIdentity,
        input.repetitions,
        input.requestedAt,
        input.requestedAt
      )
  );
}

/**
 * Release a proven-unspent generation and clear its scheduler ledger in ONE D1 batch.
 *
 * The rule the user asked for is all-or-nothing: a crash must never leave a `queued` case run
 * next to a stale claimed ledger row (that stalls work everyone agreed was never dispatched),
 * and a refused release must never clear the ledger (that would reopen work which may have
 * been admitted). Both statements therefore commit in a single transaction, and the deletes
 * are conditioned on the post-state the release itself produces:
 *
 * - `benchmark_case_runs` for this exact case key is `queued`, has no executor, and its
 *   `generation` is still the generation we released. A refused release leaves it `running`
 *   under our token, so the condition is false and the ledger row survives untouched.
 * - the ledger row is identified by its own token and start, so another attempt's row is
 *   never deleted.
 *
 * `releaseChanges` is the release statement's own `meta.changes`, so the caller can report
 * whether the batch actually reopened the slot without a second read.
 */
export function releaseUnbilledPaidGenerationBatch(
  db: D1Database,
  input: {
    release: readonly D1PreparedStatement[];
    key: { engineIdentity: string; model: string; variant: string; rep: number; caseId: string };
    executor: { runId: string; token: string; startedAt: number };
    generation: number;
  }
): D1PreparedStatement[] {
  const queuedByUs = `EXISTS (
    SELECT 1 FROM benchmark_case_runs
    WHERE engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
      AND status = 'queued' AND executor_run_id IS NULL AND executor_token IS NULL
      AND generation = ?
  )`;
  const queuedParams: Array<string | number> = [
    input.key.engineIdentity,
    input.key.model,
    input.key.variant,
    input.key.rep,
    input.key.caseId,
    input.generation,
  ];
  const ledgerKey = `run_id = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
    AND token = ?`;
  const ledgerParams: Array<string | number> = [
    input.executor.runId,
    input.key.model,
    input.key.variant,
    input.key.rep,
    input.key.caseId,
    input.executor.token,
  ];
  return [
    ...input.release,
    // `pending_decider_outputs` keys on the run's slot only (no token column); it is deleted
    // in the same transaction, so the queued post-state still gates it.
    db
      .prepare(
        `DELETE FROM pending_decider_outputs
        WHERE run_id = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
          AND prompt_revision IS NOT NULL AND ${queuedByUs}`
      )
      .bind(
        input.executor.runId,
        input.key.model,
        input.key.variant,
        input.key.rep,
        input.key.caseId,
        ...queuedParams
      ),
    db
      .prepare(`DELETE FROM scheduler_executions WHERE ${ledgerKey} AND ${queuedByUs}`)
      .bind(...ledgerParams, ...queuedParams),
  ];
}

/**
 * Release claims this exact run id holds, but only while it has no committed run row.
 *
 * Two launchers of one paid request share a deterministic run id, so both can claim the same
 * registry rows: the winner's claims are indistinguishable from the loser's by run id alone.
 * The loser must therefore never release them after the winner's row committed — that would
 * strip the run that is about to measure them. This single-statement form makes that check
 * and the release one write, so a commit racing the release either wins (no release) or
 * loses (the release happens before it, and the winner's own claim sees a clean slot).
 */
export function releaseUncommittedRunClaimsStatement(
  db: D1Database,
  runId: string,
  nowIso: string = new Date().toISOString()
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE benchmark_profiles
      SET status = 'pending', run_id = NULL, updated_at = ?
      WHERE run_id = ? AND status = 'running'
        AND NOT EXISTS (SELECT 1 FROM benchmark_runs WHERE id = ?)`
    )
    .bind(nowIso, runId, runId);
}

export type PaidCaseCancelTarget = {
  key: {
    engineIdentity: string;
    model: string;
    variant: string;
    rep: number;
    caseId: string;
  };
  generation: { runId: string; token: string; generation: number };
};

/**
 * Durable cancellation intent for one exact running generation. The intent commits with
 * the cancel that fenced it (the payer set is already removed), so an isolate that dies
 * before reaching the container leaves a retryable row instead of an orphaned inference.
 */
export function queuePaidCancellationIntentStatements(
  db: D1Database,
  targets: readonly PaidCaseCancelTarget[],
  now: number = Date.now()
): D1PreparedStatement[] {
  const at = new Date(now).toISOString();
  return targets.map(target =>
    db
      .prepare(
        `INSERT INTO paid_benchmark_cancellations (
          engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, status, attempts, available_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM benchmark_case_runs
          WHERE engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
            AND executor_run_id = ? AND executor_token = ? AND generation = ?
            AND status IN ('cancelled', 'failed')
        )
        ON CONFLICT DO NOTHING`
      )
      .bind(
        target.key.engineIdentity,
        target.key.model,
        target.key.variant,
        target.key.rep,
        target.key.caseId,
        target.generation.generation,
        target.generation.runId,
        target.generation.token,
        now,
        at,
        at,
        target.key.engineIdentity,
        target.key.model,
        target.key.variant,
        target.key.rep,
        target.key.caseId,
        target.generation.runId,
        target.generation.token,
        target.generation.generation
      )
  );
}

export type PaidCancellationIntent = {
  engine_identity: string;
  model: string;
  variant: string;
  rep: number;
  case_id: string;
  generation: number;
  executor_run_id: string;
  executor_token: string;
  attempts: number;
  /** Scheduler slot the generation runs in, when its chunk still holds one. */
  slot: number | null;
  /** Start of the ledgered paid call this generation owns. */
  attempt_started_at: number | null;
};

/** Pending cancellation intents whose backoff has elapsed, with what a caller needs to signal. */
export async function listPendingPaidCancellations(
  db: D1Database,
  now: number,
  limit = 8,
  /**
   * Restrict the pass to the intents one mutation just wrote. A pause passes its request id,
   * an operator's platform-run cancel passes the exact executor run (one bind, so a run with
   * many cases stays far below D1's bound-variable ceiling).
   */
  scope: {
    /** The request whose case keys this pass may signal (owner plan scoping). */
    requestId?: string;
    /** One exact executor run (an operator's platform-run cancel). One bind, any size. */
    executorRunId?: string;
    /** Oldest created_at accepted, so a cancel pass cannot pick up other runs' intents. */
    createdAfter?: number;
  } = {}
): Promise<PaidCancellationIntent[]> {
  const predicates: string[] = [];
  const scopeBindings: Array<string | number> = [];
  if (scope.requestId !== undefined) {
    predicates.push(`EXISTS (
      SELECT 1 FROM paid_benchmark_request_cases AS request_case
      WHERE request_case.request_id = ?
        AND request_case.engine_identity = cancellation.engine_identity
        AND request_case.model = cancellation.model
        AND request_case.variant = cancellation.variant
        AND request_case.rep = cancellation.rep
        AND request_case.case_id = cancellation.case_id
    )`);
    scopeBindings.push(scope.requestId);
  }
  if (scope.executorRunId !== undefined) {
    // One bind regardless of how many cases the run owns: a wide admin cancel must not
    // approach D1's bound-variable ceiling.
    predicates.push('cancellation.executor_run_id = ?');
    scopeBindings.push(scope.executorRunId);
  }
  if (scope.createdAfter !== undefined) {
    // `created_at` is an INTEGER epoch-millisecond column, so the caller's epoch value is
    // compared as an integer. Comparing it to a text column would compare an epoch number to
    // an ISO string and silently match nothing.
    predicates.push('cancellation.created_at >= ?');
    scopeBindings.push(Math.trunc(scope.createdAfter));
  }
  const rows = await db
    .prepare(
      `SELECT cancellation.engine_identity, cancellation.model, cancellation.variant,
        cancellation.rep, cancellation.case_id, cancellation.generation,
        cancellation.executor_run_id, cancellation.executor_token, cancellation.attempts,
        chunk.slot, execution.started_at AS attempt_started_at
      FROM paid_benchmark_cancellations AS cancellation
      LEFT JOIN scheduler_chunks AS chunk
        ON chunk.run_id = cancellation.executor_run_id AND chunk.model = cancellation.model
        AND chunk.variant = cancellation.variant AND chunk.rep = cancellation.rep
        AND chunk.token = cancellation.executor_token AND chunk.status = 'active'
      LEFT JOIN scheduler_executions AS execution
        ON execution.run_id = cancellation.executor_run_id
        AND execution.model = cancellation.model AND execution.variant = cancellation.variant
        AND execution.rep = cancellation.rep AND execution.case_id = cancellation.case_id
        AND execution.token = cancellation.executor_token
      WHERE cancellation.status = 'pending' AND cancellation.available_at <= ?
        ${predicates.length > 0 ? `AND ${predicates.join(' AND ')}` : ''}
      ORDER BY cancellation.created_at LIMIT ?`
    )
    .bind(now, ...scopeBindings, Math.min(Math.max(limit, 1), 32))
    .all<PaidCancellationIntent>();
  return rows.results;
}

export async function markPaidCancellationDelivered(
  db: D1Database,
  intent: PaidCancellationIntent,
  error: string | null = null
): Promise<void> {
  await db
    .prepare(
      `UPDATE paid_benchmark_cancellations
      SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = ?
      WHERE engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
        AND generation = ?`
    )
    .bind(
      Date.now(),
      new Date().toISOString(),
      error,
      intent.engine_identity,
      intent.model,
      intent.variant,
      intent.rep,
      intent.case_id,
      intent.generation
    )
    .run();
}

/** Backoff a failed cancellation delivery; the intent stays pending for the next pass. */
export async function deferPaidCancellation(
  db: D1Database,
  intent: PaidCancellationIntent,
  error: string,
  now: number = Date.now()
): Promise<void> {
  const delayMs = Math.min(300_000, 15_000 * 2 ** Math.min(intent.attempts, 4));
  await db
    .prepare(
      `UPDATE paid_benchmark_cancellations
      SET attempts = attempts + 1, available_at = ?, updated_at = ?, last_error = ?
      WHERE engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?
        AND generation = ? AND status = 'pending'`
    )
    .bind(
      now + delayMs,
      new Date(now).toISOString(),
      error.slice(0, 500),
      intent.engine_identity,
      intent.model,
      intent.variant,
      intent.rep,
      intent.case_id,
      intent.generation
    )
    .run();
}

export type LaneCaseCount = { model: string; variant: string; rep: number; n: number };

/** Per-lane case counts for run-completion accounting. Variant is storage form. */
export async function countCaseResultsByLane(
  db: D1Database,
  runId: string
): Promise<LaneCaseCount[]> {
  return drizzle(db)
    .select({
      model: caseResults.model,
      variant: caseResults.variant,
      rep: caseResults.rep,
      n: count(),
    })
    .from(caseResults)
    .where(eq(caseResults.run_id, runId))
    .groupBy(caseResults.model, caseResults.variant, caseResults.rep);
}

export async function getCaseResults(db: D1Database, runId: string): Promise<CaseResultRow[]> {
  return drizzle(db).select().from(caseResults).where(eq(caseResults.run_id, runId));
}

export async function getRoutingCaseResultsForEntries(
  db: D1Database,
  entries: readonly { entry: BenchmarkPair; runId: string }[]
): Promise<OfflineSweep['pairs']> {
  const pairs = new Map<string, OfflineSweep['pairs'][number]>();
  const orm = drizzle(db);
  for (let offset = 0; offset < entries.length; offset += 30) {
    const chunk = entries.slice(offset, offset + 30);
    const rows = await orm
      .select({
        model: caseResults.model,
        variant: caseResults.variant,
        caseId: caseResults.case_id,
        routeKey: caseResults.route_key,
        rep: caseResults.rep,
        score: caseResults.score,
        costUsd: caseResults.cost_usd,
        latencyMs: caseResults.latency_ms,
        error: caseResults.error,
      })
      .from(caseResults)
      .where(
        or(
          ...chunk.map(({ entry, runId }) =>
            and(
              eq(caseResults.run_id, runId),
              eq(caseResults.model, entry.model),
              eq(caseResults.variant, variantToStorage(entry.variant))
            )
          )
        )
      );
    for (const row of rows) {
      if (row.routeKey === null) continue;
      const variant = variantFromStorage(row.variant);
      const key = benchmarkPairKey({ model: row.model, variant });
      let pair = pairs.get(key);
      if (!pair) {
        pair = { model: row.model, variant, results: [] };
        pairs.set(key, pair);
      }
      pair.results.push({
        caseId: row.caseId,
        routeKey: row.routeKey,
        rep: row.rep,
        score: row.score,
        costUsd: row.costUsd,
        latencyMs: row.latencyMs,
        error: row.error,
        graderCostUsd: 0,
        split: 'train',
      });
    }
  }
  return [...pairs.values()];
}

export type ProbeCaseCount = { model: string; variant: string; run_id: string; probes: number };

/** One pair whose provenance run may hold probe results. `variant` is the storage form. */
export type ProbeCasePair = { runId: string; model: string; variant: string };

// Three bound variables per pair plus the case list and the revision. 30 triples bind 92
// variables, inside the same 100-variable ceiling `PROFILE_ENTRY_FILTER_BATCH_SIZE` respects.
const PROBE_CASE_PAIR_BATCH_SIZE = 30;

/**
 * The statement that counts one batch of pairs' probe results.
 *
 * Exported so a test can assert the plan it produces: the composite primary key of
 * `case_results` is `(run_id, model, variant, case_id, rep)`, so the `ON` clause must name
 * all three leading columns or SQLite seeks each pair's whole run instead of the pair.
 */
export function probeCaseCountStatement(pairCount: number): string {
  return `WITH pair(run_id, model, variant) AS (VALUES ${Array.from(
    { length: pairCount },
    () => '(?, ?, ?)'
  ).join(', ')})
         SELECT pair.run_id, pair.model, pair.variant, COUNT(DISTINCT measured.case_id) AS probes
         FROM pair
         LEFT JOIN case_results AS measured
           ON measured.run_id = pair.run_id
          AND measured.model = pair.model
          AND measured.variant = pair.variant
          AND measured.case_id IN (SELECT value FROM json_each(?))
          AND measured.prompt_revision >= ?
         GROUP BY pair.run_id, pair.model, pair.variant`;
}

/**
 * Probe results each pair's provenance run holds at `revision` or newer. A pair counts as
 * probe-complete only when `probes` reaches the number of probe cases (src/probe/eligibility.ts);
 * run completion already guarantees every repetition produced a row.
 *
 * The pairs are named, not their runs. `case_results` is keyed
 * `(run_id, model, variant, case_id, rep)`, so a statement that constrains only `run_id`
 * seeks each pair's whole run — every model, every case, every repetition — and filters
 * the probe cuts out of it row by row. Naming the pair turns that into one composite-PK
 * range per pair, which is what makes this affordable on a table of a few million rows.
 * A pair with no result at all still comes back (`LEFT JOIN`) with `probes = 0`.
 */
export async function countProbeCaseResults(
  db: D1Database,
  params: { pairs: readonly ProbeCasePair[]; caseIds: readonly string[]; revision: number }
): Promise<ProbeCaseCount[]> {
  if (params.pairs.length === 0 || params.caseIds.length === 0) return [];
  const caseIds = JSON.stringify(params.caseIds);
  const counts = new Map<string, ProbeCaseCount>();
  for (let offset = 0; offset < params.pairs.length; offset += PROBE_CASE_PAIR_BATCH_SIZE) {
    const batch = params.pairs.slice(offset, offset + PROBE_CASE_PAIR_BATCH_SIZE);
    const { results } = await db
      .prepare(probeCaseCountStatement(batch.length))
      .bind(
        ...batch.flatMap(pair => [pair.runId, pair.model, pair.variant]),
        caseIds,
        params.revision
      )
      .all<ProbeCaseCount>();
    for (const row of results) {
      counts.set(`${row.run_id}\u0000${row.model}\u0000${row.variant}`, row);
    }
  }
  return [...counts.values()];
}

export async function getExistingCaseResultIds(
  db: D1Database,
  params: {
    runId: string;
    model: string;
    /** Application null form; stored as '' at the D1 boundary. */
    variant?: string | null;
    rep: number;
    caseIds: string[];
  }
): Promise<Set<string>> {
  if (params.caseIds.length === 0) return new Set();
  const storedVariant = variantToStorage(params.variant);
  const rows = await drizzle(db)
    .select({ case_id: caseResults.case_id })
    .from(caseResults)
    .where(
      and(
        eq(caseResults.run_id, params.runId),
        eq(caseResults.model, params.model),
        eq(caseResults.variant, storedVariant),
        eq(caseResults.rep, params.rep),
        inArray(caseResults.case_id, params.caseIds)
      )
    );
  return new Set(rows.map(row => row.case_id));
}

type PendingDeciderOutputKey = {
  run_id: string;
  model: string;
  variant: string;
  case_id: string;
  rep: number;
};

const PendingDeciderOutputSchema = z.object({
  result: z.object({
    text: z.string(),
    costUsd: z.number().nullable(),
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    cachedInputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    reasoningTokens: z.number().int().nonnegative().nullable().default(null),
    latencyMs: z.number(),
    exitCode: z.number(),
    stderrTail: z.string(),
    eventCount: z.number(),
    lastEventTypes: z.array(z.string()),
    // Absent from outputs saved before tool evidence was recorded.
    tools: z
      .object({
        calls: z.number().int().nonnegative(),
        names: z.array(z.string()),
        steps: z.number().int().nonnegative(),
        finalFinishReason: z.string().nullable(),
      })
      .nullable()
      .default(null),
    timedOut: z.boolean(),
    unavailableModelId: z.string().min(1).optional(),
    // The Worker-origin stop that ended this case, carried through the durable output so a
    // late or recovered delivery classifies exactly like the live one. Absent means normal.
    stop: z.object({ reason: z.string().min(1), status: z.number().int() }).optional(),
  }),
  retried: z.boolean(),
  attemptStartedAt: z.number().int().nonnegative().optional(),
});

export type PendingDeciderOutput = z.infer<typeof PendingDeciderOutputSchema>;

/** A pending output with the measurement revision of the paid call that produced it. */
export type StoredDeciderOutput = PendingDeciderOutput & { promptRevision: number };

function pendingDeciderOutputPredicate(key: PendingDeciderOutputKey) {
  return and(
    eq(pendingDeciderOutputs.run_id, key.run_id),
    eq(pendingDeciderOutputs.model, key.model),
    eq(pendingDeciderOutputs.variant, key.variant),
    eq(pendingDeciderOutputs.case_id, key.case_id),
    eq(pendingDeciderOutputs.rep, key.rep)
  );
}

export async function getPendingDeciderOutput(
  db: D1Database,
  key: PendingDeciderOutputKey
): Promise<StoredDeciderOutput | null> {
  const row = await drizzle(db)
    .select({
      payload: pendingDeciderOutputs.payload,
      promptRevision: pendingDeciderOutputs.prompt_revision,
    })
    .from(pendingDeciderOutputs)
    .where(pendingDeciderOutputPredicate(key))
    .get();
  if (!row) return null;
  const payload: unknown = JSON.parse(row.payload);
  return { ...PendingDeciderOutputSchema.parse(payload), promptRevision: row.promptRevision };
}

export async function savePendingDeciderOutput(
  db: D1Database,
  key: PendingDeciderOutputKey,
  output: StoredDeciderOutput,
  execution?: { token: string; attemptStartedAt?: number }
): Promise<boolean> {
  const { promptRevision, ...payload } = output;
  const inserted = await db
    .prepare(`
      INSERT INTO pending_decider_outputs
        (run_id, model, variant, case_id, rep, payload, prompt_revision)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE NOT EXISTS (
        SELECT 1 FROM case_results
        WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
      ) AND (?8 IS NULL OR EXISTS (
        SELECT 1 FROM scheduler_executions
        WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
          AND token = ?8 AND (?9 IS NULL OR started_at = ?9)
      ))
      ON CONFLICT DO NOTHING
    `)
    .bind(
      key.run_id,
      key.model,
      key.variant,
      key.case_id,
      key.rep,
      JSON.stringify(payload),
      promptRevision,
      execution?.token ?? null,
      execution?.attemptStartedAt ?? null
    )
    .run();
  return inserted.meta.changes > 0;
}

export async function claimDeciderGrading(
  db: D1Database,
  key: PendingDeciderOutputKey,
  token: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE pending_decider_outputs SET grading_token = ?6, grading_lease_until = ?7
      WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
        AND grading_lease_until <= ?8
        AND NOT EXISTS (
          SELECT 1 FROM case_results
          WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
        )
    `)
    .bind(key.run_id, key.model, key.variant, key.case_id, key.rep, token, now + 5 * 60_000, now)
    .run();
  return result.meta.changes > 0;
}

export async function releaseDeciderGrading(
  db: D1Database,
  key: PendingDeciderOutputKey,
  token: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE pending_decider_outputs SET grading_token = NULL, grading_lease_until = 0
      WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
        AND grading_token = ?6
    `)
    .bind(key.run_id, key.model, key.variant, key.case_id, key.rep, token)
    .run();
}

export async function deletePendingDeciderOutput(
  db: D1Database,
  key: PendingDeciderOutputKey
): Promise<void> {
  await drizzle(db).delete(pendingDeciderOutputs).where(pendingDeciderOutputPredicate(key));
}

export async function needsPendingOutputRecovery(
  db: D1Database,
  key: PendingDeciderOutputKey
): Promise<boolean> {
  const row = await db
    .prepare(`
      SELECT 1 AS needed FROM benchmark_runs AS run
      WHERE run.id = ?1 AND (
        run.status != 'running' OR EXISTS (
          SELECT 1 FROM run_lane_failures
          WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND rep = ?5
        )
      ) AND EXISTS (
        SELECT 1 FROM pending_decider_outputs
        WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
      ) AND NOT EXISTS (
        SELECT 1 FROM case_results
        WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND case_id = ?4 AND rep = ?5
      )
    `)
    .bind(key.run_id, key.model, key.variant, key.case_id, key.rep)
    .first<{ needed: number }>();
  return row !== null;
}

export async function listPendingOutputRecoveries(
  db: D1Database,
  router: AutoRouter,
  engineIdentity: string,
  limit: number
): Promise<PendingDeciderOutputKey[]> {
  const rows = await db
    .prepare(`
    SELECT p.run_id, p.model, p.variant, p.rep, p.case_id
    FROM pending_decider_outputs AS p
    JOIN benchmark_runs AS run ON run.id = p.run_id
    WHERE run.router = ?1 AND run.engine_identity = ?2
      AND p.grading_lease_until <= ?3
      AND (run.status != 'running' OR EXISTS (
        SELECT 1 FROM run_lane_failures f WHERE f.run_id = p.run_id
          AND f.model = p.model AND f.variant = p.variant AND f.rep = p.rep
      ))
      AND NOT EXISTS (
        SELECT 1 FROM case_results r WHERE r.run_id = p.run_id AND r.model = p.model
          AND r.variant = p.variant AND r.case_id = p.case_id AND r.rep = p.rep
      )
      AND (
        json_extract(p.payload, '$.result.unavailableModelId') IS NULL
        OR lower(json_extract(p.payload, '$.result.stderrTail')) LIKE '%failed to load%model catalog%'
      )
    ORDER BY p.run_id, p.model, p.variant, p.case_id, p.rep
    LIMIT ?4
  `)
    .bind(router, engineIdentity, Date.now(), limit)
    .all<PendingDeciderOutputKey>();
  return rows.results;
}

export async function replaceModelSummaries(
  db: D1Database,
  runId: string,
  summaries: BenchmarkModelSummary[]
): Promise<void> {
  const orm = drizzle(db);
  // Only delete non-carried rows; carried rows (from skipped models) stay.
  const deleteStmt = orm
    .delete(modelSummaries)
    .where(and(eq(modelSummaries.run_id, runId), eq(modelSummaries.carried, false)));

  if (summaries.length === 0) {
    await deleteStmt;
    return;
  }

  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [deleteStmt];
  for (let i = 0; i < summaries.length; i += MODEL_SUMMARY_INSERT_BATCH_SIZE) {
    const summaryChunk = summaries.slice(i, i + MODEL_SUMMARY_INSERT_BATCH_SIZE);
    stmts.push(
      orm.insert(modelSummaries).values(
        summaryChunk.map(s => ({
          run_id: runId,
          model: s.model,
          variant: variantToStorage(s.variant),
          route_key: s.routeKey,
          accuracy: s.accuracy,
          avg_cost_usd: s.avgCostUsd,
          avg_input_tokens: s.avgInputTokens ?? null,
          avg_cached_input_tokens: s.avgCachedInputTokens ?? null,
          avg_output_tokens: s.avgOutputTokens ?? null,
          avg_reasoning_tokens: s.avgReasoningTokens ?? null,
          avg_latency_ms: s.avgLatencyMs,
          p50_latency_ms: s.p50LatencyMs,
          p95_latency_ms: s.p95LatencyMs,
          cases: s.cases,
          costed_cases: s.costedCases,
          errors: s.errors,
          timeouts: s.timeouts,
          route_accuracy: s.routeAccuracy,
          carried: false,
        }))
      )
    );
  }
  await orm.batch(stmts);
}

export async function getSummaries(
  db: D1Database,
  runId: string
): Promise<BenchmarkModelSummary[]> {
  const rows = await drizzle(db)
    .select()
    .from(modelSummaries)
    .where(eq(modelSummaries.run_id, runId));
  return rows.map(mapSummaryRow);
}

/**
 * One run's summaries for the admin run list, or null when the run is not
 * visible under `router`. Classifier runs are shared by every router.
 */
export async function getRunSummariesForRouter(
  db: D1Database,
  runId: string,
  router: AutoRouter
): Promise<BenchmarkModelSummary[] | null> {
  const run = await drizzle(db)
    .select({ id: benchmarkRuns.id })
    .from(benchmarkRuns)
    .where(
      and(
        eq(benchmarkRuns.id, runId),
        or(eq(benchmarkRuns.router, router), eq(benchmarkRuns.kind, 'classifier'))
      )
    )
    .get();
  if (!run) return null;
  return getSummaries(db, runId);
}

export async function listRuns(
  db: D1Database,
  limit: number,
  // Classifier, platform-decider and profile-decider runs interleave in one
  // table and profile runs are by far the most frequent, so the admin list
  // filters server-side instead of slicing a mixed page client-side.
  filter: { router?: AutoRouter; kind?: BenchmarkKind; purpose?: BenchmarkRunPurpose } = {}
): Promise<BenchmarkRun[]> {
  const runRows = await drizzle(db)
    .select()
    .from(benchmarkRuns)
    .where(
      and(
        eq(benchmarkRuns.router, filter.router ?? 'efficient'),
        filter.kind ? eq(benchmarkRuns.kind, filter.kind) : undefined,
        filter.purpose ? eq(benchmarkRuns.purpose, filter.purpose) : undefined
      )
    )
    .orderBy(desc(benchmarkRuns.started_at))
    .limit(limit);
  return runRows.map(mapRunRow);
}

export async function listRunningRunIds(db: D1Database, router: AutoRouter): Promise<string[]> {
  const runs = await drizzle(db)
    .select({ id: benchmarkRuns.id })
    .from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.router, router), eq(benchmarkRuns.status, 'running')))
    .orderBy(asc(benchmarkRuns.started_at), asc(benchmarkRuns.id));
  return runs.map(run => run.id);
}

export type RunProgressCountRow = {
  runId: string;
  kind: BenchmarkKind;
  router: AutoRouter;
  repetitions: number;
  engineIdentity: string;
  measurementRevision: number;
  enqueuedModels: number;
  completedCases: number;
  failedCases: number;
};

/**
 * Case tallies for every RUNNING run among `runIds` in one statement, so a page
 * of runs costs one query instead of one per run. Terminal runs are filtered out
 * in SQL: their counts are already final in their summaries.
 */
export async function listRunProgressCounts(
  db: D1Database,
  runIds: readonly string[]
): Promise<RunProgressCountRow[]> {
  if (runIds.length === 0) return [];
  const rows = await drizzle(db)
    .select({
      runId: benchmarkRuns.id,
      kind: benchmarkRuns.kind,
      router: benchmarkRuns.router,
      repetitions: benchmarkRuns.repetitions,
      engineIdentity: benchmarkRuns.engine_identity,
      measurementRevision: benchmarkRuns.measurement_revision,
      enqueuedModels: sql<number>`(
        SELECT COUNT(*) FROM ${runModels}
        WHERE ${runModels.run_id} = ${benchmarkRuns.id} AND ${runModels.enqueued} = 1
      )`,
      completedCases: sql<number>`(
        SELECT COUNT(*) FROM ${caseResults} WHERE ${caseResults.run_id} = ${benchmarkRuns.id}
      )`,
      failedCases: sql<number>`(
        SELECT COUNT(*) FROM ${caseResults}
        WHERE ${caseResults.run_id} = ${benchmarkRuns.id}
          AND (${caseResults.error} IS NOT NULL OR ${caseResults.timed_out} = 1)
      )`,
    })
    .from(benchmarkRuns)
    .where(and(inArray(benchmarkRuns.id, [...runIds]), eq(benchmarkRuns.status, 'running')));
  return rows.map(row => ({
    runId: row.runId,
    kind: row.kind,
    router: row.router,
    repetitions: row.repetitions,
    engineIdentity: row.engineIdentity,
    measurementRevision: row.measurementRevision,
    enqueuedModels: Number(row.enqueuedModels),
    completedCases: Number(row.completedCases),
    failedCases: Number(row.failedCases),
  }));
}

export type RunTotalsRow = {
  runId: string;
  totalCostUsd: number | null;
  measuredCases: number;
  erroredCases: number;
};

/**
 * Statement {@link listRunTotals} runs; exported for the query-plan test. One
 * bounded index seek on case_results per run in the page, grouped by run — a
 * page of runs never ships their case rows.
 */
export function listRunTotalsStatement(orm: ReturnType<typeof drizzle>, runIds: readonly string[]) {
  return orm
    .select({
      runId: caseResults.run_id,
      totalCostUsd: sql<number | null>`SUM(${caseResults.cost_usd})`,
      measuredCases: count(),
      erroredCases: sql<number>`SUM(
        CASE WHEN ${caseResults.error} IS NOT NULL OR ${caseResults.timed_out} = 1 THEN 1 ELSE 0 END
      )`,
    })
    .from(caseResults)
    .where(inArray(caseResults.run_id, [...runIds]))
    .groupBy(caseResults.run_id);
}

/**
 * Cost and case tallies for every run among `runIds` in one statement. Runs
 * without any graded case are absent from the result, and a run whose cases
 * reported no cost carries a null total.
 */
export async function listRunTotals(
  db: D1Database,
  runIds: readonly string[]
): Promise<RunTotalsRow[]> {
  if (runIds.length === 0) return [];
  const rows = await listRunTotalsStatement(drizzle(db), runIds);
  return rows.map(row => ({
    runId: row.runId,
    totalCostUsd: row.totalCostUsd === null ? null : Number(row.totalCostUsd),
    measuredCases: Number(row.measuredCases),
    erroredCases: Number(row.erroredCases),
  }));
}

/**
 * Enqueued model ids per run for the runs among `runIds`, in one statement per
 * batch of ids. A skipped (not enqueued) model is absent: it was measured by an
 * earlier run. A model enqueued at two reasoning variants is one id, because the
 * list answers "which models did this run measure", not "how many pairs".
 */
export async function listRunModelIds(
  db: D1Database,
  runIds: readonly string[]
): Promise<Map<string, string[]>> {
  if (runIds.length === 0) return new Map();
  const orm = drizzle(db);
  const models = new Map<string, string[]>();
  for (let i = 0; i < runIds.length; i += RUN_ID_FILTER_BATCH_SIZE) {
    const rows = await orm
      .selectDistinct({ runId: runModels.run_id, model: runModels.model })
      .from(runModels)
      .where(
        and(
          inArray(runModels.run_id, runIds.slice(i, i + RUN_ID_FILTER_BATCH_SIZE)),
          eq(runModels.enqueued, true)
        )
      );
    for (const row of rows) {
      const list = models.get(row.runId);
      if (list) list.push(row.model);
      else models.set(row.runId, [row.model]);
    }
  }
  // DISTINCT removes the duplicates of one run's variants; a run id belongs to
  // exactly one batch, so no list is assembled twice.
  return models;
}

export type RunModelTotalsRow = {
  model: string;
  variant: string;
  scoreSum: number;
  cases: number;
  costedCases: number;
  costSum: number | null;
  errors: number;
  timeouts: number;
  routeGraded: number;
  routeHits: number;
};

/**
 * Statement {@link listRunModelTotals} runs; exported for the query-plan test.
 * One index seek on the run's case rows, grouped by the exact pair.
 */
export function listRunModelTotalsStatement(orm: ReturnType<typeof drizzle>, runId: string) {
  return orm
    .select({
      model: caseResults.model,
      variant: caseResults.variant,
      scoreSum: sql<number>`SUM(${caseResults.score})`,
      cases: count(),
      costedCases: sql<number>`COUNT(${caseResults.cost_usd})`,
      costSum: sql<number | null>`SUM(${caseResults.cost_usd})`,
      errors: sql<number>`SUM(CASE WHEN ${caseResults.error} IS NOT NULL THEN 1 ELSE 0 END)`,
      timeouts: sql<number>`SUM(CASE WHEN ${caseResults.timed_out} = 1 THEN 1 ELSE 0 END)`,
      routeGraded: sql<number>`COUNT(${caseResults.route_hit})`,
      routeHits: sql<number>`COALESCE(SUM(CASE WHEN ${caseResults.route_hit} THEN 1 ELSE 0 END), 0)`,
    })
    .from(caseResults)
    .where(eq(caseResults.run_id, runId))
    .groupBy(caseResults.model, caseResults.variant);
}

/**
 * Per-(model, variant) case aggregates for one run, summed over every route.
 * The caller turns the sums into the accuracy and cost means a reader sees.
 * Variant is storage form.
 */
export async function listRunModelTotals(
  db: D1Database,
  runId: string
): Promise<RunModelTotalsRow[]> {
  const rows = await listRunModelTotalsStatement(drizzle(db), runId);
  return rows.map(row => ({
    model: row.model,
    variant: row.variant,
    scoreSum: Number(row.scoreSum),
    cases: Number(row.cases),
    costedCases: Number(row.costedCases),
    costSum: row.costSum === null ? null : Number(row.costSum),
    errors: Number(row.errors),
    timeouts: Number(row.timeouts),
    routeGraded: Number(row.routeGraded),
    routeHits: Number(row.routeHits),
  }));
}

export async function markRunCompleted(db: D1Database, runId: string): Promise<void> {
  await drizzle(db)
    .update(benchmarkRuns)
    .set({ status: 'completed', completed_at: new Date().toISOString() })
    .where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, 'running')));
}

export async function markStaleRunsFailed(db: D1Database, olderThanIso: string): Promise<void> {
  await drizzle(db)
    .update(benchmarkRuns)
    .set({ status: 'failed', error: 'timed out' })
    .where(
      and(
        eq(benchmarkRuns.status, 'running'),
        lt(benchmarkRuns.started_at, olderThanIso),
        sql`NOT EXISTS (SELECT 1 FROM scheduler_runs WHERE run_id = ${benchmarkRuns.id})`
      )
    );
}

// The running run of a (kind, purpose), if any. Classifier admission relies on
// it: a classifier run derives one winner, so only one may run at a time.
// Decider queues hold several runs; their drain reads getQueueRunOccupancy.
// Stale runs are swept to 'failed' before this is consulted.
export async function getRunningRun(
  db: D1Database,
  kind: BenchmarkKind,
  purpose: BenchmarkRunPurpose,
  router: AutoRouter = 'efficient'
): Promise<RunRow | undefined> {
  return drizzle(db)
    .select()
    .from(benchmarkRuns)
    .where(
      and(
        eq(benchmarkRuns.router, router),
        eq(benchmarkRuns.kind, kind),
        eq(benchmarkRuns.purpose, purpose),
        eq(benchmarkRuns.status, 'running')
      )
    )
    .get();
}

// True when a run of the same kind started later than this one has already
// completed. Used to skip publishing so a slow older run can't overwrite a
// newer run's published routing table / classifier winner.
// Only platform runs publish, so only a newer completed PLATFORM run may
// suppress this run's publication. Profile runs share the decider kind and
// complete on their own cadence; counting them here would silently skip
// publishing a perfectly good platform table.
export async function existsNewerCompletedRun(
  db: D1Database,
  kind: BenchmarkKind,
  startedAt: string,
  runId: string,
  router: AutoRouter = 'efficient'
): Promise<boolean> {
  const newer = await drizzle(db)
    .select({ id: benchmarkRuns.id })
    .from(benchmarkRuns)
    .where(
      and(
        eq(benchmarkRuns.router, kind === 'classifier' ? 'efficient' : router),
        eq(benchmarkRuns.kind, kind),
        eq(benchmarkRuns.purpose, 'platform'),
        eq(benchmarkRuns.status, 'completed'),
        gt(benchmarkRuns.started_at, startedAt),
        ne(benchmarkRuns.id, runId)
      )
    )
    .get();
  return newer !== undefined;
}

export async function markRunFailed(db: D1Database, runId: string, error: string): Promise<void> {
  await drizzle(db)
    .update(benchmarkRuns)
    .set({ status: 'failed', error: error.slice(0, 500), completed_at: new Date().toISOString() })
    .where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, 'running')));
}

/**
 * Mark Benchmark-profile rows claimed by this run as running. Only touches rows
 * still pending (or already running for this run_id) under the exact PK — never
 * clobbers ready/failed or a different run's claim. A ready row queued in
 * `profile_remeasures` is claimed there instead: the profile stays ready on its
 * previous run until `settleRemeasuresForRun` moves it.
 */
export async function markProfilesRunningForRun(
  db: D1Database,
  runId: string,
  entries: readonly BenchmarkPair[],
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  nowIso: string = new Date().toISOString()
): Promise<BenchmarkPair[]> {
  if (entries.length === 0) return [];
  const orm = drizzle(db);
  // Returns the entries this run actually claimed. An entry already claimed by
  // another run updates 0 rows and is dropped, so the pair is measured once
  // instead of being benchmarked (and billed) twice.
  const claimed: BenchmarkPair[] = [];
  for (const entry of entries) {
    const result = await orm
      .update(benchmarkProfiles)
      .set({
        status: 'running',
        run_id: runId,
        failure_reason: null,
        updated_at: nowIso,
        completed_at: null,
      })
      .where(
        and(
          eq(benchmarkProfiles.model, entry.model),
          eq(benchmarkProfiles.variant, variantToStorage(entry.variant)),
          eq(benchmarkProfiles.router, current.router ?? 'efficient'),
          eq(benchmarkProfiles.engine_identity, current.engineIdentity),
          eq(benchmarkProfiles.repetitions, current.repetitions),
          or(
            eq(benchmarkProfiles.status, 'pending'),
            and(eq(benchmarkProfiles.status, 'running'), eq(benchmarkProfiles.run_id, runId))
          )
        )
      );
    if ((result.meta.changes ?? 0) > 0) {
      claimed.push(entry);
      continue;
    }
    const remeasure = await orm
      .update(profileRemeasures)
      .set({ run_id: runId, claimed_at: nowIso })
      .where(
        and(
          eq(profileRemeasures.model, entry.model),
          eq(profileRemeasures.variant, variantToStorage(entry.variant)),
          eq(profileRemeasures.router, current.router ?? 'efficient'),
          eq(profileRemeasures.engine_identity, current.engineIdentity),
          eq(profileRemeasures.repetitions, current.repetitions),
          isNull(profileRemeasures.run_id),
          readyProfileForRemeasure()
        )
      );
    if ((remeasure.meta.changes ?? 0) > 0) claimed.push(entry);
  }
  return claimed;
}

function readyProfileForRemeasure() {
  return sql`EXISTS (
    SELECT 1 FROM ${benchmarkProfiles}
    WHERE ${benchmarkProfiles.router} = ${profileRemeasures.router}
      AND ${benchmarkProfiles.model} = ${profileRemeasures.model}
      AND ${benchmarkProfiles.variant} = ${profileRemeasures.variant}
      AND ${benchmarkProfiles.engine_identity} = ${profileRemeasures.engine_identity}
      AND ${benchmarkProfiles.repetitions} = ${profileRemeasures.repetitions}
      AND ${benchmarkProfiles.status} = 'ready'
      AND ${benchmarkProfiles.run_id} IS NOT NULL
  )`;
}

/**
 * Copy every result of each claimed re-measure's previous run into this run, except results
 * measured below their case's entry in `minimumRevisions`. Failed and timed-out results are
 * copied too: only the cases below their minimum, and cases the previous run never had, run.
 */
export async function copyRemeasureBaselines(
  db: D1Database,
  params: { runId: string; minimumRevisions: Readonly<Record<string, number>> }
): Promise<number> {
  const result = await db
    .prepare(`
      INSERT INTO case_results (
        run_id, model, variant, case_id, route_key, score, latency_ms, cost_usd,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        error, fallback_reason, route_hit, retried, exit_code, output_prefix,
        event_count, last_event_types, tool_calls, tool_names, step_count,
        final_finish_reason, rep, timed_out, prompt_revision
      )
      SELECT r.run_id, source.model, source.variant, source.case_id, source.route_key,
        source.score, source.latency_ms, source.cost_usd, source.input_tokens,
        source.cached_input_tokens, source.output_tokens, source.reasoning_tokens,
        source.error, source.fallback_reason,
        source.route_hit, source.retried, source.exit_code, source.output_prefix,
        source.event_count, source.last_event_types, source.tool_calls, source.tool_names,
        source.step_count, source.final_finish_reason, source.rep, source.timed_out,
        source.prompt_revision
      FROM profile_remeasures AS r
      JOIN benchmark_profiles AS p ON p.router = r.router AND p.model = r.model
        AND p.variant = r.variant AND p.engine_identity = r.engine_identity
        AND p.repetitions = r.repetitions AND p.status = 'ready'
      JOIN case_results AS source ON source.run_id = p.run_id
        AND source.model = p.model AND source.variant = p.variant
      WHERE r.run_id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) AS minimum
          WHERE minimum.key = source.case_id AND source.prompt_revision < minimum.value)
      ON CONFLICT (run_id, model, variant, case_id, rep) DO NOTHING
    `)
    .bind(params.runId, JSON.stringify(params.minimumRevisions))
    .run();
  return result.meta.changes ?? 0;
}

/** Outcome of a ready publication: `deferred` wrote nothing, so the run stays open. */
export type ReadyPublication = 'published' | 'deferred';

/** The fence read every guarded publication batches first: `free` is 1 while it may publish. */
export function aliasReadinessAllows(fence: unknown): boolean {
  const row = fence as { free?: unknown } | null | undefined;
  return Number(row?.free) === 1;
}

/**
 * One database-clock sample per publication. The same cutoff guards every statement in the
 * batch, so a lease that expires mid-batch cannot let one statement skip and a later one
 * write — the publication is all-or-none.
 */
async function sampleAliasReadinessCutoff(db: D1Database): Promise<number> {
  const row = await aliasReadinessSampleClockStatement(db).first<{ now_ms: number }>();
  const nowMs = Number(row?.now_ms);
  if (!Number.isFinite(nowMs)) throw new Error('readiness clock read failed');
  return nowMs;
}

/** Whether an unexpired readiness lease currently blocks a ready publication. */
export async function aliasReadinessLeaseHeld(db: D1Database): Promise<boolean> {
  return !aliasReadinessAllows(
    await aliasReadinessFenceReadStatement(db, await sampleAliasReadinessCutoff(db)).first<{
      free: number;
    }>()
  );
}

/**
 * Settle this run's re-measures: an entry with a dead lane is dropped and keeps its
 * previous measurement; every other claimed profile moves its provenance to this run,
 * which now holds its full result set. Status stays `ready` throughout.
 *
 * Every statement carries {@link aliasReadinessClearSql} against one sampled cutoff, and the
 * batch opens with the same read, so a held lease makes the whole publication a no-op and the
 * caller keeps the run open for the settled-run sweep. Partial publication is impossible: the
 * failed-entry deletes and the provenance update share the cutoff.
 */
export async function settleRemeasuresForRun(
  db: D1Database,
  runId: string,
  /** Storage-form variant keys ('' = default variant). */
  failedEntries: readonly { model: string; variant: string }[],
  nowIso: string = new Date().toISOString()
): Promise<ReadyPublication> {
  const cutoff = await sampleAliasReadinessCutoff(db);
  const orm = drizzle(db);
  const clear = aliasReadinessClearSql(cutoff);
  const statements: { toSQL: () => { sql: string; params: unknown[] } }[] = failedEntries.map(
    entry =>
      orm
        .delete(profileRemeasures)
        .where(
          and(
            eq(profileRemeasures.run_id, runId),
            eq(profileRemeasures.model, entry.model),
            eq(profileRemeasures.variant, entry.variant),
            clear
          )
        )
  );
  statements.push(
    orm
      .update(benchmarkProfiles)
      .set({ run_id: runId, updated_at: nowIso, completed_at: nowIso })
      .where(
        and(
          eq(benchmarkProfiles.status, 'ready'),
          clear,
          sql`EXISTS (
            SELECT 1 FROM ${profileRemeasures}
            WHERE ${profileRemeasures.run_id} = ${runId}
              AND ${profileRemeasures.router} = ${benchmarkProfiles.router}
              AND ${profileRemeasures.model} = ${benchmarkProfiles.model}
              AND ${profileRemeasures.variant} = ${benchmarkProfiles.variant}
              AND ${profileRemeasures.engine_identity} = ${benchmarkProfiles.engine_identity}
              AND ${profileRemeasures.repetitions} = ${benchmarkProfiles.repetitions}
          )`
        )
      ),
    orm.delete(profileRemeasures).where(and(eq(profileRemeasures.run_id, runId), clear))
  );
  const [fence] = await db.batch([
    aliasReadinessFenceReadStatement(db, cutoff),
    ...statements.map(statement => {
      const built = statement.toSQL();
      return db.prepare(built.sql).bind(...built.params);
    }),
  ]);
  return aliasReadinessAllows(fence?.results[0]) ? 'published' : 'deferred';
}

/**
 * Production UPDATE for ready transition. Exported for honest SQLite tests of
 * the run_id + status='running' no-clobber guard.
 */
export function markProfilesReadyForRunStatement(
  orm: ReturnType<typeof drizzle>,
  runId: string,
  nowIso: string,
  readinessCutoffMs: number
) {
  return orm
    .update(benchmarkProfiles)
    .set({
      ...profileFailureResetAssignments,
      status: 'ready',
      updated_at: nowIso,
      completed_at: nowIso,
    })
    .where(
      and(
        eq(benchmarkProfiles.run_id, runId),
        eq(benchmarkProfiles.status, 'running'),
        aliasReadinessClearSql(readinessCutoffMs)
      )
    );
}

/**
 * Transition only the given entries of this run to ready, with the same no-clobber guard as
 * {@link markProfilesReadyForRun}. A paid run readies each pair whose slots are complete, so
 * one dead or paused model never withholds another model's finished measurement.
 */
export async function markProfilesReadyForEntries(
  db: D1Database,
  runId: string,
  entries: readonly BenchmarkPair[],
  nowIso: string = new Date().toISOString()
): Promise<ReadyPublication> {
  if (entries.length === 0) return 'published';
  const cutoff = await sampleAliasReadinessCutoff(db);
  const orm = drizzle(db);
  const clear = aliasReadinessClearSql(cutoff);
  const statements = [
    orm
      .update(benchmarkProfiles)
      .set({
        ...profileFailureResetAssignments,
        status: 'ready',
        updated_at: nowIso,
        completed_at: nowIso,
      })
      .where(
        and(
          eq(benchmarkProfiles.run_id, runId),
          eq(benchmarkProfiles.status, 'running'),
          clear,
          or(
            ...entries.map(entry =>
              and(
                eq(benchmarkProfiles.model, entry.model),
                eq(benchmarkProfiles.variant, variantToStorage(entry.variant))
              )
            )
          )
        )
      ),
    orm
      .delete(profileRemeasures)
      .where(
        and(
          eq(profileRemeasures.run_id, runId),
          clear,
          or(
            ...entries.map(entry =>
              and(
                eq(profileRemeasures.model, entry.model),
                eq(profileRemeasures.variant, variantToStorage(entry.variant))
              )
            )
          )
        )
      ),
  ];
  const [fence] = await db.batch([
    aliasReadinessFenceReadStatement(db, cutoff),
    ...statements.map(statement => {
      const built = statement.toSQL();
      return db.prepare(built.sql).bind(...built.params);
    }),
  ]);
  return aliasReadinessAllows(fence?.results[0]) ? 'published' : 'deferred';
}

/**
 * Release only the given entries of this run back to `pending` (paid runs that end with a
 * paused or cancelled slot), leaving every other pair the run measured claimed so it can be
 * readied.
 */
export async function releaseProfileClaimsForEntries(
  db: D1Database,
  runId: string,
  entries: readonly BenchmarkPair[]
): Promise<void> {
  if (entries.length === 0) return;
  const orm = drizzle(db);
  await orm.batch([
    orm
      .update(benchmarkProfiles)
      .set({ status: 'pending', run_id: null, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(benchmarkProfiles.run_id, runId),
          eq(benchmarkProfiles.status, 'running'),
          or(
            ...entries.map(entry =>
              and(
                eq(benchmarkProfiles.model, entry.model),
                eq(benchmarkProfiles.variant, variantToStorage(entry.variant))
              )
            )
          )
        )
      ),
    orm
      .delete(profileRemeasures)
      .where(
        and(
          eq(profileRemeasures.run_id, runId),
          or(
            ...entries.map(entry =>
              and(
                eq(profileRemeasures.model, entry.model),
                eq(profileRemeasures.variant, variantToStorage(entry.variant))
              )
            )
          )
        )
      ),
  ]);
}

/**
 * Transition profiles claimed by this run to ready. Only rows still pointing at
 * this run_id and still running are updated — never a newer pending/ready row.
 */
export async function markProfilesReadyForRun(
  db: D1Database,
  runId: string,
  nowIso: string = new Date().toISOString()
): Promise<ReadyPublication> {
  const cutoff = await sampleAliasReadinessCutoff(db);
  const orm = drizzle(db);
  const statement = markProfilesReadyForRunStatement(orm, runId, nowIso, cutoff).toSQL();
  const [fence] = await db.batch([
    aliasReadinessFenceReadStatement(db, cutoff),
    db.prepare(statement.sql).bind(...statement.params),
  ]);
  return aliasReadinessAllows(fence?.results[0]) ? 'published' : 'deferred';
}

/**
 * Production UPDATE for failed transition. Exported for honest SQLite tests of
 * the run_id + status='running' no-clobber guard.
 */
export function markProfilesFailedForRunStatement(
  orm: ReturnType<typeof drizzle>,
  runId: string,
  failure: ProfileFailure,
  nowIso: string
) {
  return orm
    .update(benchmarkProfiles)
    .set(profileFailureAssignments(failure, nowIso))
    .where(and(eq(benchmarkProfiles.run_id, runId), eq(benchmarkProfiles.status, 'running')));
}

/**
 * Transition profiles claimed by this run to failed. Only rows still pointing at this
 * run_id and still running are updated. This run's re-measure claims are dropped; those
 * profiles keep serving their previous measurement.
 */
export async function markProfilesFailedForRun(
  db: D1Database,
  runId: string,
  failure: ProfileFailure,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const orm = drizzle(db);
  await orm.batch([
    markProfilesFailedForRunStatement(orm, runId, failure, nowIso),
    orm.delete(profileRemeasures).where(eq(profileRemeasures.run_id, runId)),
  ]);
}

/**
 * Production UPDATE for the per-entry failed transition at profile-run
 * completion. Same run_id + status='running' no-clobber guard as the
 * whole-run variants. Exported for honest SQLite tests.
 */
export function markProfilesFailedForEntriesStatement(
  orm: ReturnType<typeof drizzle>,
  runId: string,
  /** Storage-form variant keys ('' = default variant). */
  entries: readonly { model: string; variant: string }[],
  failure: ProfileFailure,
  nowIso: string
) {
  // or(...[]) evaluates to undefined and the WHERE would degrade to run_id +
  // status='running', failing every running entry of the run. Refuse the
  // destructive form at the boundary instead of relying on caller guards.
  if (entries.length === 0) {
    throw new Error('markProfilesFailedForEntriesStatement requires at least one entry');
  }
  return orm
    .update(benchmarkProfiles)
    .set(profileFailureAssignments(failure, nowIso))
    .where(
      and(
        eq(benchmarkProfiles.run_id, runId),
        eq(benchmarkProfiles.status, 'running'),
        or(
          ...entries.map(e =>
            and(eq(benchmarkProfiles.model, e.model), eq(benchmarkProfiles.variant, e.variant))
          )
        )
      )
    );
}

/**
 * Transition the given entries claimed by this run to failed. Only rows still
 * pointing at this run_id and still running are updated.
 */
export async function markProfilesFailedForEntries(
  db: D1Database,
  runId: string,
  entries: readonly { model: string; variant: string }[],
  failure: ProfileFailure,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  if (entries.length === 0) return;
  const orm = drizzle(db);
  // Two bound variables per entry plus the fixed clause. A run can hold far
  // more entries than D1's ceiling allows in one statement, so chunk.
  for (let i = 0; i < entries.length; i += PROFILE_ENTRY_FILTER_BATCH_SIZE) {
    await markProfilesFailedForEntriesStatement(
      orm,
      runId,
      entries.slice(i, i + PROFILE_ENTRY_FILTER_BATCH_SIZE),
      failure,
      nowIso
    );
  }
}

/**
 * Fail pending current rows the drain found it cannot benchmark, before any paid call.
 * Only rows still pending are touched, so a concurrent claim or re-admit wins.
 */
export async function failPendingProfiles(
  db: D1Database,
  current: { router: AutoRouter; engineIdentity: string; repetitions: number },
  /** Storage-form variant keys ('' = default variant). */
  entries: readonly { model: string; variant: string; failure: ProfileFailure }[],
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const orm = drizzle(db);
  const [first, ...rest] = entries.map(entry =>
    orm
      .update(benchmarkProfiles)
      .set(profileFailureAssignments(entry.failure, nowIso))
      .where(
        and(
          eq(benchmarkProfiles.router, current.router),
          eq(benchmarkProfiles.model, entry.model),
          eq(benchmarkProfiles.variant, entry.variant),
          eq(benchmarkProfiles.engine_identity, current.engineIdentity),
          eq(benchmarkProfiles.repetitions, current.repetitions),
          eq(benchmarkProfiles.status, 'pending')
        )
      )
  );
  if (first !== undefined) await orm.batch([first, ...rest]);
}

export type RunLaneFailureRow = typeof runLaneFailures.$inferSelect;

/**
 * Production INSERT for lane-death records. ON CONFLICT DO NOTHING so DLQ
 * redelivery or several dead chunks of one lane never throw. Exported for
 * honest SQLite tests.
 */
export function recordLaneFailureStatement(
  orm: ReturnType<typeof drizzle>,
  row: {
    runId: string;
    model: string;
    /** Storage form ('' = default variant). */
    variant: string;
    rep: number;
    chunk: number;
    shard: number;
    failureClass: BenchmarkProfileFailureClass;
    failedAtIso: string;
  }
) {
  return orm
    .insert(runLaneFailures)
    .values({
      run_id: row.runId,
      model: row.model,
      variant: row.variant,
      rep: row.rep,
      chunk: row.chunk,
      shard: row.shard,
      failed_at: row.failedAtIso,
      failure_class: row.failureClass,
    })
    .onConflictDoNothing();
}

/** Record that a run's lane died, and why. Variant in storage form. */
export async function recordLaneFailure(
  db: D1Database,
  row: {
    runId: string;
    model: string;
    /** Storage form ('' = default variant). */
    variant: string;
    rep: number;
    chunk: number;
    shard: number;
    failureClass: BenchmarkProfileFailureClass;
  },
  failedAtIso: string = new Date().toISOString()
): Promise<void> {
  await recordLaneFailureStatement(drizzle(db), { ...row, failedAtIso });
}

/** Lane-death records of a run, at (model, variant, rep, chunk, shard) granularity. */
export async function listLaneFailures(
  db: D1Database,
  runId: string
): Promise<RunLaneFailureRow[]> {
  return drizzle(db).select().from(runLaneFailures).where(eq(runLaneFailures.run_id, runId));
}

/**
 * Pending current-engine registry rows for one queue, oldest request first.
 * Used by the per-queue drain to claim the next batch. A row wanted by both
 * queues appears in both listings — whichever run claims it first flips it to
 * `running`, so it is still measured exactly once.
 *
 * `requestedAfter` admits only work requested at or after the paid cutover: a row
 * that predates it is legacy measurement the deploy must not schedule again. It stays
 * `pending` (measured rows and routing artifacts untouched) until an explicit requeue or
 * a new membership commit re-stamps `requested_at`.
 */
export async function listPendingCurrentProfiles(
  db: D1Database,
  current: {
    router?: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    requestedAfter?: string;
  },
  queue: BenchmarkRunPurpose
): Promise<Array<{ model: string; variant: string; requested_at: string }>> {
  return drizzle(db)
    .select({
      model: benchmarkProfiles.model,
      variant: benchmarkProfiles.variant,
      requested_at: benchmarkProfiles.requested_at,
    })
    .from(benchmarkProfiles)
    .where(
      and(
        eq(benchmarkProfiles.status, 'pending'),
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        current.requestedAfter
          ? gte(benchmarkProfiles.requested_at, current.requestedAfter)
          : undefined,
        queue === 'platform'
          ? eq(benchmarkProfiles.platform_requested, true)
          : eq(benchmarkProfiles.user_requested, true)
      )
    )
    .orderBy(
      asc(benchmarkProfiles.requested_at),
      asc(benchmarkProfiles.model),
      asc(benchmarkProfiles.variant)
    );
}

/** Queued, unclaimed re-measures of ready current-engine rows wanted by one queue. */
export async function listQueuedRemeasures(
  db: D1Database,
  current: {
    router?: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    requestedAfter?: string;
  },
  queue: BenchmarkRunPurpose
): Promise<Array<{ model: string; variant: string; requested_at: string }>> {
  return drizzle(db)
    .select({
      model: profileRemeasures.model,
      variant: profileRemeasures.variant,
      requested_at: profileRemeasures.requested_at,
    })
    .from(profileRemeasures)
    .innerJoin(
      benchmarkProfiles,
      and(
        eq(benchmarkProfiles.router, profileRemeasures.router),
        eq(benchmarkProfiles.model, profileRemeasures.model),
        eq(benchmarkProfiles.variant, profileRemeasures.variant),
        eq(benchmarkProfiles.engine_identity, profileRemeasures.engine_identity),
        eq(benchmarkProfiles.repetitions, profileRemeasures.repetitions)
      )
    )
    .where(
      and(
        isNull(profileRemeasures.run_id),
        eq(profileRemeasures.router, current.router ?? 'efficient'),
        eq(profileRemeasures.engine_identity, current.engineIdentity),
        eq(profileRemeasures.repetitions, current.repetitions),
        current.requestedAfter
          ? gte(profileRemeasures.requested_at, current.requestedAfter)
          : undefined,
        eq(benchmarkProfiles.status, 'ready'),
        queue === 'platform'
          ? eq(benchmarkProfiles.platform_requested, true)
          : eq(benchmarkProfiles.user_requested, true)
      )
    )
    .orderBy(
      asc(profileRemeasures.requested_at),
      asc(profileRemeasures.model),
      asc(profileRemeasures.variant)
    );
}

/**
 * A `pending` row is queue work only when requested at or after the paid cutover; every other
 * status passes unfiltered. `undefined` leaves the read untouched; `null` fails pending closed.
 */
function pendingRespectsCutover(cutoverAt: string | null | undefined) {
  if (cutoverAt === undefined) return undefined;
  if (cutoverAt === null) return ne(benchmarkProfiles.status, 'pending');
  return or(
    ne(benchmarkProfiles.status, 'pending'),
    gte(benchmarkProfiles.requested_at, cutoverAt)
  );
}

/** Registry row counts per wire status for one queue's current-engine rows. */
export async function countCurrentProfilesByStatus(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  queue: BenchmarkRunPurpose,
  cutoverAt?: string | null
): Promise<Array<{ status: BenchmarkProfileStatus; count: number }>> {
  const rows = await drizzle(db)
    .select({ status: benchmarkProfiles.status, n: count() })
    .from(benchmarkProfiles)
    .where(
      and(
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        queue === 'platform'
          ? eq(benchmarkProfiles.platform_requested, true)
          : eq(benchmarkProfiles.user_requested, true),
        pendingRespectsCutover(cutoverAt)
      )
    )
    .groupBy(benchmarkProfiles.status);
  const counts = new Map<BenchmarkProfileStatus, number>();
  for (const row of rows) {
    const status = row.status === 'unavailable' ? 'failed' : row.status;
    counts.set(status, (counts.get(status) ?? 0) + row.n);
  }
  return [...counts].map(([status, n]) => ({ status, count: n }));
}

/** Exact platform-pair coverage for the currently measured engine and repetitions. */
export async function listCurrentPlatformProfileStatuses(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  cutoverAt?: string | null
): Promise<
  Array<{
    model: string;
    variant: string | null;
    status: BenchmarkProfileStatus;
    /**
     * When this row's current failure settled, or null. The failure transition writes it, so a
     * copied or migrated row keeps the original instant while a retry timer only moves
     * `retry_after`. Always selected, so a null value is a real "no failure instant" and never
     * evidence that licenses a rewrite.
     */
    completed_at: string | null;
  }>
> {
  const rows = await drizzle(db)
    .select({
      model: benchmarkProfiles.model,
      variant: benchmarkProfiles.variant,
      status: benchmarkProfiles.status,
      completed_at: benchmarkProfiles.completed_at,
    })
    .from(benchmarkProfiles)
    .where(
      and(
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.platform_requested, true),
        pendingRespectsCutover(cutoverAt)
      )
    )
    .orderBy(asc(benchmarkProfiles.model), asc(benchmarkProfiles.variant));
  return rows.map(row => ({
    model: row.model,
    variant: variantFromStorage(row.variant),
    status: row.status === 'unavailable' ? 'failed' : row.status,
    completed_at: row.completed_at,
  }));
}

/**
 * Admin requeue: put retryable failed current-engine rows of a queue whose retry window
 * has passed back to `pending`. Permanently failed rows are never bulk re-admitted. The
 * failure history stays so the retry budgets keep counting. Charges no owner quota —
 * this is the admin's own escape hatch, distinct from an owner's Retry. Returns how
 * many rows moved.
 */
export async function requeueRetryableCurrentProfiles(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  queue: BenchmarkRunPurpose | 'both',
  nowIso: string = new Date().toISOString()
): Promise<number> {
  const queueFilter =
    queue === 'both'
      ? or(
          eq(benchmarkProfiles.platform_requested, true),
          eq(benchmarkProfiles.user_requested, true)
        )
      : queue === 'platform'
        ? eq(benchmarkProfiles.platform_requested, true)
        : eq(benchmarkProfiles.user_requested, true);
  const result = await drizzle(db)
    .update(benchmarkProfiles)
    .set({
      status: 'pending',
      run_id: null,
      failure_reason: null,
      retry_after: null,
      requested_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
    })
    .where(
      and(
        eq(benchmarkProfiles.status, 'failed'),
        or(isNull(benchmarkProfiles.retry_after), lte(benchmarkProfiles.retry_after, nowIso)),
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        noLiveBenchmarkChunks({
          router: benchmarkProfiles.router,
          model: benchmarkProfiles.model,
          variant: benchmarkProfiles.variant,
          engineIdentity: benchmarkProfiles.engine_identity,
          repetitions: benchmarkProfiles.repetitions,
        }),
        queueFilter
      )
    );
  return result.meta.changes ?? 0;
}

/**
 * Failed current-engine rows, retryable and permanent, that a queue still wants. Rows in
 * neither queue are left out: no drain would measure them again, so no action applies.
 */
export async function listCurrentFailedProfiles(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number }
): Promise<BenchmarkRegistryFailedEntry[]> {
  const rows = await drizzle(db)
    .select()
    .from(benchmarkProfiles)
    .where(
      and(
        inArray(benchmarkProfiles.status, ['failed', 'unavailable']),
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        or(
          eq(benchmarkProfiles.platform_requested, true),
          eq(benchmarkProfiles.user_requested, true)
        )
      )
    )
    .orderBy(asc(benchmarkProfiles.model), asc(benchmarkProfiles.variant));
  return rows.flatMap(row => {
    const failure = wireProfileFailure(parseProfileState(row));
    if (!failure) return [];
    const queues: BenchmarkRunPurpose[] = [
      ...(row.platform_requested ? ['platform' as const] : []),
      ...(row.user_requested ? ['user' as const] : []),
    ];
    return [
      {
        model: row.model,
        variant: variantFromStorage(row.variant),
        queues,
        runId: row.run_id,
        failure,
      },
    ];
  });
}

/**
 * Reconcile the platform queue with the saved decider model list: every desired
 * exact pair gets a current-engine registry row flagged platform_requested, and
 * pairs that left the list lose the flag. Existing measurements are never
 * discarded — a `ready` row only gains the flag, so a pair already measured for
 * an owner pool is reused by the platform table instead of re-benchmarked.
 *
 * Only pairs that actually left the list are released, so a pair that stays in
 * the pool keeps its `requested_at`: pre-cutover pending work stays parked, and a
 * pair that is genuinely (re)added gets a fresh request time the drain admits.
 * Each desired pair also latches platform coverage on any live case run of that
 * pair in the same batch, so the platform pays for a case run a user already
 * started (and keeps paying for it if the pair leaves the pool before it settles).
 */
export async function syncPlatformRegistryRows(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  desired: readonly { model: string; variant: string | null }[],
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const orm = drizzle(db);
  const desiredKeys = new Set(desired.map(entry => exactPairKey(entry.model, entry.variant)));
  const flagged = await orm
    .select({ model: benchmarkProfiles.model, variant: benchmarkProfiles.variant })
    .from(benchmarkProfiles)
    .where(
      and(
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.platform_requested, true)
      )
    );
  const released = flagged.filter(
    row => !desiredKeys.has(exactPairKey(row.model, variantFromStorage(row.variant)))
  );

  const stmts: Array<
    | ReturnType<typeof releasePlatformRequestedStatement>
    | ReturnType<typeof claimPlatformRequestedStatement>
  > = [];
  for (const row of released) {
    stmts.push(releasePlatformRequestedStatement(orm, row, current));
  }
  for (const pair of desired) {
    stmts.push(claimPlatformRequestedStatement(orm, pair, current, nowIso));
  }
  // Coverage latches in the SAME D1 transaction as the membership writes. Under
  // just-in-time billing a case request between two batches could be charged to a user the
  // platform had already assigned to itself (or vice versa); one transaction makes the
  // join-versus-assignment race resolve to a single ordering.
  const coverage = desired.flatMap(pair =>
    platformCoverageStatements(db, {
      membership: {
        router: current.router ?? 'efficient',
        engineIdentity: current.engineIdentity,
        model: pair.model,
        variant: variantToStorage(pair.variant ?? null),
        repetitions: current.repetitions,
      },
    })
  );
  if (stmts.length === 0 && coverage.length === 0) return;
  // Drizzle and the store's prepared statements cannot share `orm.batch`, so both are
  // compiled to D1 statements and run as one `db.batch` transaction.
  const prepared = stmts.map(statement => {
    const built = statement.toSQL();
    return db.prepare(built.sql).bind(...built.params);
  });
  await db.batch([...prepared, ...coverage]);
}

/**
 * Claim `platform_requested` for one desired pair, creating the row as pending
 * when it does not exist yet. Exported for the reconcile-vs-reaper test.
 */
export function claimPlatformRequestedStatement(
  orm: ReturnType<typeof drizzle>,
  entry: { model: string; variant: string | null },
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  nowIso: string
) {
  return (
    orm
      .insert(benchmarkProfiles)
      .values({
        model: entry.model,
        router: current.router ?? 'efficient',
        variant: variantToStorage(entry.variant),
        engine_identity: current.engineIdentity,
        repetitions: current.repetitions,
        status: 'pending',
        run_id: null,
        failure_reason: null,
        requested_at: nowIso,
        updated_at: nowIso,
        completed_at: null,
        platform_requested: true,
        user_requested: false,
      })
      // Only claim the flag on an existing row. Status is left alone so a
      // ready measurement stays ready and a failed one stays failed until
      // someone requeues it.
      .onConflictDoUpdate({
        target: [
          benchmarkProfiles.router,
          benchmarkProfiles.model,
          benchmarkProfiles.variant,
          benchmarkProfiles.engine_identity,
          benchmarkProfiles.repetitions,
        ],
        // updated_at is deliberately NOT bumped here. It times the row's
        // measurement lifecycle — claim, settle — and the orphaned-claim
        // reaper only touches rows untouched for hours. This reconcile runs
        // every 15 minutes, so bumping it would hold every platform row
        // permanently below the reaper's age guard and an orphaned claim
        // would leave that pair unmeasured, never reaching the routing table.
        //
        // `requested_at` moves only when the flag was absent: a pair that just
        // (re)joined the pool is new work the drain admits, while a pair that
        // stayed in the pool keeps its request time, so pre-cutover pending work
        // stays parked and an admin-cancelled run is not re-admitted in a minute.
        set: {
          platform_requested: true,
          requested_at: sql`CASE WHEN ${benchmarkProfiles.platform_requested} = 0
            THEN excluded.requested_at ELSE ${benchmarkProfiles.requested_at} END`,
        },
      })
  );
}

/**
 * Drop `platform_requested` from one pair that left the saved decider list. Storage-form
 * variant. Leaves `updated_at` alone for the reason given on the claim above.
 */
export function releasePlatformRequestedStatement(
  orm: ReturnType<typeof drizzle>,
  pair: { model: string; variant: string },
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number }
) {
  return orm
    .update(benchmarkProfiles)
    .set({ platform_requested: false })
    .where(
      and(
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.model, pair.model),
        eq(benchmarkProfiles.variant, pair.variant),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.platform_requested, true)
      )
    );
}

/**
 * Drop `platform_requested` across the current-engine registry, so a reconcile
 * can re-set it per desired pair. Exported for the reconcile-vs-reaper test.
 *
 * Leaves `updated_at` alone for the reason given on the claim above.
 */
export function clearPlatformRequestedStatement(
  orm: ReturnType<typeof drizzle>,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number }
) {
  return orm
    .update(benchmarkProfiles)
    .set({ platform_requested: false })
    .where(
      and(
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.platform_requested, true)
      )
    );
}

/**
 * Ready current-engine profiles for the given exact pairs (for custom table assembly).
 */
export async function listReadyCurrentProfilesForEntries(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  entries: readonly BenchmarkPair[]
): Promise<Array<{ model: string; variant: string; run_id: string | null }>> {
  if (entries.length === 0) return [];
  const models = [...new Set(entries.map(e => e.model))];
  const orm = drizzle(db);
  // One bound variable per model. The platform decider list is unbounded, so
  // chunk rather than let a long list trip D1's ceiling.
  const rows: Array<{ model: string; variant: string; run_id: string | null }> = [];
  for (let i = 0; i < models.length; i += PROFILE_ENTRY_FILTER_BATCH_SIZE) {
    rows.push(
      ...(await orm
        .select({
          model: benchmarkProfiles.model,
          variant: benchmarkProfiles.variant,
          run_id: benchmarkProfiles.run_id,
        })
        .from(benchmarkProfiles)
        .where(
          and(
            inArray(benchmarkProfiles.model, models.slice(i, i + PROFILE_ENTRY_FILTER_BATCH_SIZE)),
            eq(benchmarkProfiles.status, 'ready'),
            eq(benchmarkProfiles.router, current.router ?? 'efficient'),
            eq(benchmarkProfiles.engine_identity, current.engineIdentity),
            eq(benchmarkProfiles.repetitions, current.repetitions)
          )
        ))
    );
  }
  const wanted = new Set(entries.map(e => exactPairKey(e.model, e.variant)));
  return rows
    .filter(row => wanted.has(exactPairKey(row.model, variantFromStorage(row.variant))))
    .map(row => ({
      model: row.model,
      variant: row.variant,
      run_id: row.run_id,
    }));
}

/**
 * Load model_summaries for the given run ids (custom table assembly).
 * Each row carries its provenance `runId` so assembly can bind candidates to
 * the measuring run for each ready entry (no cross-run leakage).
 */
export async function getSummariesForRuns(
  db: D1Database,
  runIds: readonly string[]
): Promise<BenchmarkModelSummaryWithRun[]> {
  if (runIds.length === 0) return [];
  const orm = drizzle(db);
  // One bound variable per run id. Each ready registry row carries its own
  // measuring run, so this set grows with the decider list and with every
  // requeue — chunk it rather than let it trip D1's ceiling and freeze the
  // published table behind a swallowed error.
  const ids = [...runIds];
  const summaries: BenchmarkModelSummaryWithRun[] = [];
  for (let i = 0; i < ids.length; i += PROFILE_ENTRY_FILTER_BATCH_SIZE) {
    const rows = await orm
      .select()
      .from(modelSummaries)
      .where(inArray(modelSummaries.run_id, ids.slice(i, i + PROFILE_ENTRY_FILTER_BATCH_SIZE)));
    summaries.push(...rows.map(mapSummaryRowWithRun));
  }
  return summaries;
}

/**
 * Running decider run ids older than the stale threshold (for profile fail-over
 * after the bulk stale sweep).
 */
/**
 * Fail registry rows stuck `running` with no live run behind them. Two ways in:
 * a run reached a terminal state without settling its rows (its transition
 * threw), or the claim landed and the run row was never written at all. Neither
 * is reachable otherwise — the drain wants `pending`, requeue wants `failed`,
 * and the stale sweep only looks at runs that are still `running`. Left alone
 * they stay claimed forever, so the pair is neither served nor re-measured and
 * the routing table would never gain it.
 *
 * The age guard is what makes this safe to run from every sweep: a run marks
 * itself completed just before settling its rows, so without it this would fail
 * fully-measured entries mid-finalization and send them back to be re-measured
 * at full cost.
 */
export function failOrphanedRunningProfilesStatement(
  orm: ReturnType<typeof drizzle>,
  failureReason: string,
  olderThanIso: string,
  nowIso: string
) {
  return orm
    .update(benchmarkProfiles)
    .set(
      profileFailureAssignments({ failureClass: 'orphaned_claim', reason: failureReason }, nowIso)
    )
    .where(
      and(
        eq(benchmarkProfiles.status, 'running'),
        lt(benchmarkProfiles.updated_at, olderThanIso),
        notInArray(
          benchmarkProfiles.run_id,
          orm
            .select({ id: benchmarkRuns.id })
            .from(benchmarkRuns)
            .where(eq(benchmarkRuns.status, 'running'))
        )
      )
    );
}

export async function failOrphanedRunningProfiles(
  db: D1Database,
  failureReason: string,
  olderThanIso: string,
  nowIso: string = new Date().toISOString()
): Promise<number> {
  const orm = drizzle(db);
  const [failed] = await orm.batch([
    failOrphanedRunningProfilesStatement(orm, failureReason, olderThanIso, nowIso),
    orm
      .delete(profileRemeasures)
      .where(
        and(
          isNotNull(profileRemeasures.run_id),
          lt(profileRemeasures.claimed_at, olderThanIso),
          notInArray(
            profileRemeasures.run_id,
            orm
              .select({ id: benchmarkRuns.id })
              .from(benchmarkRuns)
              .where(eq(benchmarkRuns.status, 'running'))
          )
        )
      ),
  ]);
  return failed.meta.changes ?? 0;
}

/**
 * Release rows this run claimed back to `pending` (claim made, run never written), and
 * its re-measure claims back to the queue.
 */
export async function releaseProfileClaims(db: D1Database, runId: string): Promise<void> {
  const orm = drizzle(db);
  await orm.batch([
    orm
      .update(benchmarkProfiles)
      .set({ status: 'pending', run_id: null, updated_at: new Date().toISOString() })
      .where(and(eq(benchmarkProfiles.run_id, runId), eq(benchmarkProfiles.status, 'running'))),
    orm
      .update(profileRemeasures)
      .set({ run_id: null, claimed_at: null })
      .where(eq(profileRemeasures.run_id, runId)),
  ]);
}

export async function listStaleRunningDeciderRuns(
  db: D1Database,
  olderThanIso: string
): Promise<Array<{ id: string; purpose: BenchmarkRunPurpose }>> {
  const rows = await drizzle(db)
    .select({ id: benchmarkRuns.id, purpose: benchmarkRuns.purpose })
    .from(benchmarkRuns)
    .where(
      and(
        eq(benchmarkRuns.kind, 'decider'),
        eq(benchmarkRuns.status, 'running'),
        lt(benchmarkRuns.started_at, olderThanIso),
        sql`NOT EXISTS (SELECT 1 FROM scheduler_runs WHERE run_id = ${benchmarkRuns.id})`
      )
    );
  return rows.map(r => ({ id: r.id, purpose: r.purpose === 'user' ? 'user' : 'platform' }));
}

// What the most recent completed run measured for an exact benchmark pair, plus
// the benchmark identity it was measured under. startRun carries these
// summaries into a new run only when the identity (engine + repetitions +
// exact variant) still matches; otherwise the entry is re-benchmarked.
export type PriorModelResult = {
  engineIdentity: string;
  repetitions: number;
  /** Canonical variant (null = default). Prefer this for carry matching. */
  variant: string | null;
  /**
   * Legacy effort mirror from run_models. Still exposed so older callers and
   * legacy-row tests can inspect it; carry matching uses `variant`.
   */
  reasoningEffort: string | null;
  summaries: BenchmarkModelSummary[];
};

/**
 * Canonical map key for an exact (model, variant) pair. Uses the shared
 * benchmarkPairKey contract helper so keys stay collision-safe.
 */
export function exactPairKey(model: string, variant: string | null | undefined): string {
  return benchmarkPairKey({ model, variant: variant ?? null });
}

// Latest summaries per exact benchmark pair for a benchmark kind: for each
// (model, variant), all routes from the most recent COMPLETED run that
// included that pair (mixing routes across runs would pair incomparable numbers).
export async function getLatestSummariesByModel(
  db: D1Database,
  kind: BenchmarkKind,
  router: AutoRouter = 'efficient'
): Promise<Map<string, PriorModelResult>> {
  const results = await drizzle(db)
    .select({
      run_id: modelSummaries.run_id,
      model: modelSummaries.model,
      variant: modelSummaries.variant,
      route_key: modelSummaries.route_key,
      accuracy: modelSummaries.accuracy,
      avg_cost_usd: modelSummaries.avg_cost_usd,
      avg_input_tokens: modelSummaries.avg_input_tokens,
      avg_cached_input_tokens: modelSummaries.avg_cached_input_tokens,
      avg_output_tokens: modelSummaries.avg_output_tokens,
      avg_reasoning_tokens: modelSummaries.avg_reasoning_tokens,
      avg_latency_ms: modelSummaries.avg_latency_ms,
      p50_latency_ms: modelSummaries.p50_latency_ms,
      p95_latency_ms: modelSummaries.p95_latency_ms,
      cases: modelSummaries.cases,
      costed_cases: modelSummaries.costed_cases,
      errors: modelSummaries.errors,
      timeouts: modelSummaries.timeouts,
      route_accuracy: modelSummaries.route_accuracy,
      carried: modelSummaries.carried,
      engine_identity: benchmarkRuns.engine_identity,
      repetitions: benchmarkRuns.repetitions,
      reasoning_effort: runModels.reasoning_effort,
    })
    .from(modelSummaries)
    .innerJoin(benchmarkRuns, eq(benchmarkRuns.id, modelSummaries.run_id))
    .leftJoin(
      runModels,
      and(
        eq(runModels.run_id, modelSummaries.run_id),
        eq(runModels.model, modelSummaries.model),
        eq(runModels.variant, modelSummaries.variant)
      )
    )
    .where(
      and(
        eq(benchmarkRuns.router, router),
        eq(benchmarkRuns.kind, kind),
        eq(benchmarkRuns.status, 'completed')
      )
    )
    .orderBy(desc(benchmarkRuns.started_at));

  const latestRunByPair = new Map<string, string>();
  for (const row of results) {
    const pairKey = exactPairKey(row.model, variantFromStorage(row.variant));
    if (!latestRunByPair.has(pairKey)) latestRunByPair.set(pairKey, row.run_id);
  }
  const byPair = new Map<string, PriorModelResult>();
  for (const row of results) {
    const appVariant = variantFromStorage(row.variant);
    const pairKey = exactPairKey(row.model, appVariant);
    if (latestRunByPair.get(pairKey) !== row.run_id) continue;
    const existing = byPair.get(pairKey);
    if (existing) {
      existing.summaries.push(mapSummaryRow(row));
    } else {
      byPair.set(pairKey, {
        engineIdentity: row.engine_identity,
        repetitions: row.repetitions,
        variant: appVariant,
        // Prefer the summary/run_models variant; fall back to legacy effort for
        // rows migrated before variant was written independently.
        reasoningEffort: row.reasoning_effort ?? appVariant,
        summaries: [mapSummaryRow(row)],
      });
    }
  }
  return byPair;
}

type RoutingTableRow = typeof routingTables.$inferSelect;
type RoutingTableCandidateRow = typeof routingTableCandidates.$inferSelect;

export function routingTableToRows(
  table: RoutingTable,
  publishedAt: string,
  router: AutoRouter = 'efficient',
  desiredPairs: readonly string[] | null = null
): { tableRow: RoutingTableRow; candidateRows: RoutingTableCandidateRow[] } {
  const tableRow: RoutingTableRow = {
    run_id: table.version,
    router,
    published_at: publishedAt,
    generated_at: table.generatedAt,
    min_accuracy: table.minAccuracy,
    accuracy_noise_band: table.accuracyNoiseBand ?? null,
    switch_cost_factor: table.switchCostFactor,
    best_accuracy_switch_threshold: table.bestAccuracySwitchThreshold,
    production_token_profile: table.productionTokenProfile ?? null,
    switch_horizon_turns: table.switchHorizonTurns ?? null,
    low_confidence_threshold: table.lowConfidenceThreshold ?? null,
    effort_by_complexity: table.effortByComplexity ?? null,
    desired_pairs: desiredPairs === null ? null : [...desiredPairs],
    source: table.source,
  };

  const candidateRows: RoutingTableCandidateRow[] = [];
  for (const [routeKey, candidates] of Object.entries(table.routes)) {
    candidates.forEach((c, rank) => {
      // New tables emit canonical variant keys. Preserve legacy effort identity
      // when persisting an older table.
      const effortKey = c.reasoningEffort ?? null;
      const variantKey = c.variant ?? effortKey;
      candidateRows.push({
        run_id: table.version,
        route_key: routeKey,
        rank,
        model: c.model,
        accuracy: c.accuracy,
        cases: c.cases ?? null,
        avg_cost_usd: c.avgCostUsd,
        meets_threshold: c.meetsThreshold,
        reasoning_effort: effortKey,
        variant: variantToStorage(variantKey),
        pricing: c.pricing ?? null,
        estimated_request_cost_usd: c.estimatedRequestCostUsd ?? null,
        p50_latency_ms: c.p50LatencyMs ?? null,
        p50_ttft_ms: c.p50TtftMs ?? null,
      });
    });
  }

  return { tableRow, candidateRows };
}

export function rowsToRoutingTable(
  tableRow: RoutingTableRow,
  candidateRows: RoutingTableCandidateRow[]
): RoutingTable {
  const routeMap: Record<string, RankedCandidate[]> = {};
  const sorted = [...candidateRows].sort((a, b) => {
    if (a.route_key !== b.route_key) return a.route_key.localeCompare(b.route_key);
    return a.rank - b.rank;
  });
  for (const row of sorted) {
    routeMap[row.route_key] ??= [];
    // Retain legacy effort-only reads; canonical rows always expose variant.
    const effort = parsePersistedReasoningEffort(row.reasoning_effort);
    routeMap[row.route_key].push({
      model: row.model,
      accuracy: row.accuracy,
      ...(row.cases != null ? { cases: row.cases } : {}),
      avgCostUsd: row.avg_cost_usd,
      meetsThreshold: row.meets_threshold,
      ...(row.p50_latency_ms != null ? { p50LatencyMs: row.p50_latency_ms } : {}),
      ...(row.p50_ttft_ms != null ? { p50TtftMs: row.p50_ttft_ms } : {}),
      ...(row.pricing != null || row.estimated_request_cost_usd != null
        ? { pricing: row.pricing ?? null }
        : {}),
      ...(row.estimated_request_cost_usd != null
        ? { estimatedRequestCostUsd: row.estimated_request_cost_usd }
        : {}),
      ...(effort !== null
        ? { reasoningEffort: effort }
        : { variant: variantFromStorage(row.variant) }),
    });
  }
  return {
    version: tableRow.run_id,
    generatedAt: tableRow.generated_at,
    minAccuracy: tableRow.min_accuracy,
    ...(tableRow.accuracy_noise_band != null
      ? { accuracyNoiseBand: tableRow.accuracy_noise_band }
      : {}),
    switchCostFactor: tableRow.switch_cost_factor,
    bestAccuracySwitchThreshold: tableRow.best_accuracy_switch_threshold,
    ...(tableRow.production_token_profile != null ||
    sorted.some(row => row.estimated_request_cost_usd != null)
      ? {
          productionTokenProfile: tableRow.production_token_profile ?? null,
          switchHorizonTurns: tableRow.switch_horizon_turns ?? null,
        }
      : tableRow.switch_horizon_turns != null
        ? { switchHorizonTurns: tableRow.switch_horizon_turns }
        : {}),
    ...(tableRow.low_confidence_threshold != null
      ? { lowConfidenceThreshold: tableRow.low_confidence_threshold }
      : {}),
    ...(tableRow.effort_by_complexity != null
      ? { effortByComplexity: tableRow.effort_by_complexity }
      : {}),
    source: tableRow.source as RoutingTable['source'],
    routes: routeMap,
  };
}

export async function saveRoutingTable(
  db: D1Database,
  table: RoutingTable,
  publishedAt: string,
  router: AutoRouter = 'efficient',
  desiredPairs: readonly string[] | null = null
): Promise<void> {
  const orm = drizzle(db);
  const { tableRow, candidateRows } = routingTableToRows(table, publishedAt, router, desiredPairs);

  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm.delete(routingTableCandidates).where(eq(routingTableCandidates.run_id, table.version)),
    orm
      .insert(routingTables)
      .values(tableRow)
      .onConflictDoUpdate({
        target: routingTables.run_id,
        set: {
          published_at: tableRow.published_at,
          generated_at: tableRow.generated_at,
          min_accuracy: tableRow.min_accuracy,
          accuracy_noise_band: tableRow.accuracy_noise_band,
          switch_cost_factor: tableRow.switch_cost_factor,
          best_accuracy_switch_threshold: tableRow.best_accuracy_switch_threshold,
          production_token_profile: tableRow.production_token_profile,
          switch_horizon_turns: tableRow.switch_horizon_turns,
          low_confidence_threshold: tableRow.low_confidence_threshold,
          effort_by_complexity: tableRow.effort_by_complexity,
          desired_pairs: tableRow.desired_pairs,
          source: tableRow.source,
        },
      }),
  ];

  for (let i = 0; i < candidateRows.length; i += ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE) {
    stmts.push(
      orm
        .insert(routingTableCandidates)
        .values(candidateRows.slice(i, i + ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE))
    );
  }

  await orm.batch(stmts);
}

/**
 * Record the exact desired platform membership on an already-published artifact.
 *
 * Used once, at the paid cutover, for a publication written before the column existed: the
 * configured/resolved set is the durable baseline every later publish is compared against,
 * so an unchanged pool is never rebuilt (rebuilding under a newer measurement revision can
 * narrow routes) while a real addition, removal or alias pin still publishes. Only this
 * column changes; the artifact rows are untouched.
 */
export async function recordPublishedDesiredPairs(
  db: D1Database,
  version: string,
  pairs: readonly string[]
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE routing_tables SET desired_pairs = ?
      WHERE run_id = ? AND desired_pairs IS NULL`
    )
    .bind(JSON.stringify([...pairs].sort()), version)
    .run();
  return result.meta.changes ?? 0;
}

export async function getLatestRoutingTable(
  db: D1Database,
  router: AutoRouter = 'efficient'
): Promise<{
  table: RoutingTable;
  publishedAt: string;
  /** Exact desired platform membership at publication; null on pre-cutover publications. */
  desiredPairs: string[] | null;
} | null> {
  const orm = drizzle(db);
  const tableRow = await orm
    .select()
    .from(routingTables)
    .where(eq(routingTables.router, router))
    .orderBy(desc(routingTables.published_at))
    .limit(1)
    .get();

  if (!tableRow) return null;

  const candidateRows = await orm
    .select()
    .from(routingTableCandidates)
    .where(eq(routingTableCandidates.run_id, tableRow.run_id))
    .orderBy(routingTableCandidates.route_key, routingTableCandidates.rank);

  const assembled = rowsToRoutingTable(tableRow, candidateRows);
  const parsed = RoutingTableSchema.safeParse(assembled);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: 'routing_table_invalid',
        run_id: tableRow.run_id,
        error: parsed.error.message,
      })
    );
    return null;
  }

  return {
    table: parsed.data,
    publishedAt: tableRow.published_at,
    desiredPairs: tableRow.desired_pairs ?? null,
  };
}

// Only runs measured under the current classifier engine count: a winner from
// the earlier chat-completions classifier is not a System One model id.
export async function getClassifierWinner(
  db: D1Database,
  engineIdentity: string
): Promise<ClassifierWinner | null> {
  const orm = drizzle(db);
  // Find the latest completed classifier run.
  const runRow = await orm
    .select()
    .from(benchmarkRuns)
    .where(
      and(
        eq(benchmarkRuns.kind, 'classifier'),
        eq(benchmarkRuns.status, 'completed'),
        eq(benchmarkRuns.engine_identity, engineIdentity)
      )
    )
    .orderBy(desc(benchmarkRuns.completed_at))
    .limit(1)
    .get();

  if (!runRow) return null;

  // Get the routeKey='*' summaries for this run (classifier has no taxonomy route).
  const summaryRows = await orm
    .select()
    .from(modelSummaries)
    .where(and(eq(modelSummaries.run_id, runRow.id), eq(modelSummaries.route_key, '*')));

  const summaries = summaryRows.map(mapSummaryRow);
  const winner = pickClassifierWinner(
    summaries,
    runRow.min_accuracy,
    runRow.classifier_max_p95_latency_ms
  );
  if (!winner) return null;

  return {
    engine: 'system-one',
    model: winner.model,
    runId: runRow.id,
    accuracy: winner.accuracy,
    p95LatencyMs: winner.p95LatencyMs,
    generatedAt: runRow.completed_at ?? new Date().toISOString(),
  };
}
