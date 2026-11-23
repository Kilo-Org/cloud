/**
 * User-paid custom-pool benchmarks: quote, explicit confirm, progress and pause.
 *
 * Nothing here can start spending on its own. A quote is a read-only plan; only the `start`
 * action (one click, forwarded by the web after it authorized the saved pool) consumes a
 * quote. A request spends nothing until its whole planned case set is staged in bounded D1
 * batches; only then does it become `active`, which is what lets the scheduler claim its
 * cases. Staging resumes from a progress read or the cron reconcile, so a maximal pool is
 * paged across transactions instead of being dumped into one.
 *
 * Money is not this worker's business: the gateway's native per-model usage charges the
 * payer while a case runs (just-in-time), and D1 keeps the accounting receipt. This worker
 * therefore never reserves, charges or releases credit; it reports what the durable rows say
 * and publishes alias pins.
 *
 * Case slots come from {@link PaidBenchmarkPlan}, which is frozen with the quote: a pool
 * edit, a case-dataset deploy or an alias move can only invalidate a quote, never change
 * what an already-confirmed one measures.
 */
import {
  BENCHMARK_PLATFORM_PROJECT_ID,
  BENCHMARK_USAGE_RECEIPTS_PATH,
  BenchmarkUsageReceiptResponseSchema,
  PAID_BENCHMARK_PATH,
  PaidBenchmarkWorkerRequestSchema,
  benchmarkProjectId,
  type CustomRouterBenchmarkContext,
  type PaidBenchmarkProgress,
  type PaidBenchmarkQuote,
  type PaidBenchmarkStartResult,
} from '@kilocode/auto-routing-contracts';
import type { Hono } from 'hono';
import { fetchBenchmarkModelCatalog, catalogModelVariants } from './platform-models';
import type { HonoEnv } from './hono-env';
import {
  BenchmarkPaidPlanError,
  computeEngineIdentity,
  deliverPaidCaseCancellations,
  startPaidRequestRun,
} from './run';
import {
  acceptPaidAttemptUsageStatements,
  activatePaidBenchmarkRequestStatements,
  completePaidBenchmarkRequestStatements,
  createPaidBenchmarkQuote,
  enqueuePaidCaseBatchStatements,
  enqueuePaidPoolPinsStatement,
  failPaidBenchmarkRequestStatements,
  markPaidCaseReusedStatements,
  paidCaseRunId,
  paidUnfundedStopOutcome,
  pausePaidBenchmarkRequestStatements,
  pausePaidUnfundedCaseStatements,
  readPaidCaseRun,
  readPaidBenchmarkProgress,
  readPaidBenchmarkQuote,
  readPaidBenchmarkRequest,
  startPaidBenchmarkRequestStatements,
  syncPaidRequestCaseDisplayStatements,
  type PaidBenchmarkRequestRow,
  type PaidCaseKey,
  type PaidCreditOwner,
} from './paid-case-store';
import {
  PaidBenchmarkPlanSchema,
  SERVING_EVIDENCE_GONE_REASON,
  buildPaidBenchmarkPlan,
  isPinOnlyPlan,
  ownerOf,
  planSlotAt,
  planSlotCount,
  planSlotIsCovered,
  planSlotIsMissing,
  planSlotKey,
  readOpenCaseRuns,
  readPairPendingOutputs,
  readPairStoredDraws,
  readPlatformRequestedPairs,
  readServingPairsStillReady,
  stableStringify,
  type PaidBenchmarkPlan,
} from './paid-benchmark-plan';
import { drainPaidBillingOutbox } from './paid-billing';
import { D1_MAX_BOUND_PARAMETERS } from './d1-limits';
import { minimumCaseRevisions } from './measurement-revision';
import { variantFromStorage } from './reasoning-effort';

/** How long a displayed quote stays confirmable. */
export const PAID_QUOTE_TTL_MS = 30 * 60 * 1000;
/**
 * Slots a staging slice may name, from D1's bound-parameter ceiling rather than picked.
 *
 * Every slice statement binds a fixed clause plus one value per *distinct case* it names plus
 * one per repetition, so the parameter cost is `fixed + cases + reps`:
 *
 * - `STAGE_SLICE_FIXED_BINDINGS` = 6: `paidReuseDrawsSql`/`paidPendingOutputsSql` bind router,
 *   engine, repetitions, model and variant before their filters; `readOpenCaseRuns` binds
 *   engine, model and variant.
 * - one case binding per slot at most: a slice names at most one distinct case per slot, which
 *   is exact for frontier (1 repetition) and amortised for efficient (3 slots per case).
 * - `STAGE_SLICE_MAX_REPETITION_BINDINGS` = 5: the policy schema caps decider repetitions at
 *   5, so a slice binds at most that many repetition values.
 * - `STAGE_SLICE_MINIMUM_MAP_BINDINGS` = 1: the minimum-revision map is one JSON binding.
 *
 * So a slice is `floor((100 - 6 - 5 - 1) / 1) = 88` slots: frontier binds 6 + 88 + 1 + 1 = 96
 * and efficient 6 + 30 + 3 + 1 = 40, each with margin under the ceiling.
 */
const STAGE_SLICE_FIXED_BINDINGS = 6;
const STAGE_SLICE_MAX_REPETITION_BINDINGS = 5;
const STAGE_SLICE_MINIMUM_MAP_BINDINGS = 1;
/** Slots per staging batch, from the arithmetic above (88). */
const STAGE_BATCH_SLOTS =
  D1_MAX_BOUND_PARAMETERS -
  STAGE_SLICE_FIXED_BINDINGS -
  STAGE_SLICE_MAX_REPETITION_BINDINGS -
  STAGE_SLICE_MINIMUM_MAP_BINDINGS;
/** Slots one request or one browser poll may stage, so a maximal pool is paged, not dumped. */
const STAGE_BUDGET_SLOTS = 400;
/**
 * Slots the one-minute tick stages across all of its live `preparing` requests.
 *
 * Sized from the widest real pool rather than from one request: a saved pool holds up to 20
 * entries and each expands into one concrete pair per catalog reasoning variant, so a large
 * efficient pool plans tens of pairs. At the measured 597 cases × 3 repetitions that is 121,788
 * slots for the widest quotable pool, and the old 80 slots a minute needed hours, so a large
 * pool could only activate while the browser kept polling. 4,400 slots stage that plan in about
 * 28 minutes — a 2.2× margin inside {@link STAGE_ABANDON_MS} — in 50 batches of 88, and keep
 * the whole tick measured by `scheduled-tick-budget.test.ts` under 700 of the 1,000 queries one
 * Worker invocation may send to D1.
 */
const CRON_STAGE_BUDGET_SLOTS = 4_400;
/**
 * The most a tick gives one request even when it is the only one: the budget itself. A fixed
 * floor above this is impossible (it would raise the tick's total) and a fixed cap below the
 * fair share would starve a lone wide plan, so a lone request simply takes the whole budget.
 */
const CRON_STAGE_MAX_SLOTS_PER_REQUEST = CRON_STAGE_BUDGET_SLOTS;
/**
 * Live requests one tick will stage or settle. One live request per saved pool is the unique
 * index's rule, and the pool cap per owner bounds the realistic population (10 pools × owners,
 * far below this), so the bound exists only to keep one invocation's query count predictable;
 * the scan is stalest-first, so a request beyond it is served first next tick rather than
 * starved.
 */
const CRON_STAGE_MAX_REQUESTS_PER_TICK = 50;
/**
 * A request whose staging makes no progress for this long is closed, never left dangling.
 * Measured from the last slot actually staged (`last_staged_at`, else creation) on a tick that
 * offered the request budget, so a request that waited for the shared budget is not closed.
 */
const STAGE_ABANDON_MS = 60 * 60 * 1000;
/** A deferred native usage row lags its response by a moment; poll briefly, then disclose. */
const RECEIPT_POLL_DELAYS_MS = [250, 500, 1_000];

type PaidBenchmarkEnv = HonoEnv['Bindings'];

type RequestCounts = {
  total: number;
  queued: number;
  running: number;
  done: number;
  reused: number;
  failed: number;
  paused: number;
};

async function readRequestCounts(db: D1Database, requestId: string): Promise<RequestCounts> {
  const rows = await db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM paid_benchmark_request_cases
      WHERE request_id = ? GROUP BY status`
    )
    .bind(requestId)
    .all<{ status: string; count: number }>();
  const counts: RequestCounts = {
    total: 0,
    queued: 0,
    running: 0,
    done: 0,
    reused: 0,
    failed: 0,
    paused: 0,
  };
  for (const row of rows.results) {
    const count = Number(row.count);
    counts.total += count;
    if (row.status !== 'total' && row.status in counts)
      counts[row.status as Exclude<keyof RequestCounts, 'total'>] += count;
  }
  return counts;
}

/** The most recent request for one saved pool, which is what a progress read without an id means. */
async function readLatestRequest(
  db: D1Database,
  owner: PaidCreditOwner,
  routerId: string
): Promise<PaidBenchmarkRequestRow | null> {
  return db
    .prepare(
      `SELECT * FROM paid_benchmark_requests
      WHERE owner_type = ? AND owner_id = ? AND router_id = ?
      ORDER BY created_at DESC LIMIT 1`
    )
    .bind(owner.ownerType, owner.ownerId, routerId)
    .first<PaidBenchmarkRequestRow>();
}

/**
 * The request currently holding this pool's only live-request slot, if any. One live request
 * per saved pool is the unique index's own rule, so this is the same predicate, read as a row.
 */
async function readLiveRequest(
  db: D1Database,
  owner: PaidCreditOwner,
  routerId: string
): Promise<PaidBenchmarkRequestRow | null> {
  return db
    .prepare(
      `SELECT * FROM paid_benchmark_requests
      WHERE owner_type = ? AND owner_id = ? AND router_id = ?
        AND status IN ('preparing', 'active')
      ORDER BY created_at DESC LIMIT 1`
    )
    .bind(owner.ownerType, owner.ownerId, routerId)
    .first<PaidBenchmarkRequestRow>();
}

function decodePlan(plan: string): PaidBenchmarkPlan | null {
  const parsed = PaidBenchmarkPlanSchema.safeParse(JSON.parse(plan));
  return parsed.success ? parsed.data : null;
}

function requestOwnedBy(
  request: PaidBenchmarkRequestRow,
  owner: PaidCreditOwner,
  routerId: string
): boolean {
  return (
    request.owner_type === owner.ownerType &&
    request.owner_id === owner.ownerId &&
    request.router_id === routerId
  );
}

export type PaidStageOutcome =
  | { status: 'staged'; staged: number; total: number; complete: boolean }
  | { status: 'aborted'; reason: string };

/**
 * Stage the next bounded slice of a plan. Every slot is written once and the next slice is
 * the row count, so concurrent or replayed staging is idempotent: a slot with its progress
 * row already present is a no-op under the request-case primary key.
 *
 * A slot the quote classified as platform-covered must still have its sticky platform case
 * run. A slot the quote promised for free must still have a valid stored draw. If either
 * changed, staging stops and asks for a new quote instead of measuring something the owner
 * never approved.
 */
export async function stagePaidBenchmarkRequest(
  env: PaidBenchmarkEnv,
  request: PaidBenchmarkRequestRow,
  plan: PaidBenchmarkPlan,
  options: { budgetSlots?: number; now?: number } = {}
): Promise<PaidStageOutcome> {
  const db = env.BENCH_DB;
  const total = planSlotCount(plan);
  if (request.plan_cases !== total)
    return {
      status: 'aborted',
      reason: 'The quoted case set does not match this pool; request a new estimate.',
    };
  // A pin-move quote promises every slot as an already-served reuse: the pin may only move onto
  // a target whose ready profile still exists. Re-read exactly those pairs before the first
  // write, so a measurement that disappeared between quote and click refuses instead of
  // enqueuing a pin onto evidence that is gone. A request that already staged a slot is past
  // that decision, so the check is skipped on a resumed or replayed staging pass. It reads the
  // plan's own pairs only and creates no measurement.
  const minimums = minimumCaseRevisions(plan.router, plan.revision);
  let budget = options.budgetSlots ?? STAGE_BUDGET_SLOTS;
  let counts = await readRequestCounts(db, request.id);
  if (counts.total === 0 && isPinOnlyPlan(plan) && !(await readServingPairsStillReady(db, plan)))
    return { status: 'aborted', reason: SERVING_EVIDENCE_GONE_REASON };
  while (counts.total < total && budget > 0) {
    const start = counts.total;
    // The slice is the smaller of one D1-bound batch and what this request still has budget
    // for, so a tick can never stage past the share it was offered.
    const sliceSize = Math.min(STAGE_BATCH_SLOTS, budget, total - start);
    const slice: { pairIndex: number; caseIndex: number; rep: number }[] = [];
    for (let index = start; index < start + sliceSize; index += 1) {
      const slot = planSlotAt(plan, index);
      if (slot) slice.push(slot);
    }
    if (slice.length === 0) break;

    const byPairIndex = new Map<number, typeof slice>();
    for (const slot of slice) {
      const group = byPairIndex.get(slot.pairIndex) ?? [];
      group.push(slot);
      byPairIndex.set(slot.pairIndex, group);
    }
    const statements: D1PreparedStatement[] = [];
    for (const [pairIndex, group] of byPairIndex) {
      const pair = plan.pairs[pairIndex];
      if (!pair) throw new Error('paid benchmark plan slice lost its pair');
      if (pair.serving) {
        // The quote recorded this pair as already serving: every slot is a free reuse and the
        // store is never asked about it, so a v3 probe draw or a new revision cannot create a
        // new measured job here.
        for (const slot of group)
          statements.push(
            ...markPaidCaseReusedStatements(db, {
              key: planSlotKey(plan, slot),
              requestId: request.id,
              coveredByKilo: false,
              now: options.now,
            })
          );
        continue;
      }
      const resolvedPair = { model: pair.model, variant: variantFromStorage(pair.variant) };
      const sliceCaseIds = [
        ...new Set(group.map(slot => plan.caseIds[slot.caseIndex] ?? '')),
      ].filter(caseId => caseId !== '');
      const sliceReps = [...new Set(group.map(slot => slot.rep))];
      const [draws, runs, pendings] = await Promise.all([
        readPairStoredDraws(db, {
          router: plan.router,
          engineIdentity: plan.engineIdentity,
          repetitions: plan.repetitions,
          pair: resolvedPair,
          minimumRevisions: minimums,
          caseIds: sliceCaseIds,
          reps: sliceReps,
        }),
        readOpenCaseRuns(db, {
          engineIdentity: plan.engineIdentity,
          pair: resolvedPair,
          caseIds: sliceCaseIds,
          reps: sliceReps,
        }),
        readPairPendingOutputs(db, {
          router: plan.router,
          engineIdentity: plan.engineIdentity,
          repetitions: plan.repetitions,
          pair: resolvedPair,
          minimumRevisions: minimums,
          caseIds: sliceCaseIds,
          reps: sliceReps,
        }),
      ]);
      const caseIndexById = new Map(plan.caseIds.map((caseId, index) => [caseId, index]));
      // Only a valid stored draw proves a result exists. The case-run `result_usable` flag
      // carries no revision and is not cleared by a later invalidation, so the canonical
      // draw query (minimum revision + invalidation) is the reuse authority.
      const reusable = new Set<number>();
      for (const draw of draws) {
        const caseIndex = caseIndexById.get(draw.case_id);
        if (caseIndex !== undefined) reusable.add(caseIndex * plan.repetitions + draw.rep);
      }
      // Same live source as the quote: a recoverable pending output is adopted and graded by
      // the run, so it must never be staged as a new paid measurement.
      for (const pending of pendings) {
        const caseIndex = caseIndexById.get(pending.case_id);
        if (caseIndex !== undefined) reusable.add(caseIndex * plan.repetitions + pending.rep);
      }
      const openBySlot = new Map(
        runs
          .filter(run => run.status === 'queued' || run.status === 'running')
          .flatMap(run => {
            const caseIndex = caseIndexById.get(run.case_id);
            return caseIndex === undefined
              ? []
              : [[caseIndex * plan.repetitions + run.rep, run] as const];
          })
      );

      const measurable: PaidCaseKey[] = [];
      const reusedSlots: { key: PaidCaseKey; covered: boolean }[] = [];
      for (const slot of group) {
        const key = planSlotKey(plan, slot);
        const bit = slot.caseIndex * plan.repetitions + slot.rep;
        const missingSlot = planSlotIsMissing(plan, slot.pairIndex, slot.caseIndex, slot.rep);
        const covered = planSlotIsCovered(plan, slot.pairIndex, slot.caseIndex, slot.rep);
        if (!missingSlot) {
          if (!reusable.has(bit))
            return {
              status: 'aborted',
              reason: `A reused result for ${pair.model} is no longer available; request a new estimate.`,
            };
          reusedSlots.push({ key, covered });
          continue;
        }
        if (reusable.has(bit)) {
          reusedSlots.push({ key, covered });
          continue;
        }
        if (covered) {
          // The quote promised this slot as Kilo-paid. Revalidate against the same durable
          // source the quote used — a latched case run *or* live platform ownership of the
          // pair at this engine/repetition count — and refuse rather than charge silently if
          // coverage is gone.
          const open = openBySlot.get(bit);
          if (!open || open.platform_covered !== 1) {
            const platformOwned = await readPlatformRequestedPairs(db, {
              router: plan.router,
              engineIdentity: plan.engineIdentity,
              repetitions: plan.repetitions,
              pairs: [resolvedPair],
            });
            if (platformOwned.size === 0)
              return {
                status: 'aborted',
                reason: `Kilo platform coverage for ${pair.model} changed; request a new estimate.`,
              };
          }
          // The platform pays this case run; the request only displays it as covered. The
          // approved covered bit travels with the slot: even if platform membership falls
          // between staging and the permit, the store's selection/admit guard refuses to make
          // this plan the payer, so the slot can never become a silent user charge.
          statements.push(
            ...enqueuePaidCaseBatchStatements(db, {
              requestId: request.id,
              cases: [{ ...key, coveredByKilo: true }],
              // The same canonical eligibility the planner applied: without it the store's
              // reuse predicate could advertise a pre-invalidation or below-minimum draw as
              // free work the controller never agreed to reuse.
              eligibility: {
                router: plan.router,
                engineIdentity: plan.engineIdentity,
                minimumRevisions: minimums,
              },
              reclaim: true,
              now: options.now,
            })
          );
          continue;
        }
        measurable.push(key);
      }
      if (measurable.length > 0)
        statements.push(
          ...enqueuePaidCaseBatchStatements(db, {
            requestId: request.id,
            cases: measurable,
            eligibility: {
              router: plan.router,
              engineIdentity: plan.engineIdentity,
              minimumRevisions: minimums,
            },
            reclaim: true,
            now: options.now,
          })
        );
      for (const reused of reusedSlots)
        statements.push(
          ...markPaidCaseReusedStatements(db, {
            key: reused.key,
            requestId: request.id,
            coveredByKilo: reused.covered,
            now: options.now,
          })
        );
    }
    await db.batch(statements);
    budget -= slice.length;
    counts = await readRequestCounts(db, request.id);
  }
  return {
    status: 'staged',
    staged: counts.total,
    total,
    complete: counts.total >= total,
  };
}

/**
 * Make a fully staged request dispatchable. The store requires the staged count to equal the
 * approved plan's case count, so activation is never derived from a partially written plan.
 */
async function activateIfFullyStaged(
  env: PaidBenchmarkEnv,
  request: PaidBenchmarkRequestRow,
  plan: PaidBenchmarkPlan,
  now?: number
): Promise<PaidBenchmarkRequestRow> {
  if (request.status !== 'preparing') return request;
  const counts = await readRequestCounts(env.BENCH_DB, request.id);
  if (counts.total < planSlotCount(plan)) return request;
  await env.BENCH_DB.batch(
    activatePaidBenchmarkRequestStatements(env.BENCH_DB, { requestId: request.id, now })
  );
  const activated = (await readPaidBenchmarkRequest(env.BENCH_DB, request.id)) ?? request;
  if (activated.status !== 'active') return activated;
  // Activation is what admits the pre-planned work: the paid run measures exactly the staged
  // slots of this explicitly confirmed request. Idempotent by its deterministic run id, so a
  // retryable failure is retried by the next reconcile instead of starting anything twice.
  await launchPaidRun(env, activated.id);
  return (await readPaidBenchmarkRequest(env.BENCH_DB, activated.id)) ?? activated;
}

/**
 * Start one paid request's run and classify a failure, so an `active` request can never sit
 * forever with no run and no reason.
 *
 * - `started`: a run exists for this request.
 * - `attached`: every pair is claimed by another live run (`pairs_claimed`); the cases are
 *   being measured and this request will reuse them. Not a failure.
 * - `retryable`: the launch threw. That is infrastructure (storage, queue wake), so the
 *   request stays `active` and the next reconcile retries the same deterministic run id.
 * - `failed`: the launcher declined to create the run for a reason retrying cannot fix. The
 *   request is failed with a non-retryable reason so the owner sees it.
 *
 * The launch is scoped to this request's own deterministic run id, so no sibling request's
 * funded work is touched by any of these outcomes.
 */
async function launchPaidRun(
  env: PaidBenchmarkEnv,
  requestId: string
): Promise<'started' | 'attached' | 'retryable' | 'failed'> {
  let outcome: Awaited<ReturnType<typeof startPaidRequestRun>>;
  try {
    outcome = await startPaidRequestRun(env, requestId);
  } catch (error) {
    // Only a typed refusal of THIS request's frozen plan is permanent: the same plan will be
    // refused forever, so retrying only hides it. Missing config, a non-bot executor override
    // and storage faults are NOT this type, so they stay retryable until they are fixed.
    if (error instanceof BenchmarkPaidPlanError) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_paid_run_config_refused',
          requestId,
          error: error.message,
        })
      );
      // The refusal is only visible if the row actually transitions. A failed write leaves the
      // request active with its durable work intact, so report retryable and let the next pass
      // retry both the write and the classification.
      const written = await env.BENCH_DB.batch(
        failPaidBenchmarkRequestStatements(env.BENCH_DB, {
          requestId,
          reason: error.message,
          retryable: false,
        })
      ).then(
        result => Number(result[0]?.meta.changes ?? 0) > 0,
        () => false
      );
      if (!written) {
        console.warn(JSON.stringify({ event: 'benchmark_paid_plan_refusal_unsaved', requestId }));
        return 'retryable';
      }
      return 'failed';
    }
    console.warn(
      JSON.stringify({
        event: 'benchmark_paid_run_start_failed',
        requestId,
        error: error instanceof Error ? error.message : 'unknown',
      })
    );
    return 'retryable';
  }
  if (outcome.runId !== null) return 'started';
  if (outcome.skipped.includes('pairs_claimed')) return 'attached';
  // Every other skip is benign for this request: it is already settled (`nothing_left`,
  // `already_ready`), not live (`request_not_active` — including a request a reconcile guard
  // just failed, which is durable and terminal), already launched (`run_exists`), or waiting on
  // capacity (`queue_full`). None of them strand the request, so none of them is a failure — a
  // later reconcile resumes or the request settles on its own.
  return 'attached';
}

/**
 * Complete or fail a request whose every staged slot reached a terminal state, and queue the
 * pool-pin notification on the durable outbox. A fully reused request completes without ever
 * running anything; only a completed request pins anything.
 */
export async function finishPaidBenchmarkRequest(
  env: PaidBenchmarkEnv,
  request: PaidBenchmarkRequestRow,
  plan: PaidBenchmarkPlan,
  options: { now?: number } = {}
): Promise<PaidBenchmarkRequestRow | null> {
  if (request.status !== 'active') return request;
  // Display rows follow the canonical runs before anything is counted. A case that has
  // conclusively finished unusable is already terminal, so without this the request would
  // wait forever on a `queued` row nobody can measure again.
  await env.BENCH_DB.batch(
    syncPaidRequestCaseDisplayStatements(env.BENCH_DB, { requestId: request.id, now: options.now })
  );
  const counts = await readRequestCounts(env.BENCH_DB, request.id);
  if (counts.total < planSlotCount(plan)) return request;
  if (counts.queued > 0 || counts.running > 0) return request;
  if (counts.done + counts.reused > 0) {
    await env.BENCH_DB.batch([
      ...completePaidBenchmarkRequestStatements(env.BENCH_DB, {
        requestId: request.id,
        now: options.now,
      }),
      enqueuePaidPoolPinsStatement(env.BENCH_DB, { requestId: request.id, now: options.now }),
    ]);
  } else {
    await env.BENCH_DB.batch(
      failPaidBenchmarkRequestStatements(env.BENCH_DB, {
        requestId: request.id,
        reason: 'No case produced a usable result.',
        retryable: true,
        now: options.now,
      })
    );
  }
  return readPaidBenchmarkRequest(env.BENCH_DB, request.id);
}

/**
 * Read a request's progress, advancing its durable continuation first: stage the next slice,
 * activate once fully staged, and settle when every slot is terminal. This never creates a
 * request; it only continues one the owner already confirmed.
 */
async function progressFor(
  env: PaidBenchmarkEnv,
  request: PaidBenchmarkRequestRow,
  plan: PaidBenchmarkPlan,
  options: { cursor?: string; budgetSlots?: number; now?: number }
): Promise<PaidBenchmarkProgress> {
  let current = request;
  if (current.status === 'preparing') {
    const staged = await stagePaidBenchmarkRequest(env, current, plan, {
      budgetSlots: options.budgetSlots,
      now: options.now,
    });
    if (staged.status === 'aborted') {
      await env.BENCH_DB.batch(
        failPaidBenchmarkRequestStatements(env.BENCH_DB, {
          requestId: current.id,
          reason: staged.reason,
          retryable: true,
          now: options.now,
        })
      );
      current = (await readPaidBenchmarkRequest(env.BENCH_DB, current.id)) ?? current;
    } else current = await activateIfFullyStaged(env, current, plan, options.now);
  }
  await finishPaidBenchmarkRequest(env, current, plan, { now: options.now });
  return readPaidBenchmarkProgress(env.BENCH_DB, {
    requestId: request.id,
    cursor: options.cursor,
  });
}

/** The quoted alias targets must still resolve to what the quote priced. */
async function aliasesStillConfirmed(
  env: PaidBenchmarkEnv,
  plan: PaidBenchmarkPlan,
  fetchImpl: typeof fetch
): Promise<boolean | null> {
  if (plan.aliases.length === 0) return true;
  let catalog;
  try {
    catalog = await fetchBenchmarkModelCatalog(
      { KILO_WEB_API_BASE_URL: env.KILO_WEB_API_BASE_URL },
      fetchImpl
    );
  } catch {
    return null;
  }
  return plan.aliases.every(
    alias => catalogModelVariants(catalog, alias.model)?.model === alias.target
  );
}

async function startPaidBenchmark(
  env: PaidBenchmarkEnv,
  input: {
    quoteId: string;
    actorUserId: string;
    ownerType: 'user' | 'org';
    ownerId: string;
    routerId: string;
    poolSlug: string;
    poolVersion: string;
    context: CustomRouterBenchmarkContext;
  },
  options: { fetchImpl?: typeof fetch; now?: number } = {}
): Promise<PaidBenchmarkStartResult> {
  const db = env.BENCH_DB;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const owner = ownerOf(input.ownerType, input.ownerId);
  const quote = await readPaidBenchmarkQuote(db, input.quoteId);
  if (!quote) return { status: 'quote_mismatch', reason: 'quote_not_found' };
  if (
    quote.owner_type !== owner.ownerType ||
    quote.owner_id !== owner.ownerId ||
    quote.router_id !== input.routerId
  )
    return { status: 'quote_mismatch', reason: 'quote_not_owned' };
  const plan = decodePlan(quote.plan);
  if (!plan || plan.engineIdentity !== quote.engine_identity)
    return { status: 'quote_mismatch', reason: 'plan_unreadable' };
  if (planSlotCount(plan) !== quote.plan_cases)
    return { status: 'quote_mismatch', reason: 'plan_cases_changed' };
  // Identity only: `pool_version` is `customRouterPoolIdentity`, a hash of exactly the
  // measurement identity (base router, default entry, and each entry's model / measuredAs /
  // provider / variants, sorted by entry key). Owner and router id are NOT part of it; they
  // are checked independently above, before this comparison. It deliberately excludes
  // `servingPin`, pricing, capabilities and `updated_at`, so a settlement publishing a pin
  // (or a no-op client re-registration) no longer invalidates a valid quote. The raw
  // context is still stored for progress and table reads; comparing it here would make a
  // pin-only write read as `pool_changed`. A genuine alias → concrete move changes the
  // identity, so that mismatch is preserved.
  if (quote.pool_version !== input.poolVersion)
    return { status: 'quote_mismatch', reason: 'pool_changed' };
  // The project id is frozen in the plan; the authenticated slug and router must still derive
  // exactly it, so a replayed quote can never attribute usage to another pool's project.
  if (
    plan.projectId !==
    benchmarkProjectId({
      scope: input.ownerType,
      slug: input.poolSlug,
      routerId: input.routerId,
    })
  )
    return { status: 'quote_mismatch', reason: 'project_changed' };
  if (quote.engine_identity !== computeEngineIdentity('decider', plan.router))
    return { status: 'quote_mismatch', reason: 'engine_changed' };

  // A retry of the same click reconciles the durable intent instead of starting again.
  if (quote.started_request_id) {
    const existing = await readPaidBenchmarkRequest(db, quote.started_request_id);
    if (!existing || !requestOwnedBy(existing, owner, input.routerId))
      return { status: 'quote_mismatch', reason: 'quote_already_used' };
    return {
      status: 'started',
      request: await progressFor(env, existing, plan, { now }),
    };
  }
  if (Date.parse(quote.expires_at) <= now) return { status: 'quote_expired' };

  const aliases = await aliasesStillConfirmed(env, plan, fetchImpl);
  if (aliases === null)
    return {
      status: 'blocked',
      reason: 'Benchmark model catalog is unavailable.',
      retryable: true,
    };
  if (!aliases) return { status: 'quote_mismatch', reason: 'alias_moved' };
  // A pin-move quote's whole promise is that every pair is already served. If that ready
  // evidence disappeared after the quote, refuse before consuming the quote so the owner
  // neither spends nor pins onto a target with no usable measurement; a fresh estimate is the
  // only way forward. This reads the plan's own pairs and creates no measurement.
  if (isPinOnlyPlan(plan) && !(await readServingPairsStillReady(db, plan)))
    return { status: 'blocked', reason: SERVING_EVIDENCE_GONE_REASON, retryable: true };

  const requestId = crypto.randomUUID();
  const created = await db.batch(
    startPaidBenchmarkRequestStatements(db, {
      quoteId: quote.id,
      requestId,
      actorUserId: input.actorUserId,
      now,
    })
  );
  const consumed = Number(created[0]?.meta.changes ?? 0) > 0;
  const inserted = Number(created[1]?.meta.changes ?? 0) > 0;
  if (!consumed || !inserted) {
    // Two explicit clicks of the same quote race here. The loser must behave like a retry of
    // the winner, not like a failure: same owner and router returns the same request, and a
    // competing quote in another live request is reported as an active conflict without
    // consuming that request's quote.
    const reread = await readPaidBenchmarkQuote(db, quote.id);
    if (!reread) return { status: 'quote_mismatch', reason: 'quote_not_found' };
    if (reread.started_request_id) {
      const winner = await readPaidBenchmarkRequest(db, reread.started_request_id);
      if (winner && requestOwnedBy(winner, owner, input.routerId))
        return {
          status: 'started',
          request: await progressFor(env, winner, plan, { now }),
        };
      return {
        status: 'blocked',
        reason: 'Another request already used this estimate.',
        retryable: false,
      };
    }
    if (Date.parse(reread.expires_at) <= now) return { status: 'quote_expired' };
    // This pool already has a live request (one live-request slot per pool): another tab, or
    // a quote taken before that request existed. Report it as such and continue it — staging
    // that request is the only useful work, and nothing new is created, priced or charged.
    // It continues with its OWN frozen plan: the second start's quote may name a different
    // case set, and staging the live request against it would abort work the owner approved.
    const live = await readLiveRequest(db, owner, input.routerId);
    if (live) {
      const liveQuote = await readPaidBenchmarkQuote(db, live.quote_id);
      const livePlan = liveQuote ? decodePlan(liveQuote.plan) : null;
      if (!livePlan) return { status: 'quote_mismatch', reason: 'live_plan_unreadable' };
      return {
        status: 'started',
        request: await progressFor(env, live, livePlan, { now }),
        alreadyInProgress: true,
      };
    }
    return { status: 'quote_mismatch', reason: 'quote_not_consumed' };
  }

  const request = await readPaidBenchmarkRequest(db, requestId);
  if (!request)
    return { status: 'blocked', reason: 'Benchmark request was not stored.', retryable: true };
  const staged = await stagePaidBenchmarkRequest(env, request, plan, {
    budgetSlots: STAGE_BUDGET_SLOTS,
    now,
  });
  if (staged.status === 'aborted') {
    await db.batch(
      failPaidBenchmarkRequestStatements(db, {
        requestId,
        reason: staged.reason,
        retryable: true,
        now,
      })
    );
    return { status: 'blocked', reason: staged.reason, retryable: true };
  }
  const current = (await readPaidBenchmarkRequest(db, requestId)) ?? request;
  return {
    status: 'started',
    request: await progressFor(env, current, plan, { now }),
  };
}

async function pausePaidBenchmark(
  env: PaidBenchmarkEnv,
  input: {
    ownerType: 'user' | 'org';
    ownerId: string;
    routerId: string;
    requestId?: string;
    now?: number;
    fetchImpl?: typeof fetch;
  }
): Promise<PaidBenchmarkProgress> {
  const owner = ownerOf(input.ownerType, input.ownerId);
  // A pool-edit/delete fence does not know the request id: it pauses the owner's latest
  // request for this router. This read path never stages or advances a plan — it resolves the
  // row and pauses it atomically (or reports nothing live), which is exactly what the web
  // needs before committing an edit.
  const request = input.requestId
    ? await readPaidBenchmarkRequest(env.BENCH_DB, input.requestId)
    : await readLatestRequest(env.BENCH_DB, owner, input.routerId);
  if (!request || !requestOwnedBy(request, owner, input.routerId)) return { status: 'empty' };
  // Nothing live to pause: the caller's fence is satisfied ("pause either paused it or
  // there was nothing active") and no D1 plan or case row is touched.
  if (request.status !== 'preparing' && request.status !== 'active') return { status: 'empty' };
  await env.BENCH_DB.batch(
    pausePaidBenchmarkRequestStatements(env.BENCH_DB, {
      requestId: request.id,
      reason: 'owner',
      now: input.now,
    })
  );
  // The pause is already committed: the store fenced the payer set and wrote the durable
  // cancellation intents in the same batch. Signalling the live runner is best effort: the
  // scheduler's narrow delivery touches nothing but `cancelDeciderCase`, so it cannot start a
  // job, and a container failure only defers the intent for the next pass. A delivery error
  // therefore never fails the committed pause.
  try {
    await deliverPaidCaseCancellations(env, { requestId: request.id });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'benchmark_paid_pause_cancel_delivery_failed',
        requestId: request.id,
        error: error instanceof Error ? error.message : 'unknown',
      })
    );
  }
  return readPaidBenchmarkProgress(env.BENCH_DB, { requestId: request.id });
}

/**
 * Reconcile native usage receipts for a bounded set of admitted model requests.
 *
 * A model request is admitted before inference, so a usage id can be deferred while the
 * native writer commits. This pass asks the authoritative primary gateway read for exactly
 * those ids: `recorded` is written to D1 as an accounting receipt (`acceptPaidModelRequest
 * UsageStatements`, idempotent per usage id); `pending` is left pending and disclosed, never
 * treated as free and never retried as a second charge. A receipt whose identity or amount
 * does not match the signed assignment is refused rather than booked.
 */
export async function reconcilePaidUsageReceipts(
  // Reads only these three bindings, so a caller can pass its own narrower Worker env.
  env: Pick<PaidBenchmarkEnv, 'BENCH_DB' | 'KILO_WEB_API_BASE_URL' | 'INTERNAL_API_SECRET_PROD'>,
  options: {
    limit?: number;
    fetchImpl?: typeof fetch;
    now?: number;
    /** Exact model requests to inspect (the bounded per-payer path); omitted = fair scan. */
    modelRequestIds?: readonly string[];
    /** Caller's abort, e.g. a disconnected request: stops the pass, including awaits. */
    signal?: AbortSignal;
    /** Hard wall-clock budget for this pass, awaited reads included. */
    deadline?: number;
  } = {}
): Promise<{ recorded: number; pending: number; mismatched: number }> {
  const db = env.BENCH_DB;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  // Fairness without a new lifecycle clock: `updated_at` is reused as "last inspected" and
  // is advanced after a row is looked at (never on lifecycle transitions alone), so the scan
  // is least-recently-checked first with a stable id tie-break. Continued new work cannot
  // starve an older unresolved receipt, and every inspected row — booked, pending,
  // mismatched or outage-skipped — moves to the back of the queue exactly once per pass.
  type AdmittedRow = {
    id: string;
    engine_identity: string;
    model: string;
    variant: string;
    rep: number;
    case_id: string;
    generation: number;
    pool_request_id: string | null;
    owner_type: 'user' | 'organization' | null;
    owner_id: string | null;
    platform_covered: number;
    usage_id: string;
    assignment_id: string | null;
    project_id: string | null;
    platform_organization_id: string | null;
  };
  const scopedIds = options.modelRequestIds;
  const admitted = scopedIds
    ? await db
        .prepare(
          `SELECT * FROM paid_model_requests
          WHERE state = 'admitted' AND usage_id IS NOT NULL AND assignment_id IS NOT NULL
            AND id IN (${scopedIds.map(() => '?').join(', ')})
          ORDER BY updated_at, id LIMIT ?`
        )
        .bind(...scopedIds, limit)
        .all<AdmittedRow>()
    : await db
        .prepare(
          `SELECT * FROM paid_model_requests
          WHERE state = 'admitted' AND usage_id IS NOT NULL AND assignment_id IS NOT NULL
          ORDER BY updated_at, id LIMIT ?`
        )
        .bind(limit)
        .all<AdmittedRow>();
  const summary = { recorded: 0, pending: 0, mismatched: 0 };
  if (admitted.results.length === 0) return summary;
  // The native writer commits the usage row in a deferred task after the response body
  // closes, so a first miss is `pending`, not free. Poll a bounded few times — bounded by the
  // caller's abort and budget too, so this never outlives the request that asked for it and
  // never sleeps past its deadline.
  const usageIds = admitted.results.map(row => row.usage_id);
  const fetchImpl = options.fetchImpl ?? fetch;
  const readOptions = { signal: options.signal, deadline: options.deadline };
  const remainingMs = () => (options.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  const spent = () => options.signal?.aborted === true || remainingMs() <= 0;
  let receipts = await readUsageReceipts(env, usageIds, fetchImpl, readOptions);
  for (const delayMs of RECEIPT_POLL_DELAYS_MS) {
    if (receipts === null) break;
    if (receipts.every(receipt => receipt.status === 'recorded')) break;
    if (spent()) break;
    const slept = Promise.withResolvers<void>();
    setTimeout(slept.resolve, Math.min(delayMs, Math.max(1, remainingMs())));
    await slept.promise;
    if (spent()) break;
    receipts = await readUsageReceipts(env, usageIds, fetchImpl, readOptions);
  }
  if (receipts === null) {
    // The receipt read is unavailable: nothing is booked and nothing is free, but every row
    // this pass looked at is still advanced so an outage cannot pin the scan to one window.
    await db
      .prepare(
        `UPDATE paid_model_requests SET updated_at = ?
        WHERE id IN (${admitted.results.map(() => '?').join(', ')}) AND state = 'admitted'`
      )
      .bind(new Date(options.now ?? Date.now()).toISOString(), ...admitted.results.map(r => r.id))
      .run();
    return summary;
  }
  const byUsageId = new Map(receipts.map(receipt => [receipt.usageId, receipt]));
  // Every inspected row is advanced exactly once at the end of this pass, whatever its
  // outcome, so the next pass starts with the rows this one did not reach. Only the
  // inspection clock moves; the row's lifecycle state and the store's own `updated_at`
  // ordering for settlement are untouched (receipt writes set their own timestamp).
  const inspected: string[] = [];
  for (const row of admitted.results) {
    inspected.push(row.id);
    const receipt = byUsageId.get(row.usage_id);
    // A recorded receipt with `microdollars: 0` is real: the gateway writes exactly that for
    // an admitted call the provider answered with a definitive error, and booking it is what
    // clears the payer's outstanding permit. Only a missing/pending row (null) stays pending.
    if (!receipt || receipt.status !== 'recorded' || receipt.microdollars === null) {
      // Not a payment refusal and not free: the row stays admitted and its receipt is never
      // written, so a late native write still books later and the case is never charged twice
      // or declared unfunded. Paused requests keep their receipts recoverable.
      summary.pending += 1;
      continue;
    }
    if (row.assignment_id === null) {
      // No assignment id means the store never finished selecting this attempt: it cannot be
      // booked, and it must not be reported as recorded.
      summary.pending += 1;
      continue;
    }
    const platformCovered = row.platform_covered === 1;
    // Exact association: the native row must be the signed payer (or the run's platform
    // organization), the frozen project, and the concrete model this call requested. A
    // mismatch is an anomaly to surface, never a booking. A row without a stamped project
    // cannot pass the store's own gate, so it is reported, not booked.
    if (row.project_id === null) {
      summary.mismatched += 1;
      continue;
    }
    const platformOrgId = platformCovered ? row.platform_organization_id : null;
    const expectedPayerType: 'user' | 'organization' | null = platformCovered
      ? 'organization'
      : row.owner_type;
    const expectedPayerId = platformCovered ? platformOrgId : row.owner_id;
    if (
      platformCovered &&
      (platformOrgId === null || row.project_id !== BENCHMARK_PLATFORM_PROJECT_ID)
    ) {
      summary.mismatched += 1;
      continue;
    }
    if (
      receipt.payerType !== expectedPayerType ||
      receipt.payerId !== expectedPayerId ||
      receipt.projectId !== row.project_id ||
      // The gateway writes `requested_model` lower-cased (llm-proxy.ts), while the signed
      // concrete model keeps its catalog casing. Compare against the writer's own form; the
      // exact D1 fence below still receives the raw signed `row.model`.
      receipt.requestedModel !== row.model.toLowerCase()
    ) {
      summary.mismatched += 1;
      continue;
    }
    const written = await db.batch(
      acceptPaidAttemptUsageStatements(db, {
        // The store keys receipts by the gateway assignment id, not the model request id.
        assignmentId: row.assignment_id,
        usageId: row.usage_id,
        microdollars: receipt.microdollars,
        expected: {
          owner: {
            ownerType: platformCovered
              ? 'organization'
              : row.owner_type === 'organization'
                ? 'organization'
                : 'user',
            ownerId: platformCovered ? (platformOrgId as string) : (row.owner_id as string),
          },
          model: row.model,
          variant: row.variant,
          caseId: row.case_id,
          generation: row.generation,
          projectId: row.project_id,
          // The store's covered branch compares the signed paying organization exactly;
          // omitting it makes every covered receipt match zero rows and never book.
          platformOrganizationId: platformCovered ? platformOrgId : null,
        },
        now: options.now,
      })
    );
    // Count only a receipt the store actually wrote; a replay or a stale row changes nothing
    // and must not be reported as newly recorded.
    if (Number(written[0]?.meta.changes ?? 0) > 0) summary.recorded += 1;
    else summary.pending += 1;
  }
  if (inspected.length > 0)
    await db
      .prepare(
        `UPDATE paid_model_requests SET updated_at = ?
        WHERE id IN (${inspected.map(() => '?').join(', ')}) AND state = 'admitted'`
      )
      .bind(new Date(options.now ?? Date.now()).toISOString(), ...inspected)
      .run();
  return summary;
}

/**
 * Reconcile the receipts of one payer, right before a fresh admission decision.
 *
 * The cron pass is not enough on its own: a payer's immediate next model call must see the
 * native balance its previous call already committed in PostgreSQL, or the store refuses the
 * next permit while the receipt is still pending locally. This is the same typed matcher and
 * the same store gate as the cron pass, scoped to one owner and bounded by `limit` — no global
 * scan, and nothing is booked that the receipt read does not report as `recorded`.
 */
export async function reconcilePaidPayerReceipts(
  // Only the bindings this path actually uses, so a caller can pass its own Worker env
  // without casting to this worker's full `Env`.
  env: Pick<PaidBenchmarkEnv, 'BENCH_DB' | 'KILO_WEB_API_BASE_URL' | 'INTERNAL_API_SECRET_PROD'>,
  input: {
    ownerType: 'user' | 'organization';
    ownerId: string;
    limit?: number;
    fetchImpl?: typeof fetch;
    now?: number;
    /** Caller's abort: a disconnected request must not keep reading receipts. */
    signal?: AbortSignal;
    /** Hard wall-clock budget for this pass, the native read included. */
    deadline?: number;
  }
): Promise<{ recorded: number; pending: number; mismatched: number }> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const ids = await env.BENCH_DB.prepare(
    `SELECT id FROM paid_model_requests
    WHERE state = 'admitted' AND usage_id IS NOT NULL AND assignment_id IS NOT NULL
      AND owner_type = ? AND owner_id = ?
    ORDER BY updated_at, id LIMIT ?`
  )
    .bind(input.ownerType, input.ownerId, limit)
    .all<{ id: string }>();
  if (ids.results.length === 0) return { recorded: 0, pending: 0, mismatched: 0 };
  return reconcilePaidUsageReceipts(env, {
    limit,
    fetchImpl: input.fetchImpl,
    now: input.now,
    modelRequestIds: ids.results.map(row => row.id),
    signal: input.signal,
    deadline: input.deadline,
  });
}

type UsageReceipt = {
  usageId: string;
  status: 'recorded' | 'pending';
  microdollars: number | null;
  payerType: 'user' | 'organization' | null;
  payerId: string | null;
  projectId: string | null;
  requestedModel: string | null;
  model: string | null;
  createdAt: string | null;
};

/** The authoritative receipt read (primary), or null when it cannot be reached. */
async function readUsageReceipts(
  env: Pick<PaidBenchmarkEnv, 'BENCH_DB' | 'KILO_WEB_API_BASE_URL' | 'INTERNAL_API_SECRET_PROD'>,
  usageIds: readonly string[],
  fetchImpl: typeof fetch,
  limits: { signal?: AbortSignal; deadline?: number } = {}
): Promise<UsageReceipt[] | null> {
  // The read itself is bounded by the caller's abort *and* whatever budget is left, so a slow
  // native read cannot outlive the request that asked for it. Without a caller budget the
  // original 10 s ceiling still applies.
  const remaining = (limits.deadline ?? Date.now() + 10_000) - Date.now();
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining)));
  const signal = limits.signal ? AbortSignal.any([limits.signal, timeout]) : timeout;
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  let response: Response;
  try {
    response = await fetchImpl(new URL(BENCHMARK_USAGE_RECEIPTS_PATH, env.KILO_WEB_API_BASE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-api-key': secret },
      body: JSON.stringify({ usageIds }),
      signal,
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const parsed = BenchmarkUsageReceiptResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  return parsed.success ? parsed.data.receipts : null;
}

/**
 * Stop the requests a typed payer refusal actually exhausted — and only those.
 *
 * Called by the runner's unfunded branch (and by the cron pass), in the same worker turn as
 * the run stop. A plan is paused with `no_funds` only when **every** case it still has
 * queued or running was refused and no other active request still pays that case run: a case
 * shared with a funded payer keeps running, and unrelated models/pools are untouched.
 *
 * Just-in-time billing means there is no hold to return: already-billed usage stays on the
 * request as its charged total, and no outbox release is written. A pause here is a billing
 * pause, distinct from an owner pause and from any infrastructure or receipt-pending state.
 */
/**
 * Stop the exact unfunded case slots a typed payer refusal exhausted.
 *
 * Delegates to the store's canonical `pausePaidUnfundedCaseStatements`: it needs the exact
 * case run generation (executor run/token) and a stable transition id, and it owns every
 * write in one batch — the case run stops only if no other active request pays it, that
 * request's case row is marked `paused` with the billing reason, and a request with no
 * remaining funded live case is paused as `no_funds`. Earlier charges and partial readiness
 * are preserved; nothing here closes, cancels or refunds.
 *
 * The caller supplies only the case keys the runner observed; `reason` keeps the caller's
 * typed code for the progress row, while the request-level pause reason stays `no_funds`.
 */
export async function pauseUnfundedPaidRequests(
  env: PaidBenchmarkEnv,
  input: {
    refusedCases: readonly {
      engineIdentity: string;
      model: string;
      variant: string;
      rep: number;
      caseId: string;
      /** The plan that could not pay; its own staged rows never count as an alternative. */
      funderRequestId: string;
    }[];
    reason: string;
    now?: number;
  }
): Promise<{ paused: string[]; kept: string[] }> {
  const db = env.BENCH_DB;
  const now = input.now ?? Date.now();
  const result = { paused: [] as string[], kept: [] as string[] };
  for (const refused of input.refusedCases) {
    const key = {
      engineIdentity: refused.engineIdentity,
      model: refused.model,
      variant: refused.variant,
      rep: refused.rep,
      caseId: refused.caseId,
    };
    // The canonical transition acts on one exact generation, so read the run first. A slot
    // that is no longer running (already settled, cancelled or paused) is not ours to stop.
    const run = await readPaidCaseRun(db, key);
    if (!run || run.status !== 'running' || !run.executor_run_id || !run.executor_token) continue;
    const generation = {
      runId: run.executor_run_id,
      token: run.executor_token,
      generation: run.generation,
    };
    // One stable transition id per (slot, generation): a replay of the same refusal is the
    // same stop, so the store's guarded statements change nothing the second time.
    const transitionId = `unfunded:${paidCaseRunId(key)}:${generation.generation}`;
    const batch = await db.batch(
      // The store's canonical pause reason is `no_funds`: it is what the request-level
      // guard matches to decide whether this plan still owns the slot. The runner's typed
      // refusal code is a diagnostic, not a D1 state value.
      pausePaidUnfundedCaseStatements(db, {
        key,
        generation,
        reason: 'no_funds',
        funderRequestId: refused.funderRequestId,
        transitionId,
        now,
      })
    );
    const outcome = paidUnfundedStopOutcome(batch);
    if (outcome.paused.length > 0 || outcome.kept.length > 0)
      console.log(
        JSON.stringify({
          event: 'benchmark_paid_case_unfunded_paused',
          caseId: refused.caseId,
          code: input.reason,
          paused: outcome.paused,
          kept: outcome.kept,
          caseRun: outcome.caseRun,
        })
      );
    for (const requestId of outcome.paused)
      if (!result.paused.includes(requestId)) result.paused.push(requestId);
    for (const requestId of outcome.kept)
      if (!result.kept.includes(requestId)) result.kept.push(requestId);
  }
  return result;
}

/**
 * Continue every live paid request: stage more slots, activate a fully staged one, settle a
 * finished one, and close a request that was never activated. It never creates a request, so
 * no retry, schedule or pool edit can start spending.
 */
export async function reconcilePaidBenchmarkRequests(
  env: PaidBenchmarkEnv,
  options: { now?: number; fetchImpl?: typeof fetch } = {}
): Promise<{ staged: number; completed: string[]; failed: string[]; closed: string[] }> {
  const db = env.BENCH_DB;
  const now = options.now ?? Date.now();
  const summary = {
    staged: 0,
    completed: [] as string[],
    failed: [] as string[],
    closed: [] as string[],
  };
  // Preparing requests are served stalest-first: the request that has gone longest without
  // staging a slot is the one this tick offers budget to, so a request can never be starved
  // behind newer work. Active requests are served in their own pass (they stage nothing), and
  // the scan is bounded to keep one invocation's query count predictable; the stalest-first
  // order is what makes that bound fair.
  const preparingRows = await db
    .prepare(
      `SELECT * FROM paid_benchmark_requests
      WHERE status = 'preparing'
      ORDER BY COALESCE(last_staged_at, created_at), id
      LIMIT ${CRON_STAGE_MAX_REQUESTS_PER_TICK}`
    )
    .all<PaidBenchmarkRequestRow>();
  const activeRows = await db
    .prepare(
      `SELECT * FROM paid_benchmark_requests
      WHERE status = 'active'
      ORDER BY updated_at, id LIMIT ${CRON_STAGE_MAX_REQUESTS_PER_TICK}`
    )
    .all<PaidBenchmarkRequestRow>();
  // One tick's staging is hard-capped. Each preparing request is offered exactly its fair share
  // `floor(TICK_BUDGET / preparing)`: that division already keeps the total under the cap, so a
  // minimum is only ever a value at or below the share (never a floor that breaks the cap), and
  // a request the tick cannot reach waits for the next one, which serves it first because the
  // scan is stalest-first.
  const preparing = preparingRows.results.length;
  const fairShare = Math.floor(CRON_STAGE_BUDGET_SLOTS / Math.max(1, preparing));
  const offered = Math.min(fairShare, CRON_STAGE_MAX_SLOTS_PER_REQUEST);
  let remainingStageBudget = CRON_STAGE_BUDGET_SLOTS;
  const live = [...preparingRows.results, ...activeRows.results];
  for (const request of live) {
    // One request's failure must never abort the tick for the others: a read fault, an
    // unexpected throw or a bad quote is that request's problem, logged and left for the next
    // tick, while every other live request still stages, activates and settles.
    try {
      await reconcileOnePaidRequest(env, request, {
        now,
        summary,
        offeredSlots: request.status === 'preparing' ? offered : 0,
        takeStageBudget: (wanted: number) => {
          const granted = Math.min(wanted, Math.max(0, remainingStageBudget));
          remainingStageBudget -= granted;
          return granted;
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'benchmark_paid_request_reconcile_failed',
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  // A crash between completion and the pin callback leaves the notification on the outbox;
  // draining it here is the replay, and it is idempotent per request and confirmation.
  await drainPaidBillingOutbox(env, { limit: 25, fetchImpl: options.fetchImpl });
  // Deferred native usage becomes an accounting receipt as soon as the primary gateway read
  // sees it; anything still absent stays disclosed as pending.
  await reconcilePaidUsageReceipts(env, { limit: 50, fetchImpl: options.fetchImpl });
  return summary;
}

/**
 * Continue one live request: close it when it was offered budget and staged nothing for a
 * full window, otherwise stage, activate or settle it.
 *
 * `takeStageBudget` is the tick's shared, hard-capped pool. A preparing request asks for its
 * fair share and gets whatever is left, which may be zero: a tick that already spent the
 * budget leaves the rest waiting rather than raising its D1 load, and a waiting request is
 * never abandoned (its window counts only from the last slot it staged).
 */
async function reconcileOnePaidRequest(
  env: PaidBenchmarkEnv,
  request: PaidBenchmarkRequestRow,
  input: {
    now: number;
    summary: { staged: number; completed: string[]; failed: string[]; closed: string[] };
    /** Slots this tick is prepared to offer the request; 0 means it is not staging this tick. */
    offeredSlots: number;
    takeStageBudget: (wanted: number) => number;
  }
): Promise<void> {
  const db = env.BENCH_DB;
  const { now, summary } = input;
  const quote = await readPaidBenchmarkQuote(db, request.quote_id);
  const plan = quote ? decodePlan(quote.plan) : null;
  if (!plan) return;
  let current = request;
  if (current.status === 'active') {
    // An active request must have its (deterministic, idempotent) paid run. A crash between
    // activation and run creation, or a lost run, is repaired here; a paused or failed
    // request never reaches this branch, so nothing auto-resumes a user or credit pause.
    // The same classification as the click path: a permanent plan refusal becomes a visible
    // failed request instead of an `active` row that silently does nothing forever.
    // Settle first: a request whose staged slots already finished unusable is terminal on
    // this confirmation and must never re-enter the launcher. `finish` is a no-op while
    // any slot is still live, so real work is launched exactly as before.
    const settledFirst = await finishPaidBenchmarkRequest(env, current, plan, { now });
    if (settledFirst?.status === 'completed') {
      summary.completed.push(request.id);
      return;
    }
    if (settledFirst?.status === 'failed') {
      summary.failed.push(request.id);
      return;
    }
    await launchPaidRun(env, current.id);
    current = (await readPaidBenchmarkRequest(env.BENCH_DB, current.id)) ?? current;
    summary.staged += 1;
    // A resumed run may already have finished every slot (or the run may have completed
    // instantly for a fully reused plan), so settle it in the same pass.
    const settled = await finishPaidBenchmarkRequest(env, current, plan, { now });
    if (settled?.status === 'completed') summary.completed.push(request.id);
    if (settled?.status === 'failed') summary.failed.push(request.id);
    return;
  }
  if (current.status === 'preparing') {
    const granted = input.takeStageBudget(input.offeredSlots);
    // Nothing left: the request waits for the next tick. It is not failed for inactivity,
    // because waiting is not a stall and its own window only advances on real staging.
    if (granted === 0) return;
    // This pass offered the request budget, so it now owns its liveness: a request that had
    // budget in hand and still staged nothing for a full window is genuinely stuck. Waiting
    // ticks cannot accumulate that window, because they never reach this check.
    const lastProgress = Date.parse(current.last_staged_at ?? current.created_at);
    if (now - lastProgress > STAGE_ABANDON_MS) {
      await db.batch(
        failPaidBenchmarkRequestStatements(db, {
          requestId: current.id,
          reason: 'Benchmark request was never activated.',
          retryable: true,
          now,
        })
      );
      summary.closed.push(request.id);
      return;
    }
    const staged = await stagePaidBenchmarkRequest(env, current, plan, {
      budgetSlots: granted,
      now,
    });
    if (staged.status === 'aborted') {
      await db.batch(
        failPaidBenchmarkRequestStatements(db, {
          requestId: current.id,
          reason: staged.reason,
          retryable: true,
          now,
        })
      );
      summary.failed.push(request.id);
      return;
    }
    current = await activateIfFullyStaged(env, current, plan, now);
  }
  summary.staged += 1;
  const finished = await finishPaidBenchmarkRequest(env, current, plan, { now });
  if (finished?.status === 'completed') summary.completed.push(request.id);
  if (finished?.status === 'failed') summary.failed.push(request.id);
}

/**
 * The paid benchmark endpoint. The web authorizes the saved pool and forwards its immutable
 * context; the worker authorizes every follow-up against the stored request's owner and
 * router, so a progress or pause call can only reach its own pool's request.
 */
export function registerPaidBenchmarkRoutes(app: Hono<HonoEnv>): void {
  app.post(PAID_BENCHMARK_PATH, async c => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = PaidBenchmarkWorkerRequestSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'Invalid paid benchmark request',
            issues: parsed.error.issues,
          },
        },
        400
      );
    const request = parsed.data;
    const env = c.env;
    const now = Date.now();
    switch (request.action) {
      case 'quote': {
        const engineIdentity = computeEngineIdentity('decider', request.context.baseRouter);
        const outcome = await buildPaidBenchmarkPlan(
          { db: env.BENCH_DB, env },
          {
            context: request.context,
            engineIdentity,
            // Derived by the web from the authorized saved-pool row, never client input.
            projectId: benchmarkProjectId({
              scope: request.ownerType,
              slug: request.poolSlug,
              routerId: request.routerId,
            }),
          }
        );
        if (outcome.status === 'empty')
          return c.json({ status: 'empty' } satisfies PaidBenchmarkQuote);
        if (outcome.status === 'blocked')
          return c.json(
            {
              error: {
                code: outcome.retryable ? 'retryable' : 'blocked',
                message: outcome.reason,
              },
            },
            outcome.retryable ? 503 : 422
          );
        const id = crypto.randomUUID();
        const expiresAt = new Date(now + PAID_QUOTE_TTL_MS).toISOString();
        await createPaidBenchmarkQuote(env.BENCH_DB, {
          id,
          owner: ownerOf(request.ownerType, request.ownerId),
          organizationId: request.ownerType === 'org' ? request.ownerId : null,
          router: request.context.baseRouter,
          routerId: request.routerId,
          poolVersion: request.poolVersion,
          engineIdentity,
          context: stableStringify(request.context),
          plan: JSON.stringify(outcome.plan),
          estimateMicrodollars: outcome.plan.estimateMicrodollars,
          maximumMicrodollars: outcome.plan.maximumMicrodollars,
          planCases: planSlotCount(outcome.plan),
          expiresAt,
          now,
        });
        return c.json({
          status: 'ready',
          id,
          expiresAt,
          estimateMicrodollars: outcome.plan.estimateMicrodollars,
          maximumMicrodollars: outcome.plan.maximumMicrodollars,
          cases: outcome.plan.counts,
          aliases: outcome.plan.aliases,
        } satisfies PaidBenchmarkQuote);
      }
      case 'start':
        return c.json(
          await startPaidBenchmark(env, {
            quoteId: request.quoteId,
            actorUserId: request.actorUserId,
            ownerType: request.ownerType,
            ownerId: request.ownerId,
            routerId: request.routerId,
            poolSlug: request.poolSlug,
            poolVersion: request.poolVersion,
            context: request.context,
          })
        );
      case 'progress': {
        const owner = ownerOf(request.ownerType, request.ownerId);
        const stored = request.requestId
          ? await readPaidBenchmarkRequest(env.BENCH_DB, request.requestId)
          : await readLatestRequest(env.BENCH_DB, owner, request.routerId);
        if (!stored || !requestOwnedBy(stored, owner, request.routerId))
          return c.json({ status: 'empty' } satisfies PaidBenchmarkProgress);
        const quote = await readPaidBenchmarkQuote(env.BENCH_DB, stored.quote_id);
        const plan = quote ? decodePlan(quote.plan) : null;
        if (!plan) return c.json({ status: 'empty' } satisfies PaidBenchmarkProgress);
        return c.json(
          await progressFor(env, stored, plan, {
            cursor: request.cursor,
            budgetSlots: STAGE_BUDGET_SLOTS,
          })
        );
      }
      case 'pause':
        return c.json(
          await pausePaidBenchmark(env, {
            ownerType: request.ownerType,
            ownerId: request.ownerId,
            routerId: request.routerId,
            requestId: request.requestId,
            now,
          })
        );
    }
  });
}
