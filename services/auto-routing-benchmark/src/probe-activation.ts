import type { AutoRouter } from '@kilocode/auto-routing-contracts';
import { and, eq, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { PROBE_CASES } from './datasets/probe-cases';
import { ACTIVE_MEASUREMENT_REVISION, PWD_BASE_CASE_ID } from './measurement-revision';
import { benchmarkProfiles, probeActivations, profileRemeasures } from './db-schema';
import { profileFailureResetAssignments } from './profile-failure';
import { noLiveBenchmarkChunks } from './profile-entry-claims';
import { dispatchLockHeld } from './scheduler';

/** One registry pair the activation measures; the variant is in D1 storage form. */
export type ProbeActivationPair = { model: string; variant: string };

export const PROBE_ACTIVATION_ROUTER: AutoRouter = 'efficient';
export const PROBE_ACTIVATION_ENGINE_IDENTITY = 'efficient:v1:6649fed2';
export const PROBE_ACTIVATION_REPETITIONS = 3;
export const PROBE_ACTIVATION_REQUESTED_AT = '2026-11-20T00:00:00.000Z';

/**
 * The cases a revision-3 run of a pair already measured re-runs: the probe cuts and the one
 * decider case whose grading changed, mirrored from `minimumCaseRevisions`.
 */
export const PROBE_ACTIVATION_CASE_IDS: readonly string[] = [
  ...PROBE_CASES.map(benchCase => benchCase.id),
  PWD_BASE_CASE_ID,
];

/**
 * Ready pairs queued in `profile_remeasures` by migration `0035_probe_activation`: a run
 * for one of them reuses every other result and measures only {@link
 * PROBE_ACTIVATION_CASE_IDS} per repetition.
 */
export const PROBE_ACTIVATION_REMEASURE_PAIRS: readonly ProbeActivationPair[] = [
  { model: 'anthropic/claude-haiku-5.5', variant: 'high' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'low' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'max' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'medium' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'none' },
  { model: 'anthropic/claude-haiku-5.5', variant: 'xhigh' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'high' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'low' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'max' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', variant: 'none' },
  { model: 'inclusionai/ling-3.1-flash', variant: 'thinking' },
  { model: 'meta/muse-spark-1.2-contributor', variant: 'high' },
  { model: 'openai/gpt-6-luna', variant: 'high' },
  { model: 'openai/gpt-6-luna', variant: 'low' },
  { model: 'openai/gpt-6-luna', variant: 'max' },
  { model: 'openai/gpt-6-luna', variant: 'medium' },
  { model: 'openai/gpt-6-luna', variant: 'none' },
  { model: 'qwen/qwen3.8-flash', variant: 'instant' },
  { model: 'qwen/qwen3.8-flash', variant: 'thinking' },
  { model: 'qwen/qwen3.8-max-0902', variant: 'low' },
  { model: 'stepfun/step-5-preview', variant: 'high' },
  { model: 'stepfun/step-5-preview', variant: 'medium' },
  { model: 'xiaomi/mimo-v2.6-pro', variant: 'instant' },
  { model: 'z-ai/glm-5.3-flash', variant: 'high' },
];

/**
 * Failed rep-3 Ember pairs the same migration moves back to `pending` with the per-row
 * Re-admit: a full revision-3 run measures every case it lacks, the probes included.
 */
export const PROBE_ACTIVATION_READMIT_PAIRS: readonly ProbeActivationPair[] = [
  { model: 'meta/muse-ember', variant: 'high' },
  { model: 'meta/muse-ember', variant: 'low' },
  { model: 'meta/muse-ember', variant: 'max' },
  { model: 'meta/muse-ember', variant: 'medium' },
  { model: 'meta/muse-ember', variant: 'minimal' },
  { model: 'meta/muse-ember', variant: 'xhigh' },
];

/** Every pair the activation measures: the remeasure queue and the re-admitted rows. */
export const PROBE_ACTIVATION_PAIRS: readonly ProbeActivationPair[] = [
  ...PROBE_ACTIVATION_REMEASURE_PAIRS,
  ...PROBE_ACTIVATION_READMIT_PAIRS,
];

export type ProbeActivationReport = {
  /** Rows queued in `profile_remeasures`. */
  queued: number;
  /** Rows moved back to `pending` by the per-row Re-admit. */
  readmitted: number;
};

type ProbeActivationRow = typeof probeActivations.$inferSelect;
type StagedActivation = Pick<
  ProbeActivationRow,
  'action' | 'model' | 'variant' | 'engine_identity' | 'repetitions' | 'requested_at'
>;

/**
 * Applies this router's queued `probe_activations` rows once and consumes them in the
 * same batch: `remeasure` rows become `profile_remeasures` rows, `readmit` rows become the
 * per-row Re-admit's UPDATE (`src/profile-refresh.ts`). Both keep the guards the migration
 * used to carry: a pair whose provenance run already holds a result at the row's
 * `required_revision` for every activation case is not queued, and a row is re-admitted
 * only while it is still `failed` with class `unknown` and no live chunk.
 *
 * A row is applied only while the active revision reaches its `required_revision`: below
 * it the row stays staged, untouched, so a deploy that lowers `ACTIVE_MEASUREMENT_REVISION`
 * back to 2 never turns a revision-3 activation into revision-2 queue rows or re-admits a
 * pair that would be measured without the probes. Rolling forward again applies the rows
 * that are still there.
 *
 * The drain of the worker that ships this code applies them, never the migration: a
 * migration applies while the previous image is still serving, and that worker claims
 * `profile_remeasures` rows and `pending` profiles directly, so a queue row written one
 * deploy early would be measured under the revision it knows. Consuming the rows here is
 * also what keeps a pair whose probe run drops from being re-queued forever.
 *
 * @see probeActivations in `src/db-schema.ts` for why the rows are staged.
 */
export async function applyProbeActivations(
  db: D1Database,
  router: AutoRouter = PROBE_ACTIVATION_ROUTER,
  now: number = Date.now(),
  revision: number = ACTIVE_MEASUREMENT_REVISION
): Promise<ProbeActivationReport> {
  // The deploy that ships this code holds the dispatch lock from before it applies the
  // migration through the container rollout, and only after that is no instance of the
  // previous image still serving. Applying the rows under the lock would let one claim
  // them at its own revision, so the activation waits for the lock to be free.
  if (await dispatchLockHeld(db, now)) return { queued: 0, readmitted: 0 };
  const { results } = await db
    .prepare(
      `SELECT action, model, variant, engine_identity, repetitions, requested_at
      FROM probe_activations
      WHERE router = ? AND required_revision <= ?
      ORDER BY action, model, variant`
    )
    .bind(router, revision)
    .all<StagedActivation>();
  if (results.length === 0) return { queued: 0, readmitted: 0 };

  const orm = drizzle(db);
  const readmits = results.filter(row => row.action === 'readmit');
  const caseIds = JSON.stringify(PROBE_ACTIVATION_CASE_IDS);
  const statements = [
    orm
      .insert(profileRemeasures)
      .select(sql`
        SELECT
          ${probeActivations.router} AS router,
          ${probeActivations.model} AS model,
          ${probeActivations.variant} AS variant,
          ${probeActivations.engine_identity} AS engine_identity,
          ${probeActivations.repetitions} AS repetitions,
          NULL AS run_id,
          ${probeActivations.requested_at} AS requested_at,
          NULL AS claimed_at
        FROM ${probeActivations}
        JOIN ${benchmarkProfiles}
          ON ${benchmarkProfiles.router} = ${probeActivations.router}
          AND ${benchmarkProfiles.model} = ${probeActivations.model}
          AND ${benchmarkProfiles.variant} = ${probeActivations.variant}
          AND ${benchmarkProfiles.engine_identity} = ${probeActivations.engine_identity}
          AND ${benchmarkProfiles.repetitions} = ${probeActivations.repetitions}
        WHERE ${probeActivations.router} = ${router}
          AND ${probeActivations.required_revision} <= ${revision}
          AND ${probeActivations.action} = 'remeasure'
          AND ${benchmarkProfiles.status} = 'ready'
          AND ${benchmarkProfiles.run_id} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(${caseIds}) AS probe
            WHERE NOT EXISTS (
              SELECT 1 FROM case_results AS measured
              WHERE measured.run_id = ${benchmarkProfiles.run_id}
                AND measured.model = ${benchmarkProfiles.model}
                AND measured.variant = ${benchmarkProfiles.variant}
                AND measured.case_id = probe.value
                AND measured.prompt_revision >= ${probeActivations.required_revision}
            )
          )
      `)
      .onConflictDoNothing(),
    ...readmits.map(row =>
      orm
        .update(benchmarkProfiles)
        .set({
          status: 'pending',
          ...profileFailureResetAssignments,
          run_id: null,
          completed_at: null,
          requested_at: row.requested_at,
          updated_at: row.requested_at,
          invalidated_at: row.requested_at,
        })
        .where(
          and(
            eq(benchmarkProfiles.router, router),
            eq(benchmarkProfiles.model, row.model),
            eq(benchmarkProfiles.variant, row.variant),
            eq(benchmarkProfiles.engine_identity, row.engine_identity),
            eq(benchmarkProfiles.repetitions, row.repetitions),
            eq(benchmarkProfiles.status, 'failed'),
            eq(benchmarkProfiles.failure_class, 'unknown'),
            noLiveBenchmarkChunks({
              router,
              model: row.model,
              variant: row.variant,
              engineIdentity: row.engine_identity,
              repetitions: row.repetitions,
            })
          )
        )
    ),
    orm
      .delete(probeActivations)
      .where(
        and(eq(probeActivations.router, router), lte(probeActivations.required_revision, revision))
      ),
  ];
  // D1's batch is one transaction: the queue rows, the re-admits and the consumed
  // activation rows settle together, so a failed apply leaves the activation for the next
  // drain and a settled pair is never queued twice.
  const [queued, ...settled] = await db.batch(
    statements.map(statement => {
      const { sql: text, params } = statement.toSQL();
      return db.prepare(text).bind(...params);
    })
  );
  return {
    queued: queued.meta.changes ?? 0,
    readmitted: settled
      .slice(0, readmits.length)
      .reduce((total, result) => total + (result.meta.changes ?? 0), 0),
  };
}
