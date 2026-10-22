import type {
  AutoRouter,
  BenchmarkKind,
  BenchmarkModelSummary,
  BenchmarkProfileStatus,
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
import { BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH } from '@kilocode/auto-routing-contracts';
import type { BatchItem } from 'drizzle-orm/batch';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
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
import { PROMPT_TRANSPORT_REVISION } from './prompt-transport';

export type CaseResultRow = typeof caseResults.$inferSelect;
export type RunRow = typeof benchmarkRuns.$inferSelect;
export type RunModelRow = typeof runModels.$inferSelect;
export type ConfigDeciderModelRow = Omit<typeof configDeciderModels.$inferSelect, 'router'> & {
  router?: AutoRouter;
};
type ModelSummaryRow = typeof modelSummaries.$inferSelect;

// D1 rejects statements with too many bound variables. A model summary insert
// binds 14 values per row (including variant), so 7 rows keeps each INSERT
// below the 100-variable ceiling while still batching the delete plus inserts.
const MODEL_SUMMARY_INSERT_BATCH_SIZE = 7;

const ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE = 8;

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

export function mapRunRow(row: RunRow, summaries: BenchmarkModelSummary[]): BenchmarkRun {
  return {
    id: row.id,
    router: row.router ?? 'efficient',
    kind: row.kind,
    purpose: row.purpose === 'user' ? 'user' : 'platform',
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    summaries,
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

export async function replaceConfig(
  db: D1Database,
  config: {
    min_accuracy: number;
    accuracy_noise_band?: number;
    frontier_min_accuracy_delta?: number;
    switch_cost_factor: number;
    best_accuracy_switch_threshold: number;
    production_token_profile?: ProductionTokenProfile | null;
    switch_horizon_turns?: number | null;
    low_confidence_threshold?: number | null;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    classifier_repetitions: number;
    decider_repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    policy_overrides?: PolicySettingOverrides | null;
    updated_at: string;
    updated_by: string | null;
  },
  classifierModels: string[],
  deciderModels: ConfigDeciderModelRow[],
  router: AutoRouter = 'efficient'
): Promise<void> {
  const orm = drizzle(db);
  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm
      .insert(benchmarkConfig)
      .values({
        id: router === 'efficient' ? 1 : 2,
        ...config,
        ...ROLLBACK_SAFE_LEGACY_LANE_BUDGETS,
        router,
      })
      .onConflictDoUpdate({
        target: benchmarkConfig.router,
        set: { ...config, ...ROLLBACK_SAFE_LEGACY_LANE_BUDGETS },
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
    purpose?: BenchmarkRunPurpose;
  },
  models: RunModelRow[],
  carriedSummaries: BenchmarkModelSummary[]
): Promise<void> {
  const orm = drizzle(db);
  const insertRunStmt = orm.insert(benchmarkRuns).values({
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
          route_accuracy: s.routeAccuracy,
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

export async function upsertCaseResult(db: D1Database, row: CaseResultRow): Promise<void> {
  const orm = drizzle(db);
  const upsert = orm
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
        route_hit: row.route_hit,
        retried: row.retried,
        exit_code: row.exit_code,
        output_prefix: row.output_prefix,
        event_count: row.event_count,
        last_event_types: row.last_event_types,
        rep: row.rep,
        timed_out: row.timed_out,
        prompt_revision: row.prompt_revision,
      },
    });
  await orm.batch([
    upsert,
    orm.delete(pendingDeciderOutputs).where(pendingDeciderOutputPredicate(row)),
  ]);
}

/**
 * Copy each pair's newest compatible graded case (and recoverable pending output) from
 * earlier runs into this run. A result for one of `skipOldCaseIds` measured under an
 * older prompt transport is never copied, so those cases run again.
 */
export async function reuseDeciderCaseResults(
  db: D1Database,
  params: {
    runId: string;
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    entries: readonly BenchmarkPair[];
    skipOldCaseIds: readonly string[];
    promptRevision: number;
  }
): Promise<number> {
  const skipCaseIds = JSON.stringify(params.skipOldCaseIds);
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
        params.promptRevision,
        skipCaseIds,
        params.runId,
      ];
      statements.push(
        db
          .prepare(`
          WITH ranked AS (
            SELECT source.*,
              ROW_NUMBER() OVER (
                PARTITION BY source.case_id, source.rep
                ORDER BY run.started_at DESC, run.id DESC
              ) AS reuse_rank
            FROM case_results AS source
            JOIN benchmark_runs AS run ON run.id = source.run_id
            WHERE run.kind = 'decider' AND run.status IN ('completed', 'failed')
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
              AND NOT (source.prompt_revision < ?
                AND source.case_id IN (SELECT value FROM json_each(?)))
          )
          INSERT INTO case_results (
            run_id, model, variant, case_id, route_key, score, latency_ms, cost_usd,
            error, fallback_reason, route_hit, retried, exit_code, output_prefix,
            event_count, last_event_types, rep, timed_out, prompt_revision
          )
          SELECT ?, model, variant, case_id, route_key, score, latency_ms, cost_usd,
            error, fallback_reason, route_hit, retried, exit_code, output_prefix,
            event_count, last_event_types, rep, timed_out, prompt_revision
          FROM ranked WHERE reuse_rank = 1
          ON CONFLICT (run_id, model, variant, case_id, rep) DO NOTHING
        `)
          .bind(...bindings),
        db
          .prepare(`
          WITH ranked AS (
            SELECT source.*,
              ROW_NUMBER() OVER (
                PARTITION BY source.case_id, source.rep
                ORDER BY run.started_at DESC, run.id DESC
              ) AS reuse_rank
            FROM pending_decider_outputs AS source
            JOIN benchmark_runs AS run ON run.id = source.run_id
            WHERE run.kind = 'decider' AND run.status IN ('completed', 'failed')
              AND run.router = ? AND run.engine_identity = ? AND run.repetitions = ?
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
              AND NOT (source.prompt_revision < ?
                AND source.case_id IN (SELECT value FROM json_each(?)))
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
        `)
          .bind(...bindings, params.runId),
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
    latencyMs: z.number(),
    exitCode: z.number(),
    stderrTail: z.string(),
    eventCount: z.number(),
    lastEventTypes: z.array(z.string()),
    timedOut: z.boolean(),
    unavailableModelId: z.string().min(1).optional(),
  }),
  retried: z.boolean(),
  // From the row's prompt_revision column; absent when the output is about to be saved by
  // this worker, which uses PROMPT_TRANSPORT_REVISION.
  promptRevision: z.number().int().optional(),
  attemptStartedAt: z.number().int().nonnegative().optional(),
});

export type PendingDeciderOutput = z.infer<typeof PendingDeciderOutputSchema>;

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
): Promise<PendingDeciderOutput | null> {
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
  output: PendingDeciderOutput,
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
      promptRevision ?? PROMPT_TRANSPORT_REVISION,
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
          avg_latency_ms: s.avgLatencyMs,
          p50_latency_ms: s.p50LatencyMs,
          p95_latency_ms: s.p95LatencyMs,
          cases: s.cases,
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

export async function listRuns(
  db: D1Database,
  limit: number,
  // Classifier, platform-decider and profile-decider runs interleave in one
  // table and profile runs are by far the most frequent, so the admin list
  // filters server-side instead of slicing a mixed page client-side.
  filter: { router?: AutoRouter; kind?: BenchmarkKind; purpose?: BenchmarkRunPurpose } = {}
): Promise<BenchmarkRun[]> {
  const orm = drizzle(db);
  const runRows = await orm
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

export type RunProgressCountRow = {
  runId: string;
  kind: BenchmarkKind;
  router: AutoRouter;
  repetitions: number;
  engineIdentity: string;
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
    enqueuedModels: Number(row.enqueuedModels),
    completedCases: Number(row.completedCases),
    failedCases: Number(row.failedCases),
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

// The currently-running run of a (kind, purpose), if any (used for the
// one-active-run-per-slot admission pre-check). Platform and profile hold
// independent slots. Stale runs are swept to 'failed' before this is consulted.
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

function boundProfileFailureReason(reason: string): string {
  if (reason.length <= BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH) return reason;
  return reason.slice(0, BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH);
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
  // the other queue's run updates 0 rows and is dropped, so the pair is
  // measured once instead of being benchmarked (and billed) twice.
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
 * Copy every result of each claimed re-measure's previous run into this run, except the
 * `skipOldCaseIds` results measured under an older prompt transport. Failed and timed-out
 * results are copied too: only the skipped cases run again.
 */
export async function copyRemeasureBaselines(
  db: D1Database,
  params: { runId: string; skipOldCaseIds: readonly string[]; promptRevision: number }
): Promise<number> {
  const result = await db
    .prepare(`
      INSERT INTO case_results (
        run_id, model, variant, case_id, route_key, score, latency_ms, cost_usd,
        error, fallback_reason, route_hit, retried, exit_code, output_prefix,
        event_count, last_event_types, rep, timed_out, prompt_revision
      )
      SELECT r.run_id, source.model, source.variant, source.case_id, source.route_key,
        source.score, source.latency_ms, source.cost_usd, source.error, source.fallback_reason,
        source.route_hit, source.retried, source.exit_code, source.output_prefix,
        source.event_count, source.last_event_types, source.rep, source.timed_out,
        source.prompt_revision
      FROM profile_remeasures AS r
      JOIN benchmark_profiles AS p ON p.router = r.router AND p.model = r.model
        AND p.variant = r.variant AND p.engine_identity = r.engine_identity
        AND p.repetitions = r.repetitions AND p.status = 'ready'
      JOIN case_results AS source ON source.run_id = p.run_id
        AND source.model = p.model AND source.variant = p.variant
      WHERE r.run_id = ?
        AND NOT (source.prompt_revision < ?
          AND source.case_id IN (SELECT value FROM json_each(?)))
      ON CONFLICT (run_id, model, variant, case_id, rep) DO NOTHING
    `)
    .bind(params.runId, params.promptRevision, JSON.stringify(params.skipOldCaseIds))
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Settle this run's re-measures: an entry with a dead lane is dropped and keeps its
 * previous measurement; every other claimed profile moves its provenance to this run,
 * which now holds its full result set. Status stays `ready` throughout.
 */
export async function settleRemeasuresForRun(
  db: D1Database,
  runId: string,
  /** Storage-form variant keys ('' = default variant). */
  failedEntries: readonly { model: string; variant: string }[],
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const orm = drizzle(db);
  const statements: BatchItem<'sqlite'>[] = failedEntries.map(entry =>
    orm
      .delete(profileRemeasures)
      .where(
        and(
          eq(profileRemeasures.run_id, runId),
          eq(profileRemeasures.model, entry.model),
          eq(profileRemeasures.variant, entry.variant)
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
    orm.delete(profileRemeasures).where(eq(profileRemeasures.run_id, runId))
  );
  await orm.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
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
 * Transition profiles claimed by this run to failed with a bounded reason. Only rows
 * still pointing at this run_id and still running are updated. This run's re-measure
 * claims are dropped; those profiles keep serving their previous measurement.
 */
export async function markProfilesFailedForRun(
  db: D1Database,
  runId: string,
  failureReason: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const orm = drizzle(db);
  await orm.batch([
    markProfilesFailedForRunStatement(orm, runId, failureReason, nowIso),
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
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
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
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
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

/** Registry row counts per status for one queue's current-engine rows. */
export async function countCurrentProfilesByStatus(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
  queue: BenchmarkRunPurpose
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
          : eq(benchmarkProfiles.user_requested, true)
      )
    )
    .groupBy(benchmarkProfiles.status);
  return rows.map(row => ({ status: row.status, count: row.n }));
}

/** Exact platform-pair coverage for the currently measured engine and repetitions. */
export async function listCurrentPlatformProfileStatuses(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number }
): Promise<Array<{ model: string; variant: string | null; status: BenchmarkProfileStatus }>> {
  const rows = await drizzle(db)
    .select({
      model: benchmarkProfiles.model,
      variant: benchmarkProfiles.variant,
      status: benchmarkProfiles.status,
    })
    .from(benchmarkProfiles)
    .where(
      and(
        eq(benchmarkProfiles.router, current.router ?? 'efficient'),
        eq(benchmarkProfiles.engine_identity, current.engineIdentity),
        eq(benchmarkProfiles.repetitions, current.repetitions),
        eq(benchmarkProfiles.platform_requested, true)
      )
    )
    .orderBy(asc(benchmarkProfiles.model), asc(benchmarkProfiles.variant));
  return rows.map(row => ({ ...row, variant: variantFromStorage(row.variant) }));
}

/**
 * Admin requeue: put failed current-engine rows of a queue back to `pending`.
 * Charges no owner quota — this is the admin's own escape hatch, distinct from
 * an owner's Retry. Returns how many rows moved.
 */
export async function requeueFailedCurrentProfiles(
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
      requested_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
    })
    .where(
      and(
        eq(benchmarkProfiles.status, 'failed'),
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
 * Reconcile the platform queue with the saved decider model list: every desired
 * exact pair gets a current-engine registry row flagged platform_requested, and
 * pairs that left the list lose the flag. Existing measurements are never
 * discarded — a `ready` row only gains the flag, so a pair already measured for
 * an owner pool is reused by the platform table instead of re-benchmarked.
 */
export async function syncPlatformRegistryRows(
  db: D1Database,
  current: { router?: AutoRouter; engineIdentity: string; repetitions: number },
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
    stmts.push(claimPlatformRequestedStatement(orm, entry, current, nowIso));
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
      avg_latency_ms: modelSummaries.avg_latency_ms,
      p50_latency_ms: modelSummaries.p50_latency_ms,
      p95_latency_ms: modelSummaries.p95_latency_ms,
      cases: modelSummaries.cases,
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
  router: AutoRouter = 'efficient'
): { tableRow: RoutingTableRow; candidateRows: RoutingTableCandidateRow[] } {
  const tableRow: RoutingTableRow = {
    run_id: table.version,
    router,
    published_at: publishedAt,
    generated_at: table.generatedAt,
    min_accuracy: table.minAccuracy,
    switch_cost_factor: table.switchCostFactor,
    best_accuracy_switch_threshold: table.bestAccuracySwitchThreshold,
    production_token_profile: table.productionTokenProfile ?? null,
    switch_horizon_turns: table.switchHorizonTurns ?? null,
    low_confidence_threshold: table.lowConfidenceThreshold ?? null,
    effort_by_complexity: table.effortByComplexity ?? null,
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
  router: AutoRouter = 'efficient'
): Promise<void> {
  const orm = drizzle(db);
  const { tableRow, candidateRows } = routingTableToRows(table, publishedAt, router);

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
          production_token_profile: tableRow.production_token_profile,
          switch_horizon_turns: tableRow.switch_horizon_turns,
          low_confidence_threshold: tableRow.low_confidence_threshold,
          effort_by_complexity: tableRow.effort_by_complexity,
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
  db: D1Database,
  router: AutoRouter = 'efficient'
): Promise<{ table: RoutingTable; publishedAt: string } | null> {
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

  return { table: parsed.data, publishedAt: tableRow.published_at };
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
