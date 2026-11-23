import type {
  AutoRouter,
  BenchmarkPair,
  RefreshBenchmarkProfilesResponse,
} from '@kilocode/auto-routing-contracts';
import type { z } from 'zod';
import { isExactModelUnavailableResult } from './cli-runner';
import { benchmarkPairUnavailability, type BenchmarkModelCatalogSchema } from './platform-models';
import { profileAdmissionResetStatement } from './profile-failure-history';
import { variantFromStorage, variantToStorage } from './reasoning-effort';

type RefreshInput = {
  router: AutoRouter;
  engineIdentity: string;
  repetitions: number;
  entries: readonly BenchmarkPair[];
  mode: 'refresh' | 'repair_unavailable';
};

type RefreshedRow = {
  model: string;
  variant: string;
  status: 'pending' | 'failed' | 'unavailable';
};

type RecordedLookupResult = {
  run_id: string;
  model: string;
  variant: string;
  error: string;
  output_prefix: string | null;
  cost_usd: number | null;
  timed_out: number;
};

export class ProfileRefreshConflictError extends Error {
  constructor() {
    super('Selected profiles are running. Wait for them to finish before refreshing.');
    this.name = 'ProfileRefreshConflictError';
  }
}

export async function refreshCurrentProfiles(
  db: D1Database,
  input: RefreshInput,
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>,
  nowIso = new Date().toISOString()
): Promise<RefreshBenchmarkProfilesResponse> {
  const checked = input.entries.map(entry => ({
    entry,
    failure: benchmarkPairUnavailability(catalog, entry),
  }));
  const failureByPair = new Map(
    checked.map(({ entry, failure }) => [
      JSON.stringify([entry.model, variantToStorage(entry.variant)]),
      failure,
    ])
  );
  const entries = checked.map(({ entry, failure }) => ({
    model: entry.model,
    variant: variantToStorage(entry.variant),
    available: failure === null,
    failureClass: failure?.failureClass ?? null,
    failureReason: failure?.reason ?? null,
  }));
  const selection = JSON.stringify(entries);
  const bindings = [input.router, input.engineIdentity, input.repetitions, selection] as const;
  const runningSql = `SELECT 1 FROM benchmark_profiles AS running
    JOIN json_each(?4) AS requested
      ON running.model = json_extract(requested.value, '$.model')
      AND running.variant = json_extract(requested.value, '$.variant')
    WHERE running.router = ?1 AND running.engine_identity = ?2
      AND running.repetitions = ?3 AND (running.status = 'running' OR EXISTS (
        SELECT 1 FROM scheduler_chunks AS chunk
        WHERE chunk.run_id = running.run_id AND chunk.model = running.model
          AND chunk.variant = running.variant AND chunk.status IN ('queued', 'active')
      ))`;
  if (
    await db
      .prepare(runningSql)
      .bind(...bindings)
      .first()
  ) {
    throw new ProfileRefreshConflictError();
  }
  const repairable =
    input.mode === 'repair_unavailable'
      ? (
          await db
            .prepare(`SELECT DISTINCT result.run_id, result.model, result.variant, result.error,
              result.output_prefix, result.cost_usd, result.timed_out
            FROM benchmark_profiles AS profile
            JOIN json_each(?4) AS requested
              ON profile.model = json_extract(requested.value, '$.model')
              AND profile.variant = json_extract(requested.value, '$.variant')
            JOIN case_results AS result
              ON result.run_id = profile.run_id AND result.model = profile.model
              AND result.variant = profile.variant
            WHERE profile.router = ?1 AND profile.engine_identity = ?2
              AND profile.repetitions = ?3 AND result.error IS NOT NULL`)
            .bind(...bindings)
            .all<RecordedLookupResult>()
        ).results
          .filter(row =>
            isExactModelUnavailableResult(
              {
                text: row.output_prefix ?? '',
                stderrTail: row.error,
                costUsd: row.cost_usd,
                timedOut: row.timed_out !== 0,
              },
              row.model
            )
          )
          .map(row => ({ run_id: row.run_id, model: row.model, variant: row.variant }))
      : [];
  const requestedSql = (field: string) => `SELECT json_extract(requested.value, '$.${field}')
    FROM json_each(?4) AS requested
    WHERE json_extract(requested.value, '$.model') = benchmark_profiles.model
      AND json_extract(requested.value, '$.variant') = benchmark_profiles.variant`;
  const availableSql = requestedSql('available');
  const failedSql = `status IN ('failed', 'unavailable')`;
  const selectedSql = `router = ?1 AND engine_identity = ?2 AND repetitions = ?3
      AND EXISTS (${availableSql}) AND status != 'running'
      AND NOT EXISTS (${runningSql})
      AND (?5 = 'refresh' OR EXISTS (
        SELECT 1 FROM json_each(?6) AS repairable
        WHERE json_extract(repairable.value, '$.run_id') = benchmark_profiles.run_id
          AND json_extract(repairable.value, '$.model') = benchmark_profiles.model
          AND json_extract(repairable.value, '$.variant') = benchmark_profiles.variant
      ))`;
  const selectionBindings = [...bindings, input.mode, JSON.stringify(repairable)] as const;
  // A pair the drain could not run is refused. An already failed row is left exactly as it
  // is, so its failure history and its previous results stay; any other row fails
  // permanently with the drain's reason, before any paid call. Re-admitting a runnable pair
  // clears the failure history, so the retry budgets start over.
  const refused = await db
    .prepare(`SELECT model, variant, status FROM benchmark_profiles
      WHERE ${selectedSql} AND NOT (${availableSql}) AND ${failedSql}`)
    .bind(...selectionBindings)
    .all<RefreshedRow>();
  const repairableKeys = new Set(repairable.map(row => JSON.stringify([row.model, row.variant])));
  const readmitted = entries.filter(
    entry =>
      entry.available &&
      (input.mode === 'refresh' || repairableKeys.has(JSON.stringify([entry.model, entry.variant])))
  );
  // A reset marker must commit with the re-admission: the UPDATE's streak read uses the
  // row's pre-update first_failed_at, which this update clears to NULL.
  const resetStatements = readmitted.map(entry =>
    profileAdmissionResetStatement(db, {
      router: input.router,
      model: entry.model,
      variant: entry.variant,
      engineIdentity: input.engineIdentity,
      repetitions: input.repetitions,
      admittedAt: nowIso,
      requestId: `${entry.model}:${entry.variant}`,
    })
  );
  const [updatedResult] = await db.batch([
    db
      .prepare(`UPDATE benchmark_profiles SET
      status = CASE WHEN (${availableSql}) THEN 'pending' ELSE 'unavailable' END,
      failure_reason = CASE WHEN (${availableSql}) THEN NULL ELSE (${requestedSql('failureReason')}) END,
      failure_class = CASE WHEN (${availableSql}) THEN NULL ELSE (${requestedSql('failureClass')}) END,
      failure_attempts = CASE WHEN (${availableSql}) THEN 0 ELSE 1 END,
      model_failure_attempts = 0,
      first_failed_at = CASE WHEN (${availableSql}) THEN NULL ELSE ?7 END,
      retry_after = NULL,
      run_id = NULL,
      completed_at = CASE WHEN (${availableSql}) THEN NULL ELSE ?7 END,
      requested_at = ?7, updated_at = ?7,
      invalidated_at = CASE WHEN ?5 = 'refresh'
        AND status NOT IN ('failed', 'unavailable') THEN ?7 ELSE invalidated_at END
    WHERE ${selectedSql} AND ((${availableSql}) OR NOT ${failedSql})
    RETURNING model, variant, status`)
      .bind(...selectionBindings, nowIso),
    // The failure streak is scope (router, model, effort, engine) across repetition
    // counts, so a re-admission must clear the pair's PERMANENT verdict at every
    // repetition count of this engine. Otherwise a stale permanent verdict on a row the
    // current config no longer selects returns as a veto if the repetition count changes
    // back. Retryable rows are left alone: their window and history still mean what they
    // said, and nothing uses them as a veto. Only available pairs are cleared (a catalog
    // refusal is not a re-admission), and no invalidation stamp is written, so compatible
    // results stay reusable.
    db
      .prepare(`UPDATE benchmark_profiles SET
      status = 'pending', failure_reason = NULL, failure_class = NULL,
      failure_attempts = 0, model_failure_attempts = 0, first_failed_at = NULL,
      retry_after = NULL, run_id = NULL, completed_at = NULL,
      requested_at = ?5, updated_at = ?5
    WHERE router = ?1 AND engine_identity = ?2 AND repetitions <> ?3
      AND status = 'unavailable'
      AND EXISTS (
        SELECT 1 FROM json_each(?4) AS requested
        WHERE json_extract(requested.value, '$.model') = benchmark_profiles.model
          AND json_extract(requested.value, '$.variant') = benchmark_profiles.variant
      )
      AND NOT EXISTS (
        SELECT 1 FROM scheduler_chunks AS chunk
        WHERE chunk.run_id = benchmark_profiles.run_id
          AND chunk.model = benchmark_profiles.model
          AND chunk.variant = benchmark_profiles.variant
          AND chunk.status IN ('queued', 'active')
      )`)
      .bind(
        input.router,
        input.engineIdentity,
        input.repetitions,
        JSON.stringify(readmitted),
        nowIso
      ),
    ...resetStatements,
  ]);
  const updated = { results: (updatedResult?.results ?? []) as RefreshedRow[] };
  const result = { results: [...updated.results, ...refused.results] };
  if (
    result.results.length === 0 &&
    (await db
      .prepare(runningSql)
      .bind(...bindings)
      .first())
  ) {
    throw new ProfileRefreshConflictError();
  }
  const changed = new Set(result.results.map(row => JSON.stringify([row.model, row.variant])));
  const refreshed: BenchmarkPair[] = [];
  const unavailable: BenchmarkPair[] = [];
  const refusals: NonNullable<RefreshBenchmarkProfilesResponse['refusals']> = [];
  for (const row of result.results) {
    const pair = { model: row.model, variant: variantFromStorage(row.variant) };
    const failure = failureByPair.get(JSON.stringify([row.model, row.variant]));
    if (!failure) {
      refreshed.push(pair);
      continue;
    }
    unavailable.push(pair);
    refusals.push({ entry: pair, failureClass: failure.failureClass, reason: failure.reason });
  }
  return {
    refreshed,
    unavailable,
    skipped: input.entries.filter(
      entry => !changed.has(JSON.stringify([entry.model, variantToStorage(entry.variant)]))
    ),
    refusals,
  };
}
