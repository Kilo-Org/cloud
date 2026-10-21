import type { AutoRouter, BenchmarkPair } from '@kilocode/auto-routing-contracts';
import { getReasoningVariantKeys } from '@kilocode/auto-routing-contracts';
import type { z } from 'zod';
import { isExactModelUnavailableResult } from './cli-runner';
import type { BenchmarkModelCatalogSchema } from './platform-models';
import { variantFromStorage, variantToStorage } from './reasoning-effort';

type RefreshInput = {
  router: AutoRouter;
  engineIdentity: string;
  repetitions: number;
  entries: readonly BenchmarkPair[];
  mode: 'refresh' | 'repair_unavailable';
};

type RefreshedRow = { model: string; variant: string; status: 'pending' | 'failed' };

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
): Promise<{ refreshed: BenchmarkPair[]; unavailable: BenchmarkPair[]; skipped: BenchmarkPair[] }> {
  const models = new Map(catalog.data.map(model => [model.id, model]));
  const entries = input.entries.map(entry => {
    const model = models.get(entry.model);
    const variants = getReasoningVariantKeys(model?.opencode?.variants);
    return {
      model: entry.model,
      variant: variantToStorage(entry.variant),
      available:
        Boolean(model) &&
        (variants.length > 0 ? variants.includes(entry.variant ?? '') : entry.variant === null),
    };
  });
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
  const availableSql = `SELECT json_extract(requested.value, '$.available')
    FROM json_each(?4) AS requested
    WHERE json_extract(requested.value, '$.model') = benchmark_profiles.model
      AND json_extract(requested.value, '$.variant') = benchmark_profiles.variant`;
  const result = await db
    .prepare(`UPDATE benchmark_profiles SET
      status = CASE WHEN (${availableSql}) THEN 'pending' ELSE 'failed' END,
      failure_reason = CASE WHEN (${availableSql}) THEN NULL
        ELSE 'Model or variant is unavailable to the benchmark CLI.' END,
      run_id = NULL, requested_at = ?5, updated_at = ?5, completed_at = NULL,
      invalidated_at = ?5
    WHERE router = ?1 AND engine_identity = ?2 AND repetitions = ?3
      AND EXISTS (${availableSql}) AND status != 'running'
      AND NOT EXISTS (${runningSql})
      AND (?6 = 'refresh' OR EXISTS (
        SELECT 1 FROM json_each(?7) AS repairable
        WHERE json_extract(repairable.value, '$.run_id') = benchmark_profiles.run_id
          AND json_extract(repairable.value, '$.model') = benchmark_profiles.model
          AND json_extract(repairable.value, '$.variant') = benchmark_profiles.variant
      ))
    RETURNING model, variant, status`)
    .bind(...bindings, nowIso, input.mode, JSON.stringify(repairable))
    .all<RefreshedRow>();
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
  for (const row of result.results) {
    const pair = { model: row.model, variant: variantFromStorage(row.variant) };
    if (row.status === 'pending') refreshed.push(pair);
    else unavailable.push(pair);
  }
  return {
    refreshed,
    unavailable,
    skipped: input.entries.filter(
      entry => !changed.has(JSON.stringify([entry.model, variantToStorage(entry.variant)]))
    ),
  };
}
