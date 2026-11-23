/**
 * Planning and pricing for user-paid custom-pool benchmarks.
 *
 * A quote is computed from the exact case-run identity the benchmark already uses:
 * (engine identity, concrete model, variant, repetition, case). The plan is immutable
 * for the life of its quote and carries only what admission and progress need:
 *
 * - `caseIds` is the router's case list at the measured revision, in dataset order, so a
 *   deploy that changes the dataset cannot change what an already-confirmed quote measures.
 * - Per concrete pair, one bit per (case index, repetition) says which slots the quote
 *   needs measured and which of those Kilo already covers with a sticky platform case run.
 *   A bitset is ~30 bytes per pair instead of thousands of slot rows, which keeps the
 *   quote row far below D1's row limit even for a maximal pool.
 * - Per concrete pair, the microdollar cost of one repetition of each case. Costs are
 *   integers so the reservation split has no rounding leak.
 *
 * Reuse is decided in two layers, both read-only. A pair whose profile is already `ready`
 * at this engine identity and repetition count is serving today, so every slot is reused and
 * nothing is quoted: a deploy that adds measured cases (revision-3 probes, the pwd-base case)
 * must not create new demand for a model that already serves. For a pair that is not ready,
 * the canonical predicate (`PRIOR_CASE_RESULTS_REUSE_SQL` and `minimumCaseRevisions`) fills
 * each (case, repetition) slot from a valid, non-invalidated stored draw. Repetition r is
 * filled only by repetition r, so one stored draw is never counted twice.
 */
import {
  customRouterEntryKey,
  resolveEffectivePolicy,
  type AutoRouter,
  type BenchmarkConfig,
  type BenchmarkPair,
  type CandidatePricing,
  type CustomRouterBenchmarkContext,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { getBenchmarkConfig } from './config';
import caseComplexity from './datasets/case-complexity.json';
import { exactPairKey, listReadyCurrentProfilesForEntries } from './db';
import type { PaidCaseKey, PaidCreditOwner } from './paid-case-store';
import {
  ACTIVE_MEASUREMENT_REVISION,
  deciderCasesForRouter,
  minimumCaseRevisions,
  type MeasuredCase,
} from './measurement-revision';
import { isProbeCase } from './datasets/probe-cases';
import {
  type BenchmarkModelCatalogSchema,
  MIN_BENCHMARK_INPUT_TOKENS,
  benchmarkPairUnavailability,
  catalogCandidatePrices,
  catalogModelVariants,
  fetchBenchmarkModelCatalog,
} from './platform-models';
import { variantFromStorage, variantToStorage } from './reasoning-effort';

const CASE_COMPLEXITY_BUCKETS = caseComplexity as Record<string, string>;

/**
 * Token assumptions for a case with no measured cost at this engine identity. The input
 * floor is the CLI harness prompt plus a short case (the same constant the drain uses to
 * reject too-small context windows); output is a short graded answer, or a larger budget
 * for a case that must drive tool calls. These are documented estimates, not measurements.
 */
export const ASSUMED_OUTPUT_TOKENS = 512;
export const ASSUMED_TOOL_OUTPUT_TOKENS = 2_048;
const CHARS_PER_TOKEN = 4;

export type PaidPlanCaseClass = 'reused' | 'covered' | 'shared' | 'exclusive';

export type PaidPlanPair = {
  model: string;
  /** Storage variant key (`''` is the default variant), so the plan never re-canonicalises. */
  variant: string;
  /**
   * True when this pair was already ready (serving) at the quoted engine identity and
   * repetition count. Recorded at quote time so staging never re-derives it: a serving pair
   * is never staged, never priced, and its v3 probe draws are never re-checked.
   */
  serving: boolean;
  /** Missing slots, bit index = caseIndex * repetitions + rep. */
  missing: string;
  /** Of those missing slots, the ones a sticky platform case run already covers. */
  covered: string;
  /** Microdollars for one repetition of each case, indexed by case index. */
  cost: number[];
};

export type PaidBenchmarkPlan = {
  version: 1;
  router: AutoRouter;
  engineIdentity: string;
  revision: number;
  repetitions: number;
  caseIds: string[];
  /** Sorted by (model, variant); slot order is pair index, case index, repetition. */
  pairs: PaidPlanPair[];
  counts: Record<PaidPlanCaseClass, number>;
  estimateMicrodollars: number;
  maximumMicrodollars: number;
  aliases: { model: string; target: string }[];
  /**
   * The reserved benchmark project every model call of this request is attributed to,
   * derived from the authenticated saved pool (`benchmarkProjectId`), never from client
   * input. Frozen with the quote, so a later pool rename cannot split one request's usage.
   */
  projectId: string;
};

const BitsetSchema = z.string().min(1).max(4096);
const PlanPairSchema = z.object({
  model: z.string().min(1),
  variant: z.string(),
  serving: z.boolean(),
  missing: BitsetSchema,
  covered: BitsetSchema,
  cost: z.array(z.int().nonnegative()),
});
export const PaidBenchmarkPlanSchema = z.object({
  version: z.literal(1),
  router: z.enum(['efficient', 'frontier']),
  engineIdentity: z.string().min(1),
  revision: z.int().positive(),
  repetitions: z.int().positive(),
  caseIds: z.array(z.string().min(1)),
  pairs: z.array(PlanPairSchema),
  counts: z.object({
    reused: z.int().nonnegative(),
    covered: z.int().nonnegative(),
    shared: z.int().nonnegative(),
    exclusive: z.int().nonnegative(),
  }),
  estimateMicrodollars: z.int().nonnegative(),
  maximumMicrodollars: z.int().nonnegative(),
  aliases: z.array(z.object({ model: z.string().min(1), target: z.string().min(1) })),
  projectId: z.string().min(1).max(256),
});

export type PaidPlanOutcome =
  | { status: 'empty' }
  | { status: 'blocked'; reason: string; retryable: boolean }
  | { status: 'ready'; plan: PaidBenchmarkPlan };

// --- bitsets -------------------------------------------------------------------------

function bitsetBytes(bitCount: number): Uint8Array {
  return new Uint8Array(Math.max(1, Math.ceil(bitCount / 8)));
}

function encodeBitset(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBitset(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function setBit(bytes: Uint8Array, bit: number): void {
  bytes[bit >> 3] |= 1 << (bit & 7);
}

function readBit(bytes: Uint8Array, bit: number): boolean {
  return (bytes[bit >> 3] & (1 << (bit & 7))) !== 0;
}

export function planSlotBit(caseIndex: number, repetitions: number, rep: number): number {
  return caseIndex * repetitions + rep;
}

export function planSlotCount(
  plan: Pick<PaidBenchmarkPlan, 'pairs' | 'caseIds' | 'repetitions'>
): number {
  return plan.pairs.length * plan.caseIds.length * plan.repetitions;
}

/** The exact slot at a flat index; `null` past the end of the plan. */
export function planSlotAt(
  plan: Pick<PaidBenchmarkPlan, 'pairs' | 'caseIds' | 'repetitions'>,
  index: number
): { pairIndex: number; caseIndex: number; rep: number } | null {
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const perPair = plan.caseIds.length * plan.repetitions;
  if (perPair <= 0) return null;
  const pairIndex = Math.floor(index / perPair);
  if (pairIndex >= plan.pairs.length) return null;
  const within = index - pairIndex * perPair;
  return {
    pairIndex,
    caseIndex: Math.floor(within / plan.repetitions),
    rep: within % plan.repetitions,
  };
}

export function planSlotIsMissing(
  plan: Pick<PaidBenchmarkPlan, 'pairs' | 'repetitions'>,
  pairIndex: number,
  caseIndex: number,
  rep: number
): boolean {
  const pair = plan.pairs[pairIndex];
  if (!pair) return false;
  return readBit(decodeBitset(pair.missing), planSlotBit(caseIndex, plan.repetitions, rep));
}

export function planSlotIsCovered(
  plan: Pick<PaidBenchmarkPlan, 'pairs' | 'repetitions'>,
  pairIndex: number,
  caseIndex: number,
  rep: number
): boolean {
  const pair = plan.pairs[pairIndex];
  if (!pair) return false;
  return readBit(decodeBitset(pair.covered), planSlotBit(caseIndex, plan.repetitions, rep));
}

export function planSlotKey(
  plan: PaidBenchmarkPlan,
  slot: { pairIndex: number; caseIndex: number; rep: number }
): PaidCaseKey {
  const pair = plan.pairs[slot.pairIndex];
  const caseId = plan.caseIds[slot.caseIndex];
  if (!pair || !caseId) throw new Error('paid benchmark plan slot is out of range');
  return {
    engineIdentity: plan.engineIdentity,
    model: pair.model,
    variant: pair.variant,
    rep: slot.rep,
    caseId,
  };
}

// --- measured costs ------------------------------------------------------------------

/** Microdollars for a USD cost, rounded up so a cheap case never prices as free. */
export function usdToMicrodollars(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd < 0) return 0;
  return Math.max(1, Math.ceil(costUsd * 1_000_000));
}

/** A slot's share when `otherPayers` accounts already pay the same case run. */
export function sharedShareMicrodollars(cost: number, otherPayers: number): number {
  return Math.ceil(cost / (Math.max(0, otherPayers) + 1));
}

export function fallbackCaseCostMicrodollars(
  benchCase: MeasuredCase,
  pricing: CandidatePricing
): number {
  const declared = isProbeCase(benchCase) ? benchCase.probe.transcript : null;
  const longContext = 'longContext' in benchCase ? benchCase.longContext : undefined;
  const promptChars =
    declared !== null
      ? JSON.stringify(declared).length
      : 'systemPrompt' in benchCase
        ? benchCase.systemPrompt.length + benchCase.userPrompt.length
        : 0;
  const caseTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const inputTokens =
    longContext !== undefined
      ? Math.max(MIN_BENCHMARK_INPUT_TOKENS, caseTokens, longContext.targetTokens)
      : Math.max(MIN_BENCHMARK_INPUT_TOKENS, caseTokens);
  const outputTokens =
    'requiredToolCalls' in benchCase && benchCase.requiredToolCalls
      ? ASSUMED_TOOL_OUTPUT_TOKENS
      : ASSUMED_OUTPUT_TOKENS;
  const costUsd =
    inputTokens * pricing.promptUsdPerToken + outputTokens * pricing.completionUsdPerToken;
  return usdToMicrodollars(costUsd);
}

export type PairCostHistory = {
  /** Case id → mean microdollars of its measured draws at this engine identity. */
  byCase: Map<string, number>;
  /** Complexity bucket → mean microdollars of that pair's measured cases in it. */
  byBucket: Map<string, number>;
  /** Mean microdollars over every measured case of the pair. */
  mean: number | null;
};

export function summariseCostHistory(
  rows: readonly { case_id: string; cost_usd: number | null }[]
): PairCostHistory {
  const sums = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    if (row.cost_usd === null) continue;
    const entry = sums.get(row.case_id) ?? { total: 0, count: 0 };
    entry.total += row.cost_usd;
    entry.count += 1;
    sums.set(row.case_id, entry);
  }
  const byCase = new Map<string, number>();
  for (const [caseId, entry] of sums)
    byCase.set(caseId, usdToMicrodollars(entry.total / entry.count));

  const buckets = new Map<string, { total: number; count: number }>();
  let total = 0;
  for (const [caseId, microdollars] of byCase) {
    const bucket = CASE_COMPLEXITY_BUCKETS[caseId] ?? 'medium';
    const entry = buckets.get(bucket) ?? { total: 0, count: 0 };
    entry.total += microdollars;
    entry.count += 1;
    buckets.set(bucket, entry);
    total += microdollars;
  }
  return {
    byCase,
    byBucket: new Map(
      [...buckets].map(([bucket, entry]) => [bucket, Math.ceil(entry.total / entry.count)])
    ),
    mean: byCase.size > 0 ? Math.ceil(total / byCase.size) : null,
  };
}

/**
 * Cost used for an unmeasured case: the pair's own measurement of that case, then the
 * pair's measured mean for the same input-size bucket, then the pair's measured mean, and
 * only then the catalog price with the documented token assumptions. A long-context case
 * never borrows a bucket mean: short cases would understate a 100k-token request by more
 * than an order of magnitude, so it is either measured exactly or priced from the catalog
 * for its own context. Null when the catalog cannot price the model, which fails the quote
 * closed instead of inventing a limit.
 */
export function caseCostMicrodollars(input: {
  pair: BenchmarkPair;
  benchCase: MeasuredCase;
  history: PairCostHistory;
  pricing: CandidatePricing | null;
  longContext: boolean;
}): number | null {
  const exact = input.history.byCase.get(input.benchCase.id);
  if (exact !== undefined) return exact;
  if (input.longContext)
    return input.pricing === null
      ? null
      : fallbackCaseCostMicrodollars(input.benchCase, input.pricing);
  const bucket = CASE_COMPLEXITY_BUCKETS[input.benchCase.id] ?? 'medium';
  const bucketMean = input.history.byBucket.get(bucket);
  if (bucketMean !== undefined) return bucketMean;
  if (input.history.mean !== null) return input.history.mean;
  if (input.pricing === null) return null;
  return fallbackCaseCostMicrodollars(input.benchCase, input.pricing);
}

// --- reuse and admission reads -------------------------------------------------------

/**
 * Valid stored draws for one concrete pair at this engine identity, restricted to the
 * repetitions the plan measures, the case minimum revisions and the profile invalidation
 * rule — the same predicate the run's own prior-case copy uses. Optional case/repetition
 * filters keep a staging slice from rescanning the whole pair.
 */
export function paidReuseDrawsSql(
  filters: { caseIds?: readonly string[]; reps?: readonly number[] } = {}
): string {
  const caseFilter =
    filters.caseIds && filters.caseIds.length > 0
      ? ` AND source.case_id IN (${filters.caseIds.map(() => '?').join(', ')})`
      : '';
  const repFilter =
    filters.reps && filters.reps.length > 0
      ? ` AND source.rep IN (${filters.reps.map(() => '?').join(', ')})`
      : '';
  return `
  WITH ranked AS (
    SELECT source.case_id, source.rep, source.cost_usd,
      ROW_NUMBER() OVER (
        PARTITION BY source.case_id, source.rep
        ORDER BY run.started_at DESC, run.id DESC
      ) AS reuse_rank
    FROM benchmark_runs AS run
    CROSS JOIN case_results AS source
    WHERE run.id = source.run_id
      AND run.kind = 'decider' AND run.status IN ('completed', 'failed')
      AND run.router = ? AND run.engine_identity = ?
      AND source.rep < ?
      AND source.model = ? AND source.variant = ?${caseFilter}${repFilter}
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
  SELECT case_id, rep, cost_usd FROM ranked WHERE reuse_rank = 1`;
}

/**
 * Recoverable pending outputs for one pair — the twin of {@link paidReuseDrawsSql}.
 *
 * The runner's startup adoption copies a prior run's durable ungraded output
 * (`PRIOR_PENDING_OUTPUTS_REUSE_SQL`) and grades it in place, so a case whose only live
 * evidence is such an output is *not* a new paid measurement. Quoting it as paid would be a
 * false charge; this query mirrors that eligibility exactly (same run/engine/invalidation and
 * minimum-revision guards, valid exit code, no output already graded for that slot).
 */
export function paidPendingOutputsSql(
  filters: { caseIds?: readonly string[]; reps?: readonly number[] } = {}
): string {
  const caseFilter =
    filters.caseIds && filters.caseIds.length > 0
      ? ` AND source.case_id IN (${filters.caseIds.map(() => '?').join(', ')})`
      : '';
  const repFilter =
    filters.reps && filters.reps.length > 0
      ? ` AND source.rep IN (${filters.reps.map(() => '?').join(', ')})`
      : '';
  return `
  SELECT DISTINCT source.case_id, source.rep FROM benchmark_runs AS run
  CROSS JOIN pending_decider_outputs AS source
  WHERE run.id = source.run_id
    AND run.kind = 'decider' AND run.status IN ('completed', 'failed')
    AND run.router = ? AND run.engine_identity = ?
    AND source.rep < ?
    AND source.model = ? AND source.variant = ?${caseFilter}${repFilter}
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
    )`;
}

/**
 * Pairs the live platform queue already owns at this engine identity and repetition count.
 *
 * The registry row is the durable membership record: `platform_requested = 1` is written when
 * the platform subscription is admitted and stays set while the platform's own run may not yet
 * have materialized a case run. A pair the platform owns is paid by Kilo, so quoting it as user
 * cost would be a prospective charge for work the platform is about to do — and the runtime
 * contradicts it by latching coverage on the first platform claim.
 *
 * Indexed by the registry PK prefix (router, model, variant, engine, repetitions).
 */
export async function readPlatformRequestedPairs(
  db: D1Database,
  input: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    pairs: readonly BenchmarkPair[];
  }
): Promise<Set<string>> {
  if (input.pairs.length === 0) return new Set();
  const found = new Set<string>();
  for (const pair of input.pairs) {
    const row = await db
      .prepare(
        `SELECT 1 AS present FROM benchmark_profiles
        WHERE router = ? AND model = ? AND variant = ? AND engine_identity = ?
          AND repetitions = ? AND platform_requested = 1
        LIMIT 1`
      )
      .bind(
        input.router,
        pair.model,
        variantToStorage(pair.variant),
        input.engineIdentity,
        input.repetitions
      )
      .first<{ present: number }>();
    if (row) found.add(exactPairKey(pair.model, pair.variant));
  }
  return found;
}

export type StoredDraw = { case_id: string; rep: number; cost_usd: number | null };

export async function readPairStoredDraws(
  db: D1Database,
  input: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    pair: BenchmarkPair;
    minimumRevisions: Record<string, number>;
    /** Restrict to a staging slice; a maximal plan must not rescan the pair per batch. */
    caseIds?: readonly string[];
    reps?: readonly number[];
  }
): Promise<StoredDraw[]> {
  const rows = await db
    .prepare(paidReuseDrawsSql({ caseIds: input.caseIds, reps: input.reps }))
    .bind(
      input.router,
      input.engineIdentity,
      input.repetitions,
      input.pair.model,
      variantToStorage(input.pair.variant),
      ...(input.caseIds ?? []),
      ...(input.reps ?? []),
      JSON.stringify(input.minimumRevisions)
    )
    .all<StoredDraw>();
  return rows.results;
}

export type OpenCaseRun = {
  case_id: string;
  rep: number;
  status: 'queued' | 'running' | 'settled' | 'cancelled' | 'failed';
  platform_covered: number;
  result_usable: number;
  /** Distinct owner units already paying this case run. */
  payers: number;
};

/** Live (or usable) case runs for one concrete pair, with their current payer count. */

/** Slots whose only live evidence is a recoverable pending output (free, not a new job). */
export async function readPairPendingOutputs(
  db: D1Database,
  input: {
    router: AutoRouter;
    engineIdentity: string;
    repetitions: number;
    pair: BenchmarkPair;
    minimumRevisions: Record<string, number>;
    caseIds?: readonly string[];
    reps?: readonly number[];
  }
): Promise<Array<{ case_id: string; rep: number }>> {
  const rows = await db
    .prepare(paidPendingOutputsSql({ caseIds: input.caseIds, reps: input.reps }))
    .bind(
      input.router,
      input.engineIdentity,
      input.repetitions,
      input.pair.model,
      variantToStorage(input.pair.variant),
      ...(input.caseIds ?? []),
      ...(input.reps ?? []),
      JSON.stringify(input.minimumRevisions)
    )
    .all<{ case_id: string; rep: number }>();
  return rows.results;
}

export async function readOpenCaseRuns(
  db: D1Database,
  input: {
    engineIdentity: string;
    pair: BenchmarkPair;
    /** Restrict to a staging slice; a maximal plan must not rescan the pair per batch. */
    caseIds?: readonly string[];
    reps?: readonly number[];
  }
): Promise<OpenCaseRun[]> {
  const caseFilter =
    input.caseIds && input.caseIds.length > 0
      ? ` AND run.case_id IN (${input.caseIds.map(() => '?').join(', ')})`
      : '';
  const repFilter =
    input.reps && input.reps.length > 0
      ? ` AND run.rep IN (${input.reps.map(() => '?').join(', ')})`
      : '';
  const rows = await db
    .prepare(
      `SELECT run.case_id, run.rep, run.status, run.platform_covered, run.result_usable,
        (SELECT COUNT(DISTINCT payer.owner_type || ':' || payer.owner_id)
          FROM benchmark_case_payers AS payer
          WHERE payer.engine_identity = run.engine_identity AND payer.model = run.model
            AND payer.variant = run.variant AND payer.rep = run.rep
            AND payer.case_id = run.case_id
            AND payer.status IN ('eligible', 'accepted')) AS payers
      FROM benchmark_case_runs AS run
      WHERE run.engine_identity = ? AND run.model = ? AND run.variant = ?${caseFilter}${repFilter}`
    )
    .bind(
      input.engineIdentity,
      input.pair.model,
      variantToStorage(input.pair.variant),
      ...(input.caseIds ?? []),
      ...(input.reps ?? [])
    )
    .all<OpenCaseRun>();
  return rows.results;
}

// --- plan construction ---------------------------------------------------------------

export type PaidPlanDeps = {
  db: D1Database;
  env: { KILO_WEB_API_BASE_URL: string };
  fetchImpl?: typeof fetch;
  now?: number;
};

export type PaidPlanInput = {
  context: CustomRouterBenchmarkContext;
  /** Engine identity of the router's decider runs at plan time. */
  engineIdentity: string;
  /**
   * Reserved benchmark project id for this saved pool, derived by the web from the
   * authorized router row (`benchmarkProjectId`), never from client input.
   */
  projectId: string;
  /** Overrides the measured case list (tests and future revisions). */
  cases?: readonly MeasuredCase[];
  config?: BenchmarkConfig | null;
};

/**
 * Why this concrete pair cannot be benchmarked again, or null.
 *
 * The pair is `(router, model, variant, engine_identity)` — repetitions are deliberately not
 * part of eligibility, matching `classifyProfileAdmission` and the permit path, whose
 * re-admission clears `unavailable` at every repetition count of the current engine. A quote
 * at another repetition count of the same engine therefore agrees with the permit, and a
 * stale row from another engine or router cannot veto a pair that is usable now. The
 * predicate is indexed by the registry PK prefix (router, model, variant, engine).
 */
export async function terminalPairReason(
  db: D1Database,
  input: { router: AutoRouter; engineIdentity: string; pair: BenchmarkPair }
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT failure_reason FROM benchmark_profiles
      WHERE router = ? AND model = ? AND variant = ? AND engine_identity = ?
        AND status = 'unavailable'
      LIMIT 1`
    )
    .bind(
      input.router,
      input.pair.model,
      variantToStorage(input.pair.variant),
      input.engineIdentity
    )
    .first<{ failure_reason: string | null }>();
  if (!row) return null;
  return (
    row.failure_reason ??
    'This model is permanently failed in the benchmark registry; an operator must re-admit it.'
  );
}

/**
 * Every concrete gateway pair the worker can measure for this pool. Client entries and
 * entries the owner's CLI measures stay on the client eval path and are never charged
 * here. A gateway entry whose catalog alias has a target contributes that target, and the
 * alias/target pair is recorded so a later alias move invalidates the quote.
 */
function planPairs(
  context: CustomRouterBenchmarkContext,
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>
): { pairs: BenchmarkPair[]; aliases: { model: string; target: string }[] } | { blocked: string } {
  const clientEval = new Set(context.clientEvalEntryKeys);
  const pairs = new Map<string, BenchmarkPair>();
  const aliases = new Map<string, string>();
  for (const entry of context.entries) {
    if (entry.kind !== 'gateway' || clientEval.has(customRouterEntryKey(entry))) continue;
    const resolved = catalogModelVariants(catalog, entry.model);
    if (!resolved)
      return { blocked: `Model ${entry.model} is not available in the benchmark catalog.` };
    const catalogEntry = catalog.data.find(model => model.id === entry.model);
    // `catalogModelVariants` already resolved an alias to its concrete target; recording the
    // alias and that target lets a later move invalidate the quote before any spend.
    if (catalogEntry?.alias_target) aliases.set(entry.model, resolved.model);
    for (const variant of resolved.variants) {
      const unavailable = benchmarkPairUnavailability(catalog, {
        model: resolved.model,
        variant,
      });
      if (unavailable) return { blocked: unavailable.reason };
      const pair = { model: resolved.model, variant };
      pairs.set(exactPairKey(pair.model, pair.variant), pair);
    }
  }
  return {
    pairs: [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair),
    aliases: [...aliases.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, target]) => ({ model, target })),
  };
}

/**
 * Build the immutable quote plan. Nothing here writes: a quote is a read-only computation,
 * so a pool edit, a subscription sync or an alias scan can never start spending.
 */
export async function buildPaidBenchmarkPlan(
  deps: PaidPlanDeps,
  input: PaidPlanInput
): Promise<PaidPlanOutcome> {
  const db = deps.db;
  const router = input.context.baseRouter;
  const config = input.config ?? (await getBenchmarkConfig(db, router));
  if (!config)
    return { status: 'blocked', reason: 'Benchmark configuration is missing.', retryable: false };

  let catalog: z.infer<typeof BenchmarkModelCatalogSchema>;
  try {
    catalog = await fetchBenchmarkModelCatalog(
      { KILO_WEB_API_BASE_URL: deps.env.KILO_WEB_API_BASE_URL },
      deps.fetchImpl ?? fetch
    );
  } catch {
    return {
      status: 'blocked',
      reason: 'Benchmark model catalog is unavailable.',
      retryable: true,
    };
  }

  const resolved = planPairs(input.context, catalog);
  if ('blocked' in resolved)
    return { status: 'blocked', reason: resolved.blocked, retryable: false };
  if (resolved.pairs.length === 0) return { status: 'empty' };

  const revision = ACTIVE_MEASUREMENT_REVISION;
  const cases = input.cases ?? deciderCasesForRouter(router, revision);
  const caseIds = cases.map(benchCase => benchCase.id);
  const repetitions = resolveEffectivePolicy(config).deciderRepetitions;
  const minimums = minimumCaseRevisions(router, revision);
  const prices = catalogCandidatePrices(catalog);

  // A pair already measured ready at this engine identity and repetition count is serving
  // today: the routing table can rank it, so it is not asked for again just because the
  // measured case set grew (revision-3 probes, the pwd-base case). This read has no side
  // effects and creates no demand — only an unmeasured pair, or a new alias target the owner
  // selected, is quoted at the current revision. A `ready` row whose `run_id` is null or empty
  // names no measuring run, so it is not counted as serving here either (the same readiness
  // custom table assembly and alias promotion read): such a pair must not back a zero-cost
  // pin move.
  const readyPairs = new Set(
    (
      await listReadyCurrentProfilesForEntries(
        db,
        { router, engineIdentity: input.engineIdentity, repetitions },
        resolved.pairs
      )
    )
      .filter(row => row.run_id != null && row.run_id !== '')
      .map(row => exactPairKey(row.model, variantFromStorage(row.variant)))
  );

  // Durable platform ownership, read once per plan: a pair the live platform queue requested
  // at this engine/repetition count is Kilo-paid even before its case runs exist.
  const platformPairs = await readPlatformRequestedPairs(db, {
    router,
    engineIdentity: input.engineIdentity,
    repetitions,
    pairs: resolved.pairs,
  });

  const counts: Record<PaidPlanCaseClass, number> = {
    reused: 0,
    covered: 0,
    shared: 0,
    exclusive: 0,
  };
  let estimateMicrodollars = 0;
  let maximumMicrodollars = 0;
  let servingPairs = 0;
  const planPairsOut: PaidPlanPair[] = [];

  for (const pair of resolved.pairs) {
    // A model the registry diagnosed terminally (catalog-absent or its proven failure budget)
    // cannot ever be measured: refuse the quote with the reason instead of pricing work that
    // could not be admitted. Existing results and charges are untouched; other pairs still
    // serve and still quote.
    const terminal = await terminalPairReason(db, {
      router,
      engineIdentity: input.engineIdentity,
      pair,
    });
    if (terminal !== null) return { status: 'blocked', reason: terminal, retryable: false };
    if (readyPairs.has(exactPairKey(pair.model, pair.variant))) {
      // Already serving: every slot counts as reused, nothing is priced, nothing is staged.
      servingPairs += 1;
      counts.reused += caseIds.length * repetitions;
      planPairsOut.push({
        model: pair.model,
        variant: variantToStorage(pair.variant),
        serving: true,
        missing: encodeBitset(bitsetBytes(caseIds.length * repetitions)),
        covered: encodeBitset(bitsetBytes(caseIds.length * repetitions)),
        cost: caseIds.map(() => 0),
      });
      continue;
    }
    const [draws, runs, pendings] = await Promise.all([
      readPairStoredDraws(db, {
        router,
        engineIdentity: input.engineIdentity,
        repetitions,
        pair,
        minimumRevisions: minimums,
      }),
      readOpenCaseRuns(db, { engineIdentity: input.engineIdentity, pair }),
      readPairPendingOutputs(db, {
        router,
        engineIdentity: input.engineIdentity,
        repetitions,
        pair,
        minimumRevisions: minimums,
      }),
    ]);
    const caseIndexById = new Map(caseIds.map((caseId, index) => [caseId, index]));
    const reused = new Set<number>();
    for (const draw of draws) {
      const caseIndex = caseIndexById.get(draw.case_id);
      if (caseIndex !== undefined) reused.add(planSlotBit(caseIndex, repetitions, draw.rep));
    }
    // A slot whose only live evidence is a recoverable pending output is reused too: the run
    // adopts and grades it without a provider call, so quoting it as paid would be false.
    for (const pending of pendings) {
      const caseIndex = caseIndexById.get(pending.case_id);
      if (caseIndex !== undefined) reused.add(planSlotBit(caseIndex, repetitions, pending.rep));
    }
    const openBySlot = new Map(
      runs
        .filter(run => run.status === 'queued' || run.status === 'running')
        .flatMap(run => {
          const caseIndex = caseIndexById.get(run.case_id);
          return caseIndex === undefined
            ? []
            : [[planSlotBit(caseIndex, repetitions, run.rep), run] as const];
        })
    );
    const history = summariseCostHistory(draws);
    const pricing = prices.get(pair.model) ?? null;
    // Kilo owns this pair through the platform queue even before it materializes each case
    // run: those slots are covered, not charged, exactly as the runtime latch will make them.
    const platformOwned = platformPairs.has(exactPairKey(pair.model, pair.variant));

    // Classify every slot of this pair first, so a case that is entirely reused or covered
    // never needs a price: a fully reused quote must stay $0 even for an unpriced model.
    const classes = new Map<number, { kind: PaidPlanCaseClass; payers: number }>();
    for (let caseIndex = 0; caseIndex < caseIds.length; caseIndex += 1) {
      for (let rep = 0; rep < repetitions; rep += 1) {
        const bit = planSlotBit(caseIndex, repetitions, rep);
        if (reused.has(bit)) {
          classes.set(bit, { kind: 'reused', payers: 0 });
          continue;
        }
        // Covered when Kilo already latched the case run, or when the raw pair itself is owned
        // by the live platform queue (the latch has simply not materialized it yet).
        const open = openBySlot.get(bit);
        if ((open && open.platform_covered === 1) || platformOwned)
          classes.set(bit, { kind: 'covered', payers: 0 });
        else if (open && open.payers > 0) classes.set(bit, { kind: 'shared', payers: open.payers });
        else classes.set(bit, { kind: 'exclusive', payers: 0 });
      }
    }

    const missingBits = bitsetBytes(caseIds.length * repetitions);
    const coveredBits = bitsetBytes(caseIds.length * repetitions);
    const cost: number[] = [];
    for (let caseIndex = 0; caseIndex < caseIds.length; caseIndex += 1) {
      const benchCase = cases[caseIndex];
      if (!benchCase) throw new Error('paid benchmark plan lost a case');
      let priced = false;
      for (let rep = 0; rep < repetitions; rep += 1) {
        const kind = classes.get(planSlotBit(caseIndex, repetitions, rep))?.kind;
        if (kind === 'shared' || kind === 'exclusive') priced = true;
      }
      if (!priced) {
        cost[caseIndex] = 0;
        continue;
      }
      const unit = caseCostMicrodollars({
        pair,
        benchCase,
        history,
        pricing,
        longContext: 'longContext' in benchCase && benchCase.longContext !== undefined,
      });
      if (unit === null)
        return {
          status: 'blocked',
          reason: `The catalog cannot price ${pair.model}${pair.variant ? ` (${pair.variant})` : ''}.`,
          retryable: true,
        };
      cost[caseIndex] = unit;
    }

    for (let caseIndex = 0; caseIndex < caseIds.length; caseIndex += 1) {
      const unit = cost[caseIndex] ?? 0;
      for (let rep = 0; rep < repetitions; rep += 1) {
        const bit = planSlotBit(caseIndex, repetitions, rep);
        const slot = classes.get(bit);
        if (!slot) continue;
        counts[slot.kind] += 1;
        if (slot.kind === 'reused') continue;
        setBit(missingBits, bit);
        if (slot.kind === 'covered') {
          setBit(coveredBits, bit);
          continue;
        }
        estimateMicrodollars +=
          slot.kind === 'shared' ? sharedShareMicrodollars(unit, slot.payers) : unit;
        maximumMicrodollars += unit;
      }
    }
    planPairsOut.push({
      model: pair.model,
      variant: variantToStorage(pair.variant),
      serving: false,
      missing: encodeBitset(missingBits),
      covered: encodeBitset(coveredBits),
      cost,
    });
  }

  // A saved pool can keep serving an older concrete target than the alias now resolves to.
  // When every resolved pair already serves, the only work left is the owner's explicit
  // decision to move that pin, so it is quoted at zero: staging writes reused rows only, and
  // no case run, permit or usage can be created for it. Only a resolved alias with a saved
  // pin on a different target qualifies; a `measuredAs` entry never dispatches its own target.
  const pinMoves =
    servingPairs === resolved.pairs.length
      ? input.context.entries.flatMap(entry => {
          if (entry.kind !== 'gateway' || entry.measuredAs !== undefined) return [];
          if (!entry.model.startsWith('~') || entry.servingPin === undefined) return [];
          const resolvedTarget = resolved.aliases.find(alias => alias.model === entry.model);
          if (resolvedTarget === undefined || resolvedTarget.target === entry.servingPin.model)
            return [];
          return [resolvedTarget];
        })
      : [];
  // Nothing left to measure: an already-benchmarked pool serves without a quote at all, so
  // no quote row is written and no progress screen suggests a purchase. A pool with one
  // serving pair and one new target still quotes the new target only.
  if (servingPairs === resolved.pairs.length && pinMoves.length === 0) return { status: 'empty' };

  const plan: PaidBenchmarkPlan = {
    version: 1,
    router,
    engineIdentity: input.engineIdentity,
    revision,
    repetitions,
    caseIds,
    pairs: planPairsOut,
    counts,
    estimateMicrodollars,
    maximumMicrodollars,
    // A pin-move quote has no measured pair, so only the aliases it asks the owner to move are
    // published; a full quote keeps every alias it priced.
    aliases: servingPairs === resolved.pairs.length ? pinMoves : resolved.aliases,
    projectId: input.projectId,
  };
  // A quote row must stay far below D1's 2 MB row limit; refuse to write one that cannot.
  if (JSON.stringify(plan).length > 1_500_000)
    return {
      status: 'blocked',
      reason: 'This pool is too large to quote in one request.',
      retryable: false,
    };
  return { status: 'ready', plan };
}

/**
 * A quote that asks only to move a saved pin onto an alias target another measurement already
 * made usable. By construction every pair is `serving` (a plan with all pairs serving exists
 * only for a pin move), nothing is priced and nothing is measured, so its one effect is the
 * settlement callback that writes the pin.
 */
export function isPinOnlyPlan(plan: PaidBenchmarkPlan): boolean {
  return plan.pairs.length > 0 && plan.pairs.every(pair => pair.serving);
}

/** Refusal for a pin move whose ready evidence is gone: only a fresh estimate can re-serve it. */
export const SERVING_EVIDENCE_GONE_REASON =
  'The benchmark result this estimate relies on is gone; request a new estimate.';

/**
 * Whether the evidence a pin move depends on still exists: every alias this plan would publish
 * needs a confirmed target with a ready profile that names its measuring run, at the quoted
 * engine and repetition count.
 *
 * Only published targets are read, and a target counts once — any of its effort variants being
 * ready is enough, which is exactly the rule the settlement callback applies per alias. Two
 * narrower readings both broke real pools: requiring every plan pair let one withdrawn sibling
 * refuse a free move, and requiring every variant of the pinned target would refuse an alias the
 * callback publishes from its ready variant while a sibling variant is merely requeued. Either
 * way the owner was left with "request a new estimate", and that fresh estimate prices work the
 * click never authorized.
 */
export async function readServingPairsStillReady(
  db: D1Database,
  plan: Pick<PaidBenchmarkPlan, 'pairs' | 'aliases' | 'engineIdentity' | 'repetitions' | 'router'>
): Promise<boolean> {
  const pinned = new Set(plan.aliases.map(alias => alias.target));
  const targets = plan.pairs.filter(pair => pinned.has(pair.model));
  if (targets.length === 0) return false;
  const ready = await listReadyCurrentProfilesForEntries(
    db,
    { router: plan.router, engineIdentity: plan.engineIdentity, repetitions: plan.repetitions },
    targets.map(pair => ({ model: pair.model, variant: variantFromStorage(pair.variant) }))
  );
  const proven = new Set(
    ready
      // A ready row with no `run_id` (null or empty) names no measuring run, so it cannot be
      // ranked or bound to a summary — the same readiness table assembly and alias promotion
      // require, and the reason it is not serving evidence here.
      .filter(row => row.run_id != null && row.run_id !== '')
      .map(row => row.model)
  );
  return [...pinned].every(model => proven.has(model));
}

/** Canonical JSON so two equal contexts compare equal whatever their key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function ownerOf(ownerType: 'user' | 'org', ownerId: string): PaidCreditOwner {
  return { ownerType: ownerType === 'org' ? 'organization' : 'user', ownerId };
}
