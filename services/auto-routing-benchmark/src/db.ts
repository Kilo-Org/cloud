import type {
  BenchmarkKind,
  BenchmarkModelSummary,
  BenchmarkProfileStatus,
  BenchmarkRun,
  BenchmarkRunPurpose,
  ClassifierWinner,
  RankedCandidate,
  RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { poolEntryKey, RoutingTableSchema } from '@kilocode/auto-routing-contracts';
import type { PoolEntry } from '@kilocode/auto-routing-contracts';
import { BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH } from '@kilocode/auto-routing-contracts';
import type { BatchItem } from 'drizzle-orm/batch';
import { and, asc, count, desc, eq, gt, inArray, lt, ne, notInArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  benchmarkConfig,
  benchmarkProfiles,
  benchmarkRuns,
  caseResults,
  configAutoDeciderExclusions,
  configAutoDeciderModels,
  configClassifierModels,
  configDeciderModels,
  modelSummaries,
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

export type CaseResultRow = typeof caseResults.$inferSelect;
export type RunRow = typeof benchmarkRuns.$inferSelect;
export type RunModelRow = typeof runModels.$inferSelect;
export type ConfigDeciderModelRow = typeof configDeciderModels.$inferSelect;
export type ConfigAutoDeciderModelRow = typeof configAutoDeciderModels.$inferSelect;
type ModelSummaryRow = typeof modelSummaries.$inferSelect;

// D1 rejects statements with too many bound variables. A model summary insert
// binds 13 values per row (including variant), so 7 rows keeps each INSERT
// below the 100-variable ceiling while still batching the delete plus inserts.
const MODEL_SUMMARY_INSERT_BATCH_SIZE = 7;

// Routing table candidates bind 9 values per row (including variant). Keep each
// INSERT comfortably under D1's 100-variable ceiling; publishing is infrequent,
// so smaller statements are preferable to risking a skipped routing-table update.
const ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE = 10;

// Run model rows bind 5 values per row. Keep each INSERT comfortably under D1's
// 100-variable ceiling; the profile drain claims batches of up to 33 entries,
// and an unchunked 33-row insert fails with "too many SQL variables", which
// stranded every pending Benchmark profile in production.
const RUN_MODEL_INSERT_BATCH_SIZE = 18;

// Statements that name a set of exact pairs bind two variables per entry on top
// of a small fixed clause. 30 keeps each one well inside D1's 100-variable
// ceiling — the same ceiling that once stranded every pending profile in prod.
const PROFILE_ENTRY_FILTER_BATCH_SIZE = 30;

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

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

export function mapSummaryRow(row: ModelSummaryRow): BenchmarkModelSummary {
  return {
    model: row.model,
    variant: variantFromStorage(row.variant),
    routeKey: row.route_key as BenchmarkModelSummary['routeKey'],
    accuracy: row.accuracy,
    avgCostUsd: row.avg_cost_usd,
    avgLatencyMs: row.avg_latency_ms,
    p50LatencyMs: row.p50_latency_ms,
    p95LatencyMs: row.p95_latency_ms,
    cases: row.cases,
    errors: row.errors,
    timeouts: row.timeouts,
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

export function mapRunRow(row: RunRow, summaries: BenchmarkModelSummary[]): BenchmarkRun {
  return {
    id: row.id,
    kind: row.kind,
    purpose: row.purpose === 'user' ? 'user' : 'platform',
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    summaries,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getConfigRows(db: D1Database): Promise<{
  config: typeof benchmarkConfig.$inferSelect | null;
  classifierModels: string[];
  deciderModels: ConfigDeciderModelRow[];
  autoDeciderModels: ConfigAutoDeciderModelRow[];
  excludedAutoDeciderModels: string[];
}> {
  const orm = drizzle(db);
  const [configRows, classifierRows, deciderRows, autoDeciderRows, exclusionRows] =
    await Promise.all([
      orm.select().from(benchmarkConfig).where(eq(benchmarkConfig.id, 1)).limit(1),
      orm.select().from(configClassifierModels),
      orm.select().from(configDeciderModels),
      orm.select().from(configAutoDeciderModels),
      orm.select().from(configAutoDeciderExclusions),
    ]);
  return {
    config: configRows[0] ?? null,
    classifierModels: classifierRows.map(r => r.model),
    deciderModels: deciderRows,
    autoDeciderModels: autoDeciderRows,
    excludedAutoDeciderModels: exclusionRows.map(r => r.model),
  };
}

export async function replaceConfig(
  db: D1Database,
  config: {
    min_accuracy: number;
    switch_cost_factor: number;
    best_accuracy_switch_threshold: number;
    max_concurrency: number;
    user_max_concurrency: number;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    classifier_repetitions: number;
    decider_repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    auto_decider_min_cost_usd: number;
    auto_decider_max_cost_usd: number;
    updated_at: string;
    updated_by: string | null;
  },
  classifierModels: string[],
  deciderModels: ConfigDeciderModelRow[],
  excludedAutoDeciderModels: string[] = []
): Promise<void> {
  const orm = drizzle(db);
  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm
      .insert(benchmarkConfig)
      .values({ id: 1, ...config })
      .onConflictDoUpdate({
        target: benchmarkConfig.id,
        set: config,
      }),
    orm.delete(configClassifierModels),
    orm.delete(configDeciderModels),
    orm.delete(configAutoDeciderExclusions),
  ];
  for (const batch of batchRows(classifierModels)) {
    stmts.push(orm.insert(configClassifierModels).values(batch.map(m => ({ model: m }))));
  }
  for (const batch of batchRows(deciderModels)) {
    stmts.push(orm.insert(configDeciderModels).values(batch));
  }
  for (const batch of batchRows(excludedAutoDeciderModels)) {
    stmts.push(orm.insert(configAutoDeciderExclusions).values(batch.map(model => ({ model }))));
  }
  await orm.batch(stmts);
}

export async function replaceAutoDeciderModels(
  db: D1Database,
  autoDeciderModels: ConfigAutoDeciderModelRow[]
): Promise<void> {
  const orm = drizzle(db);
  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm.delete(configAutoDeciderModels),
  ];
  for (const batch of batchRows(autoDeciderModels)) {
    stmts.push(orm.insert(configAutoDeciderModels).values(batch));
  }
  await orm.batch(stmts);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Which registry queue a run drains: the platform decider list, or owner pools. */
export type { BenchmarkRunPurpose };

export async function insertRun(
  db: D1Database,
  run: {
    id: string;
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
    purpose?: BenchmarkRunPurpose;
  },
  models: RunModelRow[],
  carriedSummaries: BenchmarkModelSummary[]
): Promise<void> {
  const orm = drizzle(db);
  const insertRunStmt = orm.insert(benchmarkRuns).values({
    id: run.id,
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
    purpose: run.purpose ?? 'platform',
  });

  if (models.length === 0 && carriedSummaries.length === 0) {
    await insertRunStmt;
    return;
  }

  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [insertRunStmt];

  if (models.length > 0) {
    for (let i = 0; i < models.length; i += RUN_MODEL_INSERT_BATCH_SIZE) {
      stmts.push(orm.insert(runModels).values(models.slice(i, i + RUN_MODEL_INSERT_BATCH_SIZE)));
    }
  }

  for (let i = 0; i < carriedSummaries.length; i += MODEL_SUMMARY_INSERT_BATCH_SIZE) {
    const summaryChunk = carriedSummaries.slice(i, i + MODEL_SUMMARY_INSERT_BATCH_SIZE);
    stmts.push(
      orm.insert(modelSummaries).values(
        summaryChunk.map(s => ({
          run_id: run.id,
          model: s.model,
          variant: variantToStorage(s.variant),
          route_key: s.routeKey,
          accuracy: s.accuracy,
          avg_cost_usd: s.avgCostUsd,
          avg_latency_ms: s.avgLatencyMs,
          p50_latency_ms: s.p50LatencyMs,
          p95_latency_ms: s.p95LatencyMs,
          cases: s.cases,
          errors: s.errors,
          timeouts: s.timeouts,
          carried: true,
        }))
      )
    );
  }

  await orm.batch(stmts);
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

// ---------------------------------------------------------------------------
// Case results
// ---------------------------------------------------------------------------

export async function upsertCaseResult(db: D1Database, row: CaseResultRow): Promise<void> {
  await drizzle(db)
    .insert(caseResults)
    .values(row)
    .onConflictDoUpdate({
      target: [
        caseResults.run_id,
        caseResults.model,
        caseResults.variant,
        caseResults.case_id,
        caseResults.rep,
      ],
      set: {
        route_key: row.route_key,
        score: row.score,
        latency_ms: row.latency_ms,
        cost_usd: row.cost_usd,
        error: row.error,
        fallback_reason: row.fallback_reason,
        retried: row.retried,
        exit_code: row.exit_code,
        output_prefix: row.output_prefix,
        event_count: row.event_count,
        last_event_types: row.last_event_types,
        rep: row.rep,
        timed_out: row.timed_out,
      },
    });
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

// ---------------------------------------------------------------------------
// Model summaries
// ---------------------------------------------------------------------------

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
          avg_latency_ms: s.avgLatencyMs,
          p50_latency_ms: s.p50LatencyMs,
          p95_latency_ms: s.p95LatencyMs,
          cases: s.cases,
          errors: s.errors,
          timeouts: s.timeouts,
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

export async function listRuns(
  db: D1Database,
  limit: number,
  // Classifier, platform-decider and profile-decider runs interleave in one
  // table and profile runs are by far the most frequent, so the admin list
  // filters server-side instead of slicing a mixed page client-side.
  filter: { kind?: BenchmarkKind; purpose?: BenchmarkRunPurpose } = {}
): Promise<BenchmarkRun[]> {
  const orm = drizzle(db);
  const runRows = await orm
    .select()
    .from(benchmarkRuns)
    .where(
      and(
        filter.kind ? eq(benchmarkRuns.kind, filter.kind) : undefined,
        filter.purpose ? eq(benchmarkRuns.purpose, filter.purpose) : undefined
      )
    )
    .orderBy(desc(benchmarkRuns.started_at))
    .limit(limit);

  if (runRows.length === 0) {
    return [];
  }

  const summaryRows = await orm
    .select()
    .from(modelSummaries)
    .where(
      inArray(
        modelSummaries.run_id,
        runRows.map(r => r.id)
      )
    );

  const summariesByRunId = new Map<string, BenchmarkModelSummary[]>();
  for (const row of summaryRows) {
    const existing = summariesByRunId.get(row.run_id);
    if (existing) {
      existing.push(mapSummaryRow(row));
    } else {
      summariesByRunId.set(row.run_id, [mapSummaryRow(row)]);
    }
  }

  return runRows.map(row => mapRunRow(row, summariesByRunId.get(row.id) ?? []));
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
    .where(and(eq(benchmarkRuns.status, 'running'), lt(benchmarkRuns.started_at, olderThanIso)));
}

// The currently-running run of a (kind, purpose), if any (used for the
// one-active-run-per-slot admission pre-check). Platform and profile hold
// independent slots. Stale runs are swept to 'failed' before this is consulted.
export async function getRunningRun(
  db: D1Database,
  kind: BenchmarkKind,
  purpose: BenchmarkRunPurpose
): Promise<RunRow | undefined> {
  return drizzle(db)
    .select()
    .from(benchmarkRuns)
    .where(
      and(
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
  runId: string
): Promise<boolean> {
  const newer = await drizzle(db)
    .select({ id: benchmarkRuns.id })
    .from(benchmarkRuns)
    .where(
      and(
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

function boundProfileFailureReason(reason: string): string {
  if (reason.length <= BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH) return reason;
  return reason.slice(0, BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH);
}

/**
 * Mark Benchmark-profile rows claimed by this run as running. Only touches rows
 * still pending (or already running for this run_id) under the exact PK — never
 * clobbers ready/failed or a different run's claim.
 */
export async function markProfilesRunningForRun(
  db: D1Database,
  runId: string,
  entries: readonly PoolEntry[],
  current: { engineIdentity: string; repetitions: number },
  nowIso: string = new Date().toISOString()
): Promise<PoolEntry[]> {
  if (entries.length === 0) return [];
  const orm = drizzle(db);
  // Returns the entries this run actually claimed. An entry already claimed by
  // the other queue's run updates 0 rows and is dropped, so the pair is
  // measured once instead of being benchmarked (and billed) twice.
  const claimed: PoolEntry[] = [];
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
          eq(benchmarkProfiles.engine_identity, current.engineIdentity),
          eq(benchmarkProfiles.repetitions, current.repetitions),
          or(
            eq(benchmarkProfiles.status, 'pending'),
            and(eq(benchmarkProfiles.status, 'running'), eq(benchmarkProfiles.run_id, runId))
          )
        )
      );
    if ((result.meta.changes ?? 0) > 0) claimed.push(entry);
  }
  return claimed;
}

/**
 * Production UPDATE for ready transition. Exported for honest SQLite tests of
 * the run_id + status='running' no-clobber guard.
 */
export function markProfilesReadyForRunStatement(
  orm: ReturnType<typeof drizzle>,
  runId: string,
  nowIso: string
) {
  return orm
    .update(benchmarkProfiles)
    .set({
      status: 'ready',
      failure_reason: null,
      updated_at: nowIso,
      completed_at: nowIso,
    })
    .where(and(eq(benchmarkProfiles.run_id, runId), eq(benchmarkProfiles.status, 'running')));
}

/**
 * Transition profiles claimed by this run to ready. Only rows still pointing at
 * this run_id and still running are updated — never a newer pending/ready row.
 */
export async function markProfilesReadyForRun(
  db: D1Database,
  runId: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  await markProfilesReadyForRunStatement(drizzle(db), runId, nowIso);
}

/**
 * Production UPDATE for failed transition. Exported for honest SQLite tests of
 * the run_id + status='running' no-clobber guard.
 */
export function markProfilesFailedForRunStatement(
  orm: ReturnType<typeof drizzle>,
  runId: string,
  failureReason: string,
  nowIso: string
) {
  return orm
    .update(benchmarkProfiles)
    .set({
      status: 'failed',
      failure_reason: boundProfileFailureReason(failureReason),
      updated_at: nowIso,
      completed_at: nowIso,
    })
    .where(and(eq(benchmarkProfiles.run_id, runId), eq(benchmarkProfiles.status, 'running')));
}

/**
 * Transition profiles claimed by this run to failed with a bounded reason.
 * Only rows still pointing at this run_id and still running are updated.
 */
export async function markProfilesFailedForRun(
  db: D1Database,
  runId: string,
  failureReason: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  await markProfilesFailedForRunStatement(drizzle(db), runId, failureReason, nowIso);
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
  failureReason: string,
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
    .set({
      status: 'failed',
      failure_reason: boundProfileFailureReason(failureReason),
      updated_at: nowIso,
      completed_at: nowIso,
    })
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
  failureReason: string,
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
      failureReason,
      nowIso
    );
  }
}

// ---------------------------------------------------------------------------
// Lane failures (dead-lettered queue messages)
// ---------------------------------------------------------------------------

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
    })
    .onConflictDoNothing();
}

/** Record that a run's lane chunk dead-lettered. Variant in storage form. */
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
 */
export async function listPendingCurrentProfiles(
  db: D1Database,
  current: { engineIdentity: string; repetitions: number },
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
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
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

/** Registry row counts per status for one queue's current-engine rows. */
export async function countCurrentProfilesByStatus(
  db: D1Database,
  current: { engineIdentity: string; repetitions: number },
  queue: BenchmarkRunPurpose
): Promise<Array<{ status: BenchmarkProfileStatus; count: number }>> {
  const rows = await drizzle(db)
    .select({ status: benchmarkProfiles.status, n: count() })
    .from(benchmarkProfiles)
    .where(
      and(
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        queue === 'platform'
          ? eq(benchmarkProfiles.platform_requested, true)
          : eq(benchmarkProfiles.user_requested, true)
      )
    )
    .groupBy(benchmarkProfiles.status);
  return rows.map(row => ({ status: row.status, count: row.n }));
}

/**
 * Admin requeue: put failed current-engine rows of a queue back to `pending`.
 * Charges no owner quota — this is the admin's own escape hatch, distinct from
 * an owner's Retry. Returns how many rows moved.
 */
export async function requeueFailedCurrentProfiles(
  db: D1Database,
  current: { engineIdentity: string; repetitions: number },
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
      requested_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
    })
    .where(
      and(
        eq(benchmarkProfiles.status, 'failed'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        queueFilter
      )
    );
  return result.meta.changes ?? 0;
}

/**
 * Reconcile the platform queue with the saved decider model list: every desired
 * exact pair gets a current-engine registry row flagged platform_requested, and
 * pairs that left the list lose the flag. Existing measurements are never
 * discarded — a `ready` row only gains the flag, so a pair already measured for
 * an owner pool is reused by the platform table instead of re-benchmarked.
 */
export async function syncPlatformRegistryRows(
  db: D1Database,
  current: { engineIdentity: string; repetitions: number },
  desired: readonly { model: string; variant: string | null }[],
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const orm = drizzle(db);

  // Clear every flag first, then re-set it per desired pair. Naming the desired
  // set in one NOT(...) clause instead would bind two variables per model and
  // blow D1's bound-variable ceiling once the decider list passes ~47 entries.
  // Both statements run in one batch, so no drain sees a half-cleared queue.
  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    clearPlatformRequestedStatement(orm, current),
  ];

  for (const entry of desired) {
    stmts.push(claimPlatformRequestedStatement(orm, entry, current, nowIso) as BatchItem<'sqlite'>);
  }

  await orm.batch(stmts);
}

/**
 * Claim `platform_requested` for one desired pair, creating the row as pending
 * when it does not exist yet. Exported for the reconcile-vs-reaper test.
 */
export function claimPlatformRequestedStatement(
  orm: ReturnType<typeof drizzle>,
  entry: { model: string; variant: string | null },
  current: { engineIdentity: string; repetitions: number },
  nowIso: string
) {
  return (
    orm
      .insert(benchmarkProfiles)
      .values({
        model: entry.model,
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
        // would keep the queue unsettled forever.
        set: { platform_requested: true },
      })
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
  current: { engineIdentity: string; repetitions: number }
) {
  return orm
    .update(benchmarkProfiles)
    .set({ platform_requested: false })
    .where(
      and(
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
  current: { engineIdentity: string; repetitions: number },
  entries: readonly PoolEntry[]
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
 * they stay claimed forever, and because a claimed platform row keeps the queue
 * unsettled, the platform routing table would never publish again.
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
    .set({
      status: 'failed',
      failure_reason: boundProfileFailureReason(failureReason),
      updated_at: nowIso,
      completed_at: nowIso,
    })
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
  const result = await failOrphanedRunningProfilesStatement(
    drizzle(db),
    failureReason,
    olderThanIso,
    nowIso
  );
  return result.meta.changes ?? 0;
}

/** Release rows this run claimed back to `pending` (claim made, run never written). */
export async function releaseProfileClaims(db: D1Database, runId: string): Promise<void> {
  await drizzle(db)
    .update(benchmarkProfiles)
    .set({ status: 'pending', run_id: null, updated_at: new Date().toISOString() })
    .where(and(eq(benchmarkProfiles.run_id, runId), eq(benchmarkProfiles.status, 'running')));
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
        lt(benchmarkRuns.started_at, olderThanIso)
      )
    );
  return rows.map(r => ({ id: r.id, purpose: r.purpose === 'user' ? 'user' : 'platform' }));
}

// ---------------------------------------------------------------------------
// Latest summaries per model (for skip logic and classifier winner)
// ---------------------------------------------------------------------------

// What the most recent completed run measured for an exact Pool entry, plus
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
 * poolEntryKey contract helper so keys stay collision-safe.
 */
export function exactPairKey(model: string, variant: string | null | undefined): string {
  return poolEntryKey({ model, variant: variant ?? null });
}

// Latest summaries per exact Pool entry for a benchmark kind: for each
// (model, variant), all routes from the most recent COMPLETED run that
// included that pair (mixing routes across runs would pair incomparable numbers).
export async function getLatestSummariesByModel(
  db: D1Database,
  kind: BenchmarkKind
): Promise<Map<string, PriorModelResult>> {
  const results = await drizzle(db)
    .select({
      run_id: modelSummaries.run_id,
      model: modelSummaries.model,
      variant: modelSummaries.variant,
      route_key: modelSummaries.route_key,
      accuracy: modelSummaries.accuracy,
      avg_cost_usd: modelSummaries.avg_cost_usd,
      avg_latency_ms: modelSummaries.avg_latency_ms,
      p50_latency_ms: modelSummaries.p50_latency_ms,
      p95_latency_ms: modelSummaries.p95_latency_ms,
      cases: modelSummaries.cases,
      errors: modelSummaries.errors,
      timeouts: modelSummaries.timeouts,
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
    .where(and(eq(benchmarkRuns.kind, kind), eq(benchmarkRuns.status, 'completed')))
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

// ---------------------------------------------------------------------------
// Routing table — pure helpers for explode/reassemble
// ---------------------------------------------------------------------------

type RoutingTableRow = typeof routingTables.$inferSelect;
type RoutingTableCandidateRow = typeof routingTableCandidates.$inferSelect;

export function routingTableToRows(
  table: RoutingTable,
  publishedAt: string
): { tableRow: RoutingTableRow; candidateRows: RoutingTableCandidateRow[] } {
  const tableRow: RoutingTableRow = {
    run_id: table.version,
    published_at: publishedAt,
    generated_at: table.generatedAt,
    min_accuracy: table.minAccuracy,
    switch_cost_factor: table.switchCostFactor,
    best_accuracy_switch_threshold: table.bestAccuracySwitchThreshold,
    source: table.source,
  };

  const candidateRows: RoutingTableCandidateRow[] = [];
  for (const [routeKey, candidates] of Object.entries(table.routes)) {
    candidates.forEach((c, rank) => {
      // Platform tables emit reasoningEffort only; mirror that effort key into
      // the self-describing variant column ('' when null). Custom sparse tables
      // (later slice) will emit variant and leave reasoning_effort null.
      const effortKey = c.reasoningEffort ?? null;
      const variantKey = c.variant ?? effortKey;
      candidateRows.push({
        run_id: table.version,
        route_key: routeKey,
        rank,
        model: c.model,
        accuracy: c.accuracy,
        avg_cost_usd: c.avgCostUsd,
        meets_threshold: c.meetsThreshold,
        reasoning_effort: effortKey,
        variant: variantToStorage(variantKey),
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
    // Platform artifact compatibility: a row with a reasoning_effort keeps the
    // exact current read shape. A variant-only row (non-enum key) returns variant.
    const effort = parsePersistedReasoningEffort(row.reasoning_effort);
    const variant = effort === null ? variantFromStorage(row.variant) : null;
    routeMap[row.route_key].push({
      model: row.model,
      accuracy: row.accuracy,
      avgCostUsd: row.avg_cost_usd,
      meetsThreshold: row.meets_threshold,
      ...(variant !== null ? { variant } : {}),
      reasoningEffort: effort,
    });
  }
  return {
    version: tableRow.run_id,
    generatedAt: tableRow.generated_at,
    minAccuracy: tableRow.min_accuracy,
    switchCostFactor: tableRow.switch_cost_factor,
    bestAccuracySwitchThreshold: tableRow.best_accuracy_switch_threshold,
    source: tableRow.source as RoutingTable['source'],
    routes: routeMap,
  };
}

export async function saveRoutingTable(
  db: D1Database,
  table: RoutingTable,
  publishedAt: string
): Promise<void> {
  const orm = drizzle(db);
  const { tableRow, candidateRows } = routingTableToRows(table, publishedAt);

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
          switch_cost_factor: tableRow.switch_cost_factor,
          best_accuracy_switch_threshold: tableRow.best_accuracy_switch_threshold,
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

export async function getLatestRoutingTable(
  db: D1Database
): Promise<{ table: RoutingTable; publishedAt: string } | null> {
  const orm = drizzle(db);
  const tableRow = await orm
    .select()
    .from(routingTables)
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

  return { table: parsed.data, publishedAt: tableRow.published_at };
}

// ---------------------------------------------------------------------------
// Classifier winner
// ---------------------------------------------------------------------------

export async function getClassifierWinner(db: D1Database): Promise<ClassifierWinner | null> {
  const orm = drizzle(db);
  // Find the latest completed classifier run.
  const runRow = await orm
    .select()
    .from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.kind, 'classifier'), eq(benchmarkRuns.status, 'completed')))
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
    model: winner.model,
    runId: runRow.id,
    accuracy: winner.accuracy,
    p95LatencyMs: winner.p95LatencyMs,
    generatedAt: runRow.completed_at ?? new Date().toISOString(),
  };
}
