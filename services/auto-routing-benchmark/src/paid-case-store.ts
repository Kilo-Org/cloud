/**
 * D1 persistence for paid benchmark case runs.
 *
 * Billing is just-in-time: the native usage writer bills each model request against the
 * one account attached to it. D1 owns measurement safety and read-only accounting; it
 * never sends a charge, a hold or a release.
 *
 * The unit of work is one model request: (engine identity, concrete model, variant,
 * repetition, case, generation). `benchmark_case_runs` is the cross-run fence: its
 * primary key plus `generation` decide who may measure a case, and every transition is
 * conditioned on (executor run, token, generation) so an old callback cannot touch a
 * newer attempt.
 *
 * Payer assignment is per model request, not per payer: exactly one account is
 * `attached` to a generation, chosen deterministically round-robin among distinct
 * active payer accounts. A known pre-provider payment refusal `detach`es it and lets the
 * next account be assigned for the same request; once usage is `accepted` (or the
 * attempt is uncertain) it is never reassigned. If the platform requested the case
 * before an account was attached, the sticky platform row pays it instead; a later
 * platform latch never retroactively covers an earlier user row.
 *
 * Mutators return prepared statements so callers put them in the same `db.batch` as
 * their own writes. D1 runs a batch as one transaction, so no read-then-write split of
 * the payer set or the case result is possible.
 */
import type { PaidBenchmarkProgress } from '@kilocode/auto-routing-contracts';
import { BENCHMARK_PLATFORM_PROJECT_ID } from '@kilocode/auto-routing-contracts';
import type {
  PaidBenchmarkRequestCaseRowStatus,
  PaidBenchmarkRequestRowStatus,
  PaidBillingOutboxKind,
  PaidBillingOutboxStatus,
  PaidCaseCancellationStatus,
  PaidCasePayerStatus,
  PaidCaseRunRowStatus,
  PaidModelRequestState,
} from './db-schema';

export type PaidCreditOwner = {
  ownerType: 'user' | 'organization';
  ownerId: string;
};

export type PaidCaseKey = {
  engineIdentity: string;
  model: string;
  /** Storage variant key; '' means the default variant. */
  variant: string;
  rep: number;
  caseId: string;
};

/** The exact generation a transition is allowed to act on. */
export type PaidCaseGeneration = {
  runId: string;
  token: string;
  generation: number;
};

export type PaidCaseRunRow = {
  engine_identity: string;
  model: string;
  variant: string;
  rep: number;
  case_id: string;
  status: PaidCaseRunRowStatus;
  generation: number;
  executor_run_id: string | null;
  executor_token: string | null;
  platform_covered: number;
  result_usable: number;
  cost_microdollars: number | null;
  settlement_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  settled_at: string | null;
};

export type PaidCasePayerRow = {
  engine_identity: string;
  model: string;
  variant: string;
  rep: number;
  case_id: string;
  generation: number;
  owner_type: 'user' | 'organization';
  owner_id: string;
  request_id: string;
  status: PaidCasePayerStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PaidModelRequestRow = {
  id: string;
  engine_identity: string;
  model: string;
  variant: string;
  rep: number;
  case_id: string;
  generation: number;
  pool_request_id: string | null;
  state: PaidModelRequestState;
  assignment_id: string | null;
  api: string | null;
  executor_user_id: string | null;
  project_id: string | null;
  usage_id: string | null;
  platform_organization_id: string | null;
  owner_type: 'user' | 'organization' | null;
  owner_id: string | null;
  platform_covered: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PaidAttemptUsageRow = {
  usage_id: string;
  request_id: string;
  engine_identity: string;
  model: string;
  variant: string;
  rep: number;
  case_id: string;
  generation: number;
  owner_type: 'user' | 'organization';
  owner_id: string;
  microdollars: number;
  platform_covered: number;
  created_at: string;
};

export type PaidBenchmarkRequestRow = {
  id: string;
  owner_type: 'user' | 'organization';
  owner_id: string;
  organization_id: string | null;
  router: string;
  router_id: string;
  pool_version: string;
  engine_identity: string;
  status: PaidBenchmarkRequestRowStatus;
  quote_id: string;
  estimate_microdollars: number;
  maximum_microdollars: number;
  charged_microdollars: number;
  plan_cases: number;
  staged_cases: number;
  pause_reason: 'no_funds' | 'owner' | null;
  actor_user_id: string;
  context: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  failure_retryable: number;
};

export type PaidBenchmarkQuoteRow = {
  id: string;
  owner_type: 'user' | 'organization';
  owner_id: string;
  organization_id: string | null;
  router: string;
  router_id: string;
  pool_version: string;
  engine_identity: string;
  context: string;
  plan: string;
  estimate_microdollars: number;
  maximum_microdollars: number;
  plan_cases: number;
  expires_at: string;
  started_request_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PaidBillingOutboxRow = {
  seq: number;
  id: string;
  kind: PaidBillingOutboxKind;
  request_id: string;
  case_engine_identity: string | null;
  case_model: string | null;
  case_variant: string | null;
  case_rep: number | null;
  case_id: string | null;
  owner_type: 'user' | 'organization';
  owner_id: string;
  amount_microdollars: number;
  status: PaidBillingOutboxStatus;
  attempts: number;
  available_at: number;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  last_error: string | null;
};

export type PaidCaseCancellationRow = {
  engine_identity: string;
  model: string;
  variant: string;
  rep: number;
  case_id: string;
  generation: number;
  executor_run_id: string;
  executor_token: string;
  status: PaidCaseCancellationStatus;
  attempts: number;
  available_at: number;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  last_error: string | null;
};

export type PaidCaseRunClaimOutcome = 'started' | 'attached' | 'reused' | 'fenced';

export type PaidCaseRunClaim = {
  outcome: PaidCaseRunClaimOutcome;
  /** The case run after the claim batch; null when no fence row exists yet. */
  run: PaidCaseRunRow | null;
};

export type PaidCaseEnqueueOutcome = 'queued' | 'reused' | 'closed';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The gateway's assignment, model-request and usage ids are UUIDs; reject anything else. */
function assertUuid(name: string, value: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID, got ${value}`);
}

/**
 * Evidence of the admission transition itself. `changed` is the transition statement's
 * own `meta.changes`, so a duplicate delivery that leaves the row already admitted is
 * distinguishable from the delivery that performed selecting→admitted. `row` is the
 * admitted row when one exists.
 *
 * `results` is the whole batch array. Index 0 is the payer-eligibility insert and index
 * 1 is the transition (see {@link admitPaidModelRequestStatements}); callers should use
 * this helper instead of indexing, so adding a bookkeeping statement cannot change the
 * answer.
 */
export type PaidModelRequestAdmission = {
  /** True only for the delivery that performed selecting→admitted. */
  changed: boolean;
  row: PaidModelRequestRow | null;
};

export function paidModelRequestAdmission(
  results: readonly {
    meta?: { changes?: number | null } | null;
    results?: readonly unknown[] | null;
  }[]
): PaidModelRequestAdmission {
  // The transition is the first statement that reports changes>0 for an UPDATE of the
  // model request; its row evidence is the trailing SELECT.
  const transition = results[1]?.meta?.changes ?? 0;
  const last = results[results.length - 1];
  const row = (last?.results?.[0] as PaidModelRequestRow | undefined) ?? null;
  return { changed: transition > 0, row };
}

/**
 * The model request left by a selection or admission batch, read from the trailing
 * SELECT rather than a fixed index, so reordering bookkeeping cannot change the answer.
 */
export function paidModelRequestOutcome(
  results: readonly { results?: readonly unknown[] | null }[]
): PaidModelRequestRow | null {
  const last = results[results.length - 1];
  const row = last?.results?.[0];
  return row ? (row as unknown as PaidModelRequestRow) : null;
}

/** Stable identity of a model request, used in progress rows and receipts. */
export function paidCaseRunId(key: PaidCaseKey): string {
  return encodeURIComponent(
    JSON.stringify([key.engineIdentity, key.model, key.variant, key.rep, key.caseId])
  );
}

function keyParams(key: PaidCaseKey): [string, string, string, number, string] {
  return [key.engineIdentity, key.model, key.variant, key.rep, key.caseId];
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

/** `prefix.`-qualified comparison of the five case-run key columns. */
function caseKeyPredicate(prefix = ''): string {
  const column = (name: string) => (prefix ? `${prefix}.${name}` : name);
  return `${column('engine_identity')} = ? AND ${column('model')} = ? AND ${column('variant')}
    = ? AND ${column('rep')} = ? AND ${column('case_id')} = ?`;
}

/**
 * The scheduler guard a paid call must still satisfy: the chunk that owns this case is
 * the caller's, it is active with an unexpired lease, it lists this case, its run is
 * still running, and its lane has not dead-lettered. Same predicates as the per-run
 * `beginPaidCase` ledger insert, so no run can infer a case another run already owns.
 */
function schedulerGuard(): string {
  return `
    EXISTS (
      SELECT 1 FROM scheduler_chunks AS chunk
      WHERE chunk.run_id = ?
        AND chunk.model = ?
        AND chunk.variant = ?
        AND chunk.rep = ?
        AND chunk.token = ?
        AND chunk.status = 'active'
        AND chunk.lease_until > ?
        AND EXISTS (SELECT 1 FROM json_each(chunk.case_ids) WHERE json_each.value = ?)
        AND EXISTS (
          SELECT 1 FROM benchmark_runs AS run
          WHERE run.id = chunk.run_id AND run.status = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM run_lane_failures AS failure
          WHERE failure.run_id = chunk.run_id AND failure.model = chunk.model
            AND failure.variant = chunk.variant AND failure.rep = chunk.rep
        )
    )`;
}

function schedulerGuardParams(input: {
  key: PaidCaseKey;
  executor: { runId: string; token: string };
  nowMs: number;
}): Array<string | number> {
  return [
    input.executor.runId,
    input.key.model,
    input.key.variant,
    input.key.rep,
    input.executor.token,
    input.nowMs,
    input.key.caseId,
  ];
}

/**
 * Stage selected case slots for a request: create the fence row on first admission and
 * record the displayed case row. Only an explicit activation passes `reclaim`; nothing
 * after dispatch revives a terminal case, so recovery paths cannot start user work.
 *
 * Bounded set-based form: a 20-entry pool with several variants and repetitions is
 * thousands of slots, so the controller chunks its plan into these batches. Approval is
 * never inferred from a partial plan: activation requires `staged_cases = plan_cases`.
 */
export const PAID_CASE_BATCH_LIMIT = 50;

export function enqueuePaidCaseBatchStatements(
  db: D1Database,
  input: {
    requestId: string;
    /**
     * Selected cases. `coveredByKilo` is the quote's approved covered bit: the slot was
     * promised as Kilo-paid before any canonical latch exists, so it may never become a
     * user payer even if platform membership falls later.
     */
    cases: ReadonlyArray<PaidCaseKey & { coveredByKilo?: boolean }>;
    /**
     * Canonical reuse eligibility, identical to the reuse SQL the controller used to
     * decide there was no compatible draw: per-case minimum prompt revision, and the
     * pair's invalidation fence. Without them a valid-but-stale row would be advertised
     * as free work the controller never intended to reuse. A READY serving pair never
     * reaches this call (the controller stages only the missing draws), so this is the
     * single place the fence needs to exist.
     */
    eligibility?: {
      router: string;
      engineIdentity: string;
      /** Case id → minimum prompt revision. */
      minimumRevisions: Readonly<Record<string, number>>;
    };
    reclaim?: boolean;
    now?: number;
  }
): D1PreparedStatement[] {
  if (input.cases.length === 0) return [];
  if (input.cases.length > PAID_CASE_BATCH_LIMIT)
    throw new Error(`stage at most ${PAID_CASE_BATCH_LIMIT} cases per batch`);
  const at = iso(input.now ?? Date.now());
  const plan = JSON.stringify(
    input.cases.map(caseKey => ({
      engineIdentity: caseKey.engineIdentity,
      model: caseKey.model,
      variant: caseKey.variant,
      rep: caseKey.rep,
      caseId: caseKey.caseId,
      coveredByKilo: caseKey.coveredByKilo === true,
    }))
  );
  const column = (name: string) => `json_extract(selected.value, '$.${name}')`;
  const runJoin = `run.engine_identity = ${column('engineIdentity')}
    AND run.model = ${column('model')} AND run.variant = ${column('variant')}
    AND run.rep = ${column('rep')} AND run.case_id = ${column('caseId')}`;
  // Reuse requires a real, usable stored measurement, not just the flag: a settled row
  // whose result is missing, errored, timed out or non-zero exit is not free work.
  // Revision/invalidation compatibility stays the controller's check; this predicate
  // only refuses to advertise a case that has no valid evidence at all.
  const minimumRevisions = JSON.stringify(input.eligibility?.minimumRevisions ?? {});
  const reused = `(run.result_usable = 1
    AND run.status IN ('settled', 'cancelled', 'failed')
    AND EXISTS (
      SELECT 1 FROM case_results AS stored
      JOIN benchmark_runs AS source ON source.id = stored.run_id
      WHERE source.engine_identity = run.engine_identity
        AND source.kind = 'decider' AND source.status IN ('completed', 'failed')
        AND stored.model = run.model AND stored.variant = run.variant
        AND stored.case_id = run.case_id AND stored.rep = run.rep
        AND stored.error IS NULL AND stored.timed_out = 0 AND stored.exit_code = 0
        -- Same revision floor the reuse query applied.
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS minimum
          WHERE minimum.key = stored.case_id AND stored.prompt_revision < minimum.value
        )
        -- Same invalidation fence: a draw taken before the pair was invalidated at this
        -- engine identity is not reusable, however valid the row looks.
        AND NOT EXISTS (
          SELECT 1 FROM benchmark_profiles AS profile
          WHERE profile.router = ? AND profile.engine_identity = source.engine_identity
            AND profile.model = stored.model AND profile.variant = stored.variant
            AND profile.invalidated_at IS NOT NULL
            AND source.started_at < profile.invalidated_at
        )
    ))`;
  return [
    db
      .prepare(
        `INSERT INTO benchmark_case_runs (
          engine_identity, model, variant, rep, case_id, status, generation,
          platform_covered, result_usable, created_at, updated_at
        )
        SELECT ${column('engineIdentity')}, ${column('model')}, ${column('variant')},
          ${column('rep')}, ${column('caseId')}, 'queued', 1, 0, 0, ?, ?
        FROM json_each(?) AS selected
        WHERE true
        ON CONFLICT DO NOTHING`
      )
      .bind(at, at, plan),
    ...(input.reclaim
      ? [
          db
            .prepare(
              `UPDATE benchmark_case_runs
              SET status = 'queued', generation = generation + 1, executor_run_id = NULL,
                executor_token = NULL, result_usable = 0, failure_reason = NULL,
                -- The platform grant belonged to the cancelled generation; a fresh one
                -- needs a fresh membership check.
                platform_covered = 0, updated_at = ?
              WHERE status IN ('paused', 'cancelled', 'failed') AND result_usable = 0
                -- Never reopen a generation whose cancel is unconfirmed or whose admitted
                -- call lacks its native receipt: the attempt may still be in flight.
                AND NOT EXISTS (
                  SELECT 1 FROM paid_benchmark_cancellations AS pending
                  WHERE pending.engine_identity = benchmark_case_runs.engine_identity
                    AND pending.model = benchmark_case_runs.model
                    AND pending.variant = benchmark_case_runs.variant
                    AND pending.rep = benchmark_case_runs.rep
                    AND pending.case_id = benchmark_case_runs.case_id
                    AND pending.generation = benchmark_case_runs.generation
                    AND pending.status = 'pending'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM paid_model_requests AS admitted
                  WHERE admitted.engine_identity = benchmark_case_runs.engine_identity
                    AND admitted.model = benchmark_case_runs.model
                    AND admitted.variant = benchmark_case_runs.variant
                    AND admitted.rep = benchmark_case_runs.rep
                    AND admitted.case_id = benchmark_case_runs.case_id
                    AND admitted.generation = benchmark_case_runs.generation
                    AND admitted.state IN ('admitted', 'used', 'completed')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM pending_decider_outputs AS pending
                  WHERE pending.model = benchmark_case_runs.model
                    AND pending.variant = benchmark_case_runs.variant
                    AND pending.case_id = benchmark_case_runs.case_id
                    AND pending.rep = benchmark_case_runs.rep
                )
                AND EXISTS (
                  SELECT 1 FROM json_each(?) AS selected
                  WHERE ${column('engineIdentity')} = benchmark_case_runs.engine_identity
                    AND ${column('model')} = benchmark_case_runs.model
                    AND ${column('variant')} = benchmark_case_runs.variant
                    AND ${column('rep')} = benchmark_case_runs.rep
                    AND ${column('caseId')} = benchmark_case_runs.case_id
                )`
            )
            .bind(at, plan),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO paid_benchmark_request_cases (
          request_id, engine_identity, model, variant, rep, case_id, status, generation,
          covered_by_kilo, charged_microdollars, reason, updated_at
        )
        SELECT ?, run.engine_identity, run.model, run.variant, run.rep, run.case_id,
          CASE
            WHEN ${reused} THEN 'reused'
            WHEN run.status = 'failed' THEN 'failed'
            -- A paused slot shows 'paused' unless this batch reopened it: the reclaim
            -- statement above turns it back into 'queued', so the CASE sees that state
            -- and the row becomes fresh work only after the guards passed.
            WHEN run.status IN ('cancelled', 'paused') THEN 'paused'
            ELSE 'queued'
          END,
          -- The generation this row joins. Exact while the run is running (a mid-run
          -- join); a queued run's pre-claim value is corrected by the claim batch below.
          run.generation,
          -- The approved covered bit from the quote is monotonic: once a slot is
          -- promised Kilo-paid it never becomes a user payer, even after removal.
          MAX(
            COALESCE(json_extract(selected.value, '$.coveredByKilo'), 0),
            COALESCE(run.platform_covered, 0)
          ), 0, NULL, ?
        FROM json_each(?) AS selected
        JOIN benchmark_case_runs AS run ON ${runJoin}
        WHERE true
        -- A reclaimed slot reopened in this batch must update the row that an earlier
        -- stage left paused; only a genuinely reopened case may move off 'paused'.
        ON CONFLICT DO UPDATE SET
          status = excluded.status,
          -- A reclaimed row belongs to the generation being reopened, never to the one it
          -- paused in: coverage is matched per generation.
          generation = excluded.generation,
          covered_by_kilo = MAX(paid_benchmark_request_cases.covered_by_kilo,
            excluded.covered_by_kilo),
          updated_at = excluded.updated_at
        WHERE paid_benchmark_request_cases.status = 'paused'
          AND excluded.status IN ('queued', 'running', 'reused')`
      )
      .bind(input.requestId, minimumRevisions, input.eligibility?.router ?? '', at, plan),
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET staged_cases = (
            SELECT COUNT(*) FROM paid_benchmark_request_cases WHERE request_id = ?
          ), updated_at = ?
        WHERE id = ? AND status = 'preparing'`
      )
      .bind(input.requestId, at, input.requestId),
  ];
}

/** Single-case form of {@link enqueuePaidCaseBatchStatements}, used by focused callers. */
export function enqueuePaidCaseStatements(
  db: D1Database,
  input: { key: PaidCaseKey; requestId: string; reclaim?: boolean; now?: number }
): D1PreparedStatement[] {
  return enqueuePaidCaseBatchStatements(db, {
    requestId: input.requestId,
    cases: [input.key],
    reclaim: input.reclaim,
    now: input.now,
  });
}

/** Record a case slot satisfied by an existing result without a paid model request. */
export function markPaidCaseReusedStatements(
  db: D1Database,
  input: { key: PaidCaseKey; requestId: string; coveredByKilo: boolean; now?: number }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  return [
    db
      .prepare(
        `INSERT INTO paid_benchmark_request_cases (
          request_id, engine_identity, model, variant, rep, case_id, status,
          covered_by_kilo, charged_microdollars, reason, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'reused', ?, 0, NULL, ?
        WHERE EXISTS (SELECT 1 FROM paid_benchmark_requests WHERE id = ?)
        ON CONFLICT DO NOTHING`
      )
      .bind(
        input.requestId,
        ...keyParams(input.key),
        input.coveredByKilo ? 1 : 0,
        at,
        input.requestId
      ),
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET staged_cases = (
            SELECT COUNT(*) FROM paid_benchmark_request_cases WHERE request_id = ?
          ), updated_at = ?
        WHERE id = ? AND status = 'preparing'`
      )
      .bind(input.requestId, at, input.requestId),
  ];
}

/**
 * Reconcile one request's own display rows to `reused` for an exact pair that has become
 * serving since the quote. The pair's ready profile (`status = 'ready'`, a real measuring
 * `run_id`) is the evidence; a request quoted as non-serving can therefore stop waiting on
 * display rows nobody will measure without ever being claimed, remeasured or charged.
 *
 * Only this request's rows move, and only from `queued`/`running`; `benchmark_case_runs`,
 * payer rows and usage are untouched, so a pair shared with another payer keeps its live
 * generation. `charged_microdollars` is preserved. Returns the reused-slot count so the
 * caller can decide whether the pair is fully satisfied; the recount statement runs in the
 * same batch.
 */
export function markServingPairReusedStatements(
  db: D1Database,
  input: {
    requestId: string;
    router: string;
    engineIdentity: string;
    repetitions: number;
    model: string;
    /** Storage variant key; '' means the default variant. */
    variant: string;
    now?: number;
  }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  // Under serving evidence, every one of this request's rows for the exact pair is a serving
  // reuse: a still-live row becomes `reused`, and a row the staging pass already marked
  // `reused` (an ordinary historical draw with a null reason) gains the serving marker. Both
  // are needed for the durable read's "every row carries the marker" test to hold.
  const servingEvidence = `EXISTS (
    SELECT 1 FROM benchmark_profiles AS serving
    WHERE serving.router = ? AND serving.engine_identity = ? AND serving.repetitions = ?
      AND serving.model = rc.model AND serving.variant = rc.variant
      AND serving.status = 'ready'
      AND serving.run_id IS NOT NULL AND serving.run_id <> ''
  )`;
  return [
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases AS rc
        SET status = 'reused', reason = ?, updated_at = ?
        WHERE rc.request_id = ? AND rc.engine_identity = ? AND rc.model = ? AND rc.variant = ?
          AND (rc.status IN ('queued', 'running')
            OR (rc.status = 'reused' AND (rc.reason IS NULL OR rc.reason = ?)))
          AND ${servingEvidence}`
      )
      .bind(
        SERVING_REUSE_CASE_MARKER,
        at,
        input.requestId,
        input.engineIdentity,
        input.model,
        input.variant,
        SERVING_REUSE_CASE_MARKER,
        input.router,
        input.engineIdentity,
        input.repetitions
      ),
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET staged_cases = (
            SELECT COUNT(*) FROM paid_benchmark_request_cases WHERE request_id = ?
          ), updated_at = ?
        WHERE id = ? AND status = 'preparing'`
      )
      .bind(input.requestId, at, input.requestId),
  ];
}

/**
 * The pairs of one request that still have live (`queued`/`running`) display rows among
 * `pairs`, keyed `model`/storage `variant`. Run in the same batch as
 * {@link markServingPairReusedStatements}: a pair the reconcile could not move still needs a
 * measurement, so the caller fails closed by claiming it instead of treating it as reused.
 */
export function readLiveRequestPairStatement(
  db: D1Database,
  input: {
    requestId: string;
    pairs: readonly { model: string; variant: string }[];
  }
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT DISTINCT model, variant FROM paid_benchmark_request_cases
      WHERE request_id = ? AND status IN ('queued', 'running')
        AND (model || char(31) || variant) IN (SELECT value FROM json_each(?))`
    )
    .bind(
      input.requestId,
      JSON.stringify(input.pairs.map(pair => `${pair.model}\u001f${pair.variant}`))
    );
}

/** Reason recorded when a serving pair's own display rows could not be reconciled. */
export const SERVING_RECONCILE_INCOMPLETE_REASON =
  'A model that became measured while this request was confirmed could not be reconciled. Start a fresh estimate.';

/**
 * Durably refuse an activation whose reconcile could not prove an observed-ready pair's
 * display rows were all handled. It is one guarded close inside the reconcile's own batch:
 *
 * - the request fails only while at least one of the attempted pairs still has a live
 *   (`queued`/`running`) display row **and** no serving profile for that exact row, which is
 *   precisely the state a withdrawal leaves behind;
 * - every other statement of the close is conditioned on the request having been failed with
 *   this exact reason, so it can never fire for a reconcile that actually succeeded.
 *
 * Because the decision and the state commit together, a crash before the next activation
 * cannot re-enter: the request is terminal, so the next launch returns `request_not_active`.
 * Only this request's rows move — another payer's `benchmark_case_runs`, receipts and usage
 * are untouched — and its already-charged amount is preserved.
 */
export function failUnreconciledServingPairStatements(
  db: D1Database,
  input: {
    requestId: string;
    /** Attempted serving pairs, storage variant keys ('' = default). */
    pairs: readonly { model: string; variant: string }[];
    router: string;
    engineIdentity: string;
    repetitions: number;
    now?: number;
  }
): D1PreparedStatement[] {
  const nowMs = input.now ?? Date.now();
  const at = iso(nowMs);
  const closeId = `close:${input.requestId}`;
  const reason = SERVING_RECONCILE_INCOMPLETE_REASON;
  const pairPlan = JSON.stringify(input.pairs.map(pair => `${pair.model}\u001f${pair.variant}`));
  // Still unproven: an attempted pair still has a live display row and no serving profile.
  const unproven = `EXISTS (
    SELECT 1 FROM paid_benchmark_request_cases AS rc
    WHERE rc.request_id = ? AND rc.status IN ('queued', 'running')
      AND (rc.model || char(31) || rc.variant) IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (
        SELECT 1 FROM benchmark_profiles AS serving
        WHERE serving.router = ? AND serving.engine_identity = ?
          AND serving.repetitions = ?
          AND serving.model = rc.model AND serving.variant = rc.variant
          AND serving.status = 'ready' AND serving.run_id IS NOT NULL AND serving.run_id <> ''
      )
  )`;
  // Every other statement only fires for the close this function wrote.
  const closedHere = `EXISTS (
    SELECT 1 FROM paid_benchmark_requests AS closed
    WHERE closed.id = ? AND closed.status = 'failed' AND closed.failure_reason = ?
  )`;
  return [
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET status = 'failed', failure_reason = ?, failure_retryable = 1, updated_at = ?
        WHERE id = ? AND status IN ('preparing', 'active') AND ${unproven}`
      )
      .bind(
        reason,
        at,
        input.requestId,
        input.requestId,
        pairPlan,
        input.router,
        input.engineIdentity,
        input.repetitions
      ),
    db
      .prepare(
        `UPDATE benchmark_case_payers SET status = 'detached', reason = ?, updated_at = ?
        WHERE request_id = ? AND status = 'eligible' AND ${closedHere}`
      )
      .bind(reason, at, input.requestId, input.requestId, reason),
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'cancelled', failure_reason = ?, settled_at = ?, settlement_id = ?,
          updated_at = ?
        WHERE status IN ('queued', 'running') AND platform_covered = 0
          AND EXISTS (
            SELECT 1 FROM paid_benchmark_request_cases AS mine
            WHERE mine.engine_identity = benchmark_case_runs.engine_identity
              AND mine.model = benchmark_case_runs.model
              AND mine.variant = benchmark_case_runs.variant
              AND mine.rep = benchmark_case_runs.rep
              AND mine.case_id = benchmark_case_runs.case_id
              AND mine.request_id = ?
          )
          -- Another live payer or an eligible other payer keeps the generation.
          AND NOT EXISTS (
            SELECT 1 FROM paid_benchmark_request_cases AS other
            JOIN paid_benchmark_requests AS other_request ON other_request.id = other.request_id
            WHERE other.engine_identity = benchmark_case_runs.engine_identity
              AND other.model = benchmark_case_runs.model
              AND other.variant = benchmark_case_runs.variant
              AND other.rep = benchmark_case_runs.rep
              AND other.case_id = benchmark_case_runs.case_id
              AND other.status IN ('queued', 'running')
              AND other_request.status = 'active' AND other.request_id <> ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM benchmark_case_payers AS payer
            WHERE payer.engine_identity = benchmark_case_runs.engine_identity
              AND payer.model = benchmark_case_runs.model
              AND payer.variant = benchmark_case_runs.variant
              AND payer.rep = benchmark_case_runs.rep
              AND payer.case_id = benchmark_case_runs.case_id
              AND payer.generation = benchmark_case_runs.generation
              AND payer.status = 'eligible' AND payer.request_id <> ?
          )
          AND ${closedHere}`
      )
      .bind(
        reason,
        at,
        closeId,
        at,
        input.requestId,
        input.requestId,
        input.requestId,
        input.requestId,
        reason
      ),
    db
      .prepare(
        `INSERT INTO paid_benchmark_cancellations (
          engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, status, attempts, available_at, created_at, updated_at
        )
        SELECT engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, 'pending', 0, ?, ?, ?
        FROM benchmark_case_runs
        WHERE status = 'cancelled' AND settlement_id = ?
          AND executor_run_id IS NOT NULL AND executor_token IS NOT NULL
          AND ${closedHere}
        ON CONFLICT DO NOTHING`
      )
      .bind(nowMs, nowMs, nowMs, closeId, input.requestId, reason),
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases SET status = 'failed', reason = ?, updated_at = ?
        WHERE request_id = ? AND status IN ('queued', 'running') AND ${closedHere}`
      )
      .bind(reason, at, input.requestId, input.requestId, reason),
  ];
}

/**
 * Internal marker written to `paid_benchmark_request_cases.reason` when a pair's display rows
 * are converted by the serving reconcile (a pair that became measured after the quote). It is
 * the durable proof of that decision, distinct from an ordinary historical reuse: those rows
 * stay `reused` with a null reason and still require the zero-provider profile
 * materialization. Never user-visible — the progress reader maps it back to null.
 */
export const SERVING_REUSE_CASE_MARKER = 'serving_reuse';

/** Map a stored case reason to the wire form: the internal serving marker is never exposed. */
function wireCaseReason(reason: string | null): string | null {
  return reason === SERVING_REUSE_CASE_MARKER ? null : reason;
}

/**
 * The pairs of one request whose serving-reuse decision already committed: every one of the
 * pair's display rows is `reused` and carries the serving marker. This is the
 * crash-after-success fence:
 *
 * A launch that reconciled an observed-ready pair to `reused` and then died before claiming
 * its siblings leaves exactly this state. A retry must not re-decide that pair from the
 * registry (the profile may have been withdrawn since) and must never measure it, so it
 * consults this instead of re-deriving readiness.
 *
 * Plain prior-case reuse is deliberately not this signal: a never-measured pair with copied
 * draws still has to materialize its profile with zero provider calls, so its rows are staged
 * `queued` until a launch claims it. Only the reconcile writes this state.
 */
export function readReusedRequestPairStatement(
  db: D1Database,
  input: {
    requestId: string;
    pairs: readonly { model: string; variant: string }[];
  }
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT rc.model AS model, rc.variant AS variant
      FROM paid_benchmark_request_cases AS rc
      WHERE rc.request_id = ? AND rc.status = 'reused' AND rc.reason = ?
        AND (rc.model || char(31) || rc.variant) IN (SELECT value FROM json_each(?))
      GROUP BY rc.model, rc.variant
      HAVING NOT EXISTS (
        SELECT 1 FROM paid_benchmark_request_cases AS other
        WHERE other.request_id = ? AND other.model = rc.model AND other.variant = rc.variant
          AND (other.status <> 'reused' OR other.reason IS NOT ?)
      )`
    )
    .bind(
      input.requestId,
      SERVING_REUSE_CASE_MARKER,
      JSON.stringify(input.pairs.map(pair => `${pair.model}\u001f${pair.variant}`)),
      input.requestId,
      SERVING_REUSE_CASE_MARKER
    );
}

/**
 * Post-completion bookkeeping: pin the request's confirmed alias targets for the pool
 * controller. Amount 0 and no case work, so it can never start inference or spend. The
 * deterministic id makes a replay a no-op. This is the only billing outbox kind left.
 */
export function enqueuePaidPoolPinsStatement(
  db: D1Database,
  input: { requestId: string; now?: number }
): D1PreparedStatement {
  const nowMs = input.now ?? Date.now();
  return db
    .prepare(
      `INSERT INTO paid_benchmark_billing_outbox (
        id, kind, request_id, owner_type, owner_id, amount_microdollars, status,
        attempts, available_at, created_at, updated_at
      )
      SELECT 'pins:' || id, 'pins', id, owner_type, owner_id, 0, 'pending', 0, ?, ?, ?
      FROM paid_benchmark_requests
      WHERE id = ? AND status = 'completed'
      ON CONFLICT DO NOTHING`
    )
    .bind(nowMs, nowMs, nowMs, input.requestId);
}

/**
 * Claim the model request for the caller's chunk. The insert, the queued→running
 * transition and the paid-call ledger row share one {@link schedulerGuard}, so only the
 * chunk that owns the case starts inference and a crash cannot open a second physical
 * attempt through this fence. The trailing SELECT is the classification source for
 * {@link paidCaseClaimOutcome}: a case another run is measuring is `attached` (do not
 * infer), and a settled or usable case is `reused`.
 */
export function claimPaidCaseStatements(
  db: D1Database,
  input: {
    key: PaidCaseKey;
    executor: { runId: string; token: string };
    /**
     * Platform run only: latch coverage for this exact case. A user claim passes false
     * even when the pair is currently a platform member — coverage must never be derived
     * from a stale pre-read in a user run.
     */
    platform?: boolean;
    now?: number;
  }
): D1PreparedStatement[] {
  const nowMs = input.now ?? Date.now();
  const at = iso(nowMs);
  const key = keyParams(input.key);
  const guard = schedulerGuard();
  const guardParams = schedulerGuardParams({
    key: input.key,
    executor: input.executor,
    nowMs,
  });
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO benchmark_case_runs (
          engine_identity, model, variant, rep, case_id, status, generation,
          executor_run_id, executor_token, platform_covered, result_usable,
          created_at, updated_at, started_at
        )
        SELECT ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, 0, ?, ?, ?
        WHERE ${guard}
        ON CONFLICT DO NOTHING`
      )
      .bind(
        ...key,
        input.executor.runId,
        input.executor.token,
        input.platform ? 1 : 0,
        at,
        at,
        at,
        ...guardParams
      ),
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'running', generation = generation + 1, executor_run_id = ?,
          executor_token = ?, started_at = ?, updated_at = ?
        WHERE ${caseKeyPredicate()} AND status = 'queued' AND executor_run_id IS NULL
          AND ${guard}`
      )
      .bind(input.executor.runId, input.executor.token, at, at, ...key, ...guardParams),
    db
      .prepare(
        `INSERT INTO scheduler_executions (
          run_id, model, variant, rep, case_id, token, started_at, prompt_revision
        )
        SELECT ?, ?, ?, ?, ?, ?, ?,
          (SELECT measurement_revision FROM benchmark_runs WHERE id = ?)
        WHERE EXISTS (
          SELECT 1 FROM benchmark_case_runs
          WHERE ${caseKeyPredicate()} AND status = 'running'
            AND executor_run_id = ? AND executor_token = ?
        )
        ON CONFLICT DO NOTHING`
      )
      .bind(
        input.executor.runId,
        input.key.model,
        input.key.variant,
        input.key.rep,
        input.key.caseId,
        input.executor.token,
        nowMs,
        input.executor.runId,
        ...key,
        input.executor.runId,
        input.executor.token
      ),
  ];
  // Only a platform claim latches coverage. A user claim never sets it from its own
  // pre-read: Kilo coverage is decided by the registry sync or by a platform run that
  // already held membership, so removal-before-claim cannot move a user onto Kilo and a
  // Kilo join before admission is resolved by the admission-time latch check instead.
  if (input.platform) {
    statements.push(...platformCoverageStatements(db, { key: input.key, now: nowMs }));
  }
  // Every request that participates in this exact execution joins the generation the claim
  // just established, in the same batch, so the recorded participation is exact rather than
  // inferred from the run's later state. `paused`, `done` and `reused` rows are not touched:
  // an old request whose generation was paused (or finished) never retargets a newer one.
  statements.push(
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases
        SET generation = (SELECT generation FROM benchmark_case_runs WHERE ${caseKeyPredicate()}),
          updated_at = ?
        WHERE ${caseKeyPredicate()} AND status IN ('queued', 'running')
          -- Only a live request participates: a paused, completed or failed request keeps
          -- its recorded generation even if a child row still says queued, and this also
          -- drives the write from the request index then a link-PK seek instead of a scan
          -- over closed history on every case claim.
          AND request_id IN (
            SELECT live.id FROM paid_benchmark_requests AS live
            WHERE live.status IN ('preparing', 'active')
          )
          -- Only the claim that actually owns the running generation writes it: a fenced,
          -- attached or stale claim leaves every row exactly as it was.
          AND EXISTS (
            SELECT 1 FROM benchmark_case_runs
            WHERE ${caseKeyPredicate()} AND status = 'running'
              AND executor_run_id = ? AND executor_token = ?
          )`
      )
      .bind(...key, at, ...key, ...key, input.executor.runId, input.executor.token)
  );
  statements.push(
    db.prepare(`SELECT * FROM benchmark_case_runs WHERE ${caseKeyPredicate()}`).bind(...key)
  );
  return statements;
}

/** Map the case run left by {@link claimPaidCaseStatements} to the caller's action. */
export function paidCaseClaimOutcome(
  run: PaidCaseRunRow | null,
  executor: { runId: string; token: string }
): PaidCaseRunClaim {
  if (!run) return { outcome: 'fenced', run: null };
  // Reuse is only ever a *usable* result. A settled generation with result_usable = 0
  // measured nothing; advertising it as reused would hand out a free, empty result and
  // would keep an attacher polling forever for a result that cannot exist.
  if (run.result_usable === 1) return { outcome: 'reused', run };
  if (run.status === 'settled') return { outcome: 'fenced', run };
  if (run.status === 'running') {
    const mine = run.executor_run_id === executor.runId && run.executor_token === executor.token;
    return { outcome: mine ? 'started' : 'attached', run };
  }
  return { outcome: 'fenced', run };
}

/** Map the queued case run left by {@link enqueuePaidCaseStatements}. */
export function paidCaseEnqueueOutcome(run: PaidCaseRunRow | null): PaidCaseEnqueueOutcome {
  if (!run) return 'closed';
  // Same rule as the claim: only a usable result is reuse.
  if (run.result_usable === 1) return 'reused';
  if (run.status === 'queued' || run.status === 'running') return 'queued';
  return 'closed';
}

/**
 * Select the payer for one model request, leaving it `selecting` for the single
 * admission callback. The model request UUID is the identity (a duplicated delivery is
 * the same row), and `assignmentId` is the gateway's own UUID for this attempt.
 *
 * In one transaction it stores the signed call identity, then:
 * - if the case is platform-latched, marks the row platform-covered with the platform
 *   organization and no pool request (the platform pays);
 * - otherwise picks the next account deterministically by its accepted load, rotating
 *   between concurrent payers, and copies that request's id/owner onto the row. The
 *   actor is read from the joined request at admission, so it is never invented here.
 *
 * Everything (case running/generation, latch, eligibility, detachment) is read in the
 * same transaction, so a selection cannot use stale membership.
 */
export function selectPaidModelRequestPayerStatements(
  db: D1Database,
  input: {
    key: PaidCaseKey;
    generation: number;
    modelRequestId: string;
    /** Gateway UUID for this attempt; the signed assignment id. */
    assignmentId: string;
    api: string;
    /** Acting user for a platform call; a pool call resolves it from the request. */
    executorUserId: string;
    usageId: string;
    /** Run snapshot organization for a platform-covered call; null for a pool call. */
    platformOrganizationId?: string | null;
    now?: number;
  }
): D1PreparedStatement[] {
  assertUuid('assignmentId', input.assignmentId);
  assertUuid('modelRequestId', input.modelRequestId);
  assertUuid('usageId', input.usageId);
  const at = iso(input.now ?? Date.now());
  const key = keyParams(input.key);
  const runGuard = `EXISTS (
    SELECT 1 FROM benchmark_case_runs AS run
    WHERE ${caseKeyPredicate('run')} AND run.status = 'running' AND run.generation = ?
  )`;
  const platformCovered = `(SELECT platform_covered FROM benchmark_case_runs
    WHERE ${caseKeyPredicate()}) = 1`;
  const candidates = `
    SELECT request.id AS request_id, request.owner_type, request.owner_id,
      ROW_NUMBER() OVER (ORDER BY request.owner_type, request.owner_id, request.id) - 1
        AS rank,
      (
        SELECT COUNT(*) FROM paid_model_request_attempts AS attempt
        JOIN paid_model_requests AS model ON model.id = attempt.model_request_id
        WHERE model.engine_identity = ? AND model.model = ? AND model.variant = ?
          AND model.rep = ? AND model.case_id = ? AND model.generation = ?
          AND attempt.owner_type = request.owner_type
          AND attempt.owner_id = request.owner_id
          AND attempt.status = 'accepted'
      ) AS load
    FROM paid_benchmark_request_cases AS request_case
    JOIN paid_benchmark_requests AS request ON request.id = request_case.request_id
    WHERE ${caseKeyPredicate('request_case')}
      AND request_case.status IN ('queued', 'running')
      -- A slot the quote promised as Kilo-paid is never a user payer.
      AND request_case.covered_by_kilo = 0
      AND request.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM benchmark_case_payers AS detached
        WHERE ${caseKeyPredicate('detached')} AND detached.generation = ?
          AND detached.owner_type = request.owner_type
          AND detached.owner_id = request.owner_id
          AND detached.status = 'detached'
      )`;
  return [
    // A refused selection is retryable: no upstream call happened, so the same UUID may
    // select again with a fresh assignment; the trail keeps both refusals.
    db
      .prepare(
        `UPDATE paid_model_requests
        SET state = 'selecting', assignment_id = ?, owner_type = NULL, owner_id = NULL,
          pool_request_id = NULL, platform_covered = 0, platform_organization_id = NULL,
          api = ?, executor_user_id = ?, project_id = NULL, usage_id = ?, reason = NULL,
          updated_at = ?
        WHERE id = ? AND state = 'refused'`
      )
      .bind(
        input.assignmentId,
        input.api,
        input.executorUserId,
        input.usageId,
        at,
        input.modelRequestId
      ),
    db
      .prepare(
        `INSERT INTO paid_model_requests (
          id, engine_identity, model, variant, rep, case_id, generation, pool_request_id,
          state, assignment_id, owner_type, owner_id, platform_covered, reason,
          api, executor_user_id, project_id, usage_id, platform_organization_id,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'selecting', ?, NULL, NULL,
          COALESCE((SELECT platform_covered FROM benchmark_case_runs
            WHERE ${caseKeyPredicate()}), 0), NULL,
          ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING`
      )
      .bind(
        input.modelRequestId,
        ...key,
        input.generation,
        input.assignmentId,
        ...key,
        input.api,
        input.executorUserId,
        null,
        input.usageId,
        input.platformOrganizationId ?? null,
        at,
        at
      ),
    // Platform path: the latch is authoritative; keep the row selecting for the callback.
    db
      .prepare(
        `UPDATE paid_model_requests
        SET platform_covered = 1, platform_organization_id = ?, pool_request_id = NULL,
          owner_type = NULL, owner_id = NULL, project_id = ?, updated_at = ?
        WHERE id = ? AND state = 'selecting'
          AND ${runGuard} AND ${platformCovered}
          -- A platform-covered call is only signable with the paying organization:
          -- emitting a half-built platform assignment makes the gateway throw before
          -- it can post the admit request. Refuse the selection instead.
          AND ? IS NOT NULL`
      )
      .bind(
        input.platformOrganizationId ?? null,
        BENCHMARK_PLATFORM_PROJECT_ID,
        at,
        input.modelRequestId,
        ...key,
        input.generation,
        ...key,
        input.platformOrganizationId ?? null
      ),
    // Pool path: copy the winning request's id and owner onto the row. The actor is
    // resolved from paid_benchmark_requests at admission.
    db
      .prepare(
        `UPDATE paid_model_requests
        SET pool_request_id = chosen.request_id, owner_type = chosen.owner_type,
          owner_id = chosen.owner_id, platform_covered = 0,
          platform_organization_id = NULL,
          -- The selected request's own signed project, never the caller's and never
          -- another pool's. A request without a valid project cannot be stamped. The
          -- executor user is the run snapshot's benchmark bot and stays untouched; the
          -- funding actor is joined from the selected request instead.
          project_id = (
            SELECT json_extract(quote.plan, '$.projectId')
            FROM paid_benchmark_requests AS pool
            JOIN paid_benchmark_quotes AS quote ON quote.id = pool.quote_id
            WHERE pool.id = chosen.request_id
              AND quote.owner_type = chosen.owner_type
              AND quote.owner_id = chosen.owner_id
              AND json_valid(quote.plan)
          ),
          updated_at = ?
        FROM (
          SELECT request_id, owner_type, owner_id
          FROM (${candidates}) AS candidate
          WHERE EXISTS (
            SELECT 1 FROM paid_model_requests WHERE id = ? AND state = 'selecting'
          )
          AND ${runGuard}
          AND NOT ${platformCovered}
          ORDER BY candidate.load, candidate.rank
          LIMIT 1
        ) AS chosen
        WHERE id = ? AND state = 'selecting'`
      )
      .bind(
        at,
        ...key,
        input.generation,
        ...key,
        ...key,
        input.generation,
        input.modelRequestId,
        ...key,
        input.generation,
        ...key,
        input.modelRequestId
      ),
    // Selection trail: one row per attempted account, keyed by the gateway assignment.
    db
      .prepare(
        `INSERT INTO paid_model_request_attempts (
          model_request_id, assignment_id, owner_type, owner_id, pool_request_id,
          status, reason, ordinal, created_at, updated_at
        )
        SELECT model.id, ?, COALESCE(model.owner_type, 'user'),
          COALESCE(model.owner_id, ''), COALESCE(model.pool_request_id, ''),
          'selected', NULL,
          -- Rotation is by this model request's own attempts: counting other requests'
          -- trails would make the ordinal depend on unrelated traffic.
          (SELECT COUNT(*) FROM paid_model_request_attempts AS prior
           WHERE prior.model_request_id = model.id), ?, ?
        FROM paid_model_requests AS model
        WHERE model.id = ? AND model.state = 'selecting'
        ON CONFLICT DO NOTHING`
      )
      .bind(input.assignmentId, at, at, input.modelRequestId),
    // No eligible candidate: answer as refused, keeping the gateway assignment so the
    // caller can report "no funded payer" rather than sign a stale selection.
    db
      .prepare(
        `UPDATE paid_model_requests
        SET state = 'refused', reason = 'no_funded_payer', updated_at = ?
        WHERE id = ? AND state = 'selecting' AND owner_type IS NULL
          AND pool_request_id IS NULL AND platform_covered = 0`
      )
      .bind(at, input.modelRequestId),
    db.prepare(`SELECT * FROM paid_model_requests WHERE id = ?`).bind(input.modelRequestId),
  ];
}

/**
 * The single admission transition for both payer paths. One `selecting → admitted`
 * update, guarded by the exact assignment UUID and the case's running generation:
 * - platform rows admit on the latch (the platform pays, no pool request);
 * - pool rows additionally require the chosen request still active, its payer not
 *   detached, and no other admitted call of that account awaiting its native receipt.
 *
 * A duplicate delivery of the same model request changes nothing and is answered with
 * the same admitted row, so the gateway can safely re-fetch. `admittedRow` exposes that
 * result without relying on a batch index.
 *
 * Batch results: [0] model request, [1] attempt trailer, [2] payer eligibility,
 * [3] trailing SELECT.
 */
export function admitPaidModelRequestStatements(
  db: D1Database,
  input: {
    key: PaidCaseKey;
    generation: number;
    modelRequestId: string;
    assignmentId: string;
    now?: number;
  }
): D1PreparedStatement[] {
  assertUuid('assignmentId', input.assignmentId);
  assertUuid('modelRequestId', input.modelRequestId);
  const at = iso(input.now ?? Date.now());
  const key = keyParams(input.key);
  const admitted = `EXISTS (
    SELECT 1 FROM paid_model_requests
    WHERE id = ? AND state = 'admitted' AND assignment_id = ?
  )`;
  const poolRequestActive = `EXISTS (
    SELECT 1 FROM paid_benchmark_requests AS pool
    WHERE pool.id = paid_model_requests.pool_request_id AND pool.status = 'active'
  )`;
  // The chosen payer's staged row must still be user-payable: a slot the quote promised
  // as Kilo-paid can never be admitted against a user account.
  const payerCasePayable = `EXISTS (
    SELECT 1 FROM paid_benchmark_request_cases AS staged
    WHERE staged.request_id = paid_model_requests.pool_request_id
      AND staged.engine_identity = paid_model_requests.engine_identity
      AND staged.model = paid_model_requests.model
      AND staged.variant = paid_model_requests.variant
      AND staged.rep = paid_model_requests.rep
      AND staged.case_id = paid_model_requests.case_id
      AND staged.covered_by_kilo = 0
  )`;
  const noOutstanding = `NOT EXISTS (
    SELECT 1 FROM paid_model_requests AS outstanding
    WHERE outstanding.state = 'admitted' AND outstanding.id <> paid_model_requests.id
      AND outstanding.platform_covered = 0
      AND outstanding.owner_type = paid_model_requests.owner_type
      AND outstanding.owner_id = paid_model_requests.owner_id
  )`;
  // A pair that became permanently unavailable after selection must not admit new work.
  // Registry identity is (router, model, variant, engine identity, repetitions), so the
  // router is an explicit bound column — never implied by the engine identity — and the
  // predicate is a prefix seek on the primary key. Repetitions stay out of the verdict:
  // a permanently failed pair is failed for every repetition count.
  const notPermanentlyFailed = `NOT EXISTS (
    SELECT 1
    FROM benchmark_case_runs AS run
    JOIN benchmark_runs AS executor ON executor.id = run.executor_run_id
    JOIN benchmark_profiles AS profile
      ON profile.router = executor.router
      AND profile.model = run.model
      AND profile.variant = run.variant
      AND profile.engine_identity = run.engine_identity
    WHERE run.engine_identity = paid_model_requests.engine_identity
      AND run.model = paid_model_requests.model
      AND run.variant = paid_model_requests.variant
      AND run.rep = paid_model_requests.rep
      AND run.case_id = paid_model_requests.case_id
      AND run.generation = paid_model_requests.generation
      AND profile.status = 'unavailable'
  )`;
  const notDetached = `NOT EXISTS (
    SELECT 1 FROM benchmark_case_payers AS detached
    WHERE ${caseKeyPredicate('detached')}
      AND detached.generation = paid_model_requests.generation
      AND detached.owner_type = paid_model_requests.owner_type
      AND detached.owner_id = paid_model_requests.owner_id
      AND detached.status = 'detached'
  )`;
  return [
    // Pool calls get their eligibility row here, from the stored selection, so
    // settlement and later platform coverage always find the account that pays.
    db
      .prepare(
        `INSERT INTO benchmark_case_payers (
          engine_identity, model, variant, rep, case_id, generation, owner_type, owner_id,
          request_id, status, reason, created_at, updated_at
        )
        SELECT model.engine_identity, model.model, model.variant, model.rep, model.case_id,
          model.generation, model.owner_type, model.owner_id, model.pool_request_id,
          'eligible', NULL, ?, ?
        FROM paid_model_requests AS model
        WHERE model.id = ? AND model.state = 'selecting'
          AND model.assignment_id = ? AND model.platform_covered = 0
          AND model.pool_request_id IS NOT NULL
          AND (SELECT platform_covered FROM benchmark_case_runs
               WHERE ${caseKeyPredicate()}) = 0
          AND model.owner_type IS NOT NULL AND model.owner_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM paid_benchmark_requests AS pool
            WHERE pool.id = model.pool_request_id AND pool.status = 'active'
          )
        ON CONFLICT DO NOTHING`
      )
      .bind(at, at, input.modelRequestId, input.assignmentId, ...key),
    db
      .prepare(
        `UPDATE paid_model_requests
        SET state = 'admitted', updated_at = ?
        WHERE id = ? AND state = 'selecting' AND assignment_id = ?
          AND EXISTS (
            SELECT 1 FROM benchmark_case_runs AS run
            WHERE ${caseKeyPredicate('run')} AND run.status = 'running'
              AND run.generation = ? AND run.executor_run_id IS NOT NULL
          )
          AND (
            (
              paid_model_requests.platform_covered = 1
              AND (SELECT platform_covered FROM benchmark_case_runs
                   WHERE ${caseKeyPredicate()}) = 1
              AND paid_model_requests.platform_organization_id IS NOT NULL
            )
            OR (
              paid_model_requests.platform_covered = 0
              AND paid_model_requests.pool_request_id IS NOT NULL
              -- The canonical latch is authoritative: if Kilo joined after our
              -- selection, this user selection must not be admitted.
              AND (SELECT platform_covered FROM benchmark_case_runs
                   WHERE ${caseKeyPredicate()}) = 0
              AND paid_model_requests.project_id IS NOT NULL
              AND ${notPermanentlyFailed}
              AND ${payerCasePayable}
              AND ${poolRequestActive}
              AND ${notDetached}
              AND ${noOutstanding}
            )
          )`
      )
      .bind(
        at,
        input.modelRequestId,
        input.assignmentId,
        // 1: running-run guard
        ...key,
        input.generation,
        // 2: platform latch read
        ...key,
        // 3: canonical user latch read
        ...key,
        // 4: notDetached (a five-key correlation, so it needs its own spread)
        ...key
      ),
    db
      .prepare(
        `UPDATE paid_model_request_attempts SET status = 'accepted', updated_at = ?
        WHERE model_request_id = ? AND assignment_id = ? AND status = 'selected'
          AND ${admitted}`
      )
      .bind(at, input.modelRequestId, input.assignmentId, input.modelRequestId, input.assignmentId),
    db
      .prepare(
        `UPDATE benchmark_case_payers SET status = 'accepted', updated_at = ?
        WHERE ${caseKeyPredicate()} AND generation = ?
          AND owner_type = (SELECT owner_type FROM paid_model_requests WHERE id = ?)
          AND owner_id = (SELECT owner_id FROM paid_model_requests WHERE id = ?)
          AND status = 'eligible'
          AND (SELECT platform_covered FROM paid_model_requests WHERE id = ?) = 0
          AND ${admitted}`
      )
      .bind(
        at,
        ...key,
        input.generation,
        input.modelRequestId,
        input.modelRequestId,
        input.modelRequestId,
        input.modelRequestId,
        input.assignmentId
      ),
    db
      .prepare(
        `SELECT * FROM paid_model_requests
        WHERE id = ? AND state = 'admitted' AND assignment_id = ?`
      )
      .bind(input.modelRequestId, input.assignmentId),
  ];
}

/**
 * Post-upstream accounting keyed by the gateway's assignment id. One receipt per native
 * usage id; no charge instruction. A late receipt after a pause is still counted.
 */
export function acceptPaidAttemptUsageStatements(
  db: D1Database,
  input: {
    assignmentId: string;
    usageId: string;
    microdollars: number;
    /** Expected metadata from the native usage lookup; a mismatch writes nothing. */
    expected: {
      owner: PaidCreditOwner;
      model: string;
      variant: string;
      caseId: string;
      generation: number;
      projectId: string | null;
      /** Signed organization for a platform-covered call; null for a pool call. */
      platformOrganizationId?: string | null;
    };
    now?: number;
  }
): D1PreparedStatement[] {
  if (!Number.isSafeInteger(input.microdollars) || input.microdollars < 0)
    throw new Error(`invalid usage amount: ${input.microdollars}`);
  const at = iso(input.now ?? Date.now());
  // Every stored identity must match the native lookup, the model request must be the
  // admitted one for this assignment, and its admission usage id must be this one. The
  // receipt columns are SELECTed from the stored row, never from caller-supplied case
  // or owner fields, so a mismatched or unrelated receipt cannot create accounting.
  const matches = `model.assignment_id = ? AND model.state IN ('admitted', 'used')
    AND model.usage_id = ?
    -- A platform-covered row has no owner; it must match the signed platform org.
    -- A pool row must match the native owner.
    AND (
      (model.platform_covered = 1 AND model.platform_organization_id = ?)
      OR (model.platform_covered = 0
        AND model.owner_type = ? AND model.owner_id = ?)
    )
    AND model.model = ? AND model.variant = ? AND model.case_id = ? AND model.generation = ?
    -- The project is signed by the store (pool plan or platform constant); a covered call
    -- therefore has no caller-supplied project to compare.
    AND (
      model.platform_covered = 1
      OR (? IS NULL AND model.project_id IS NULL)
      OR model.project_id = ?
    )
    AND NOT EXISTS (SELECT 1 FROM paid_attempt_usage AS prior
      WHERE prior.model_request_id = model.id)
    -- A pool call must belong to a request; a covered call is Kilo's and belongs to none.
    AND (model.platform_covered = 1 OR model.pool_request_id IS NOT NULL)`;
  return [
    db
      .prepare(
        `INSERT INTO paid_attempt_usage (
          usage_id, model_request_id, request_id, engine_identity, model, variant, rep,
          case_id, generation, owner_type, owner_id, microdollars, platform_covered, created_at
        )
        SELECT model.usage_id, model.id,
          -- A covered call has no paying pool request: it carries the empty request id so
          -- it can never credit any owner's charged total (attribution for progress reads
          -- this row by case key, not by request).
          COALESCE(model.pool_request_id, ''), model.engine_identity,
          model.model, model.variant, model.rep, model.case_id, model.generation,
          COALESCE(model.owner_type, 'organization'),
          COALESCE(model.owner_id, model.platform_organization_id, 'platform'),
          ?, model.platform_covered, ?
        FROM paid_model_requests AS model
        WHERE ${matches}
        ON CONFLICT DO NOTHING`
      )
      .bind(
        input.microdollars,
        at,
        input.assignmentId,
        input.usageId,
        input.expected.platformOrganizationId ?? null,
        input.expected.owner.ownerType,
        input.expected.owner.ownerId,
        input.expected.model,
        input.expected.variant,
        input.expected.caseId,
        input.expected.generation,
        input.expected.projectId,
        input.expected.projectId
      ),
    db
      .prepare(
        `UPDATE paid_model_requests SET state = 'completed', updated_at = ?
        WHERE id = (
            SELECT model_request_id FROM paid_attempt_usage WHERE usage_id = ?
          )
          AND state = 'admitted'`
      )
      .bind(at, input.usageId),
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET charged_microdollars = COALESCE((
              SELECT SUM(usage.microdollars) FROM paid_attempt_usage AS usage
              WHERE usage.request_id = paid_benchmark_requests.id
            ), 0),
          updated_at = ?
        WHERE id = (
          SELECT NULLIF(request_id, '') FROM paid_attempt_usage WHERE usage_id = ?
        )`
      )
      .bind(at, input.usageId),
  ];
}

/**
 * A known pre-provider refusal (stale/superseded selection): the selected account becomes
 * ineligible for this generation (its receipts stay) and the model request returns to
 * `selecting`, so the caller may select again with the same UUID. Never called after an
 * upstream call started, and a no-op unless the row is still in that exact selection.
 */
export function refusePaidModelRequestStatements(
  db: D1Database,
  input: {
    key: PaidCaseKey;
    generation: number;
    modelRequestId: string;
    assignmentId: string;
    reason: string;
    now?: number;
  }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  const key = keyParams(input.key);
  return [
    db
      .prepare(
        `UPDATE paid_model_request_attempts SET status = 'refused', reason = ?, updated_at = ?
        WHERE model_request_id = ? AND assignment_id = ? AND status = 'selected'`
      )
      .bind(input.reason, at, input.modelRequestId, input.assignmentId),
    db
      .prepare(
        `INSERT INTO benchmark_case_payers (
          engine_identity, model, variant, rep, case_id, generation, owner_type, owner_id,
          request_id, status, reason, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, attempt.owner_type, attempt.owner_id,
          attempt.pool_request_id, 'detached', ?, ?, ?
        FROM paid_model_request_attempts AS attempt
        WHERE attempt.model_request_id = ? AND attempt.assignment_id = ?
        ON CONFLICT (engine_identity, model, variant, rep, case_id, generation,
          owner_type, owner_id, request_id) DO UPDATE SET
          status = 'detached', reason = excluded.reason, updated_at = excluded.updated_at
        WHERE benchmark_case_payers.status IN ('eligible', 'accepted')`
      )
      .bind(
        ...key,
        input.generation,
        input.reason,
        at,
        at,
        input.modelRequestId,
        input.assignmentId
      ),
    db
      .prepare(
        `UPDATE paid_model_requests
        SET state = 'refused', reason = ?, owner_type = NULL, owner_id = NULL,
          pool_request_id = NULL, platform_covered = 0,
          platform_organization_id = NULL, updated_at = ?
        WHERE id = ? AND assignment_id = ? AND state IN ('selecting', 'admitted')
          AND NOT EXISTS (
            SELECT 1 FROM paid_attempt_usage AS used
            WHERE used.model_request_id = paid_model_requests.id
          )`
      )
      .bind(input.reason, at, input.modelRequestId, input.assignmentId),
    db.prepare(`SELECT * FROM paid_model_requests WHERE id = ?`).bind(input.modelRequestId),
  ];
}

/** An explicit cancel (last voluntary payer left): never charges. */
export function cancelPaidCaseStatements(
  db: D1Database,
  input: {
    key: PaidCaseKey;
    generation: PaidCaseGeneration;
    reason: string;
    transitionId: string;
    now?: number;
  }
): D1PreparedStatement[] {
  return terminalTransitionStatements(db, {
    ...input,
    status: 'cancelled',
    requestCaseStatus: 'paused',
  });
}

function terminalTransitionStatements(
  db: D1Database,
  input: {
    key: PaidCaseKey;
    generation: PaidCaseGeneration;
    transitionId: string;
    reason: string;
    status: 'failed' | 'cancelled';
    requestCaseStatus: 'failed' | 'paused';
    now?: number;
  }
): D1PreparedStatement[] {
  const nowMs = input.now ?? Date.now();
  const at = iso(nowMs);
  const key = keyParams(input.key);
  const runStatus = `(SELECT status FROM benchmark_case_runs WHERE ${caseKeyPredicate()})`;
  const runSettlement = `(SELECT settlement_id FROM benchmark_case_runs
    WHERE ${caseKeyPredicate()})`;
  return [
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = ?, failure_reason = ?, settled_at = ?, settlement_id = ?, updated_at = ?
        WHERE ${caseKeyPredicate()} AND status = 'running'
          AND executor_run_id = ? AND executor_token = ? AND generation = ?`
      )
      .bind(
        input.status,
        input.reason,
        at,
        input.transitionId,
        at,
        ...key,
        input.generation.runId,
        input.generation.token,
        input.generation.generation
      ),
    db
      .prepare(
        `INSERT INTO paid_benchmark_cancellations (
          engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, status, attempts, available_at, created_at, updated_at
        )
        SELECT engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, 'pending', 0, ?, ?, ?
        FROM benchmark_case_runs
        WHERE ${caseKeyPredicate()} AND status = ? AND settlement_id = ?
          AND executor_run_id IS NOT NULL AND executor_token IS NOT NULL
        ON CONFLICT DO NOTHING`
      )
      .bind(nowMs, nowMs, nowMs, ...key, input.status, input.transitionId),
    db
      .prepare(
        `UPDATE benchmark_case_payers SET status = 'closed', updated_at = ?
        WHERE ${caseKeyPredicate()} AND generation = ?
          AND status IN ('eligible', 'accepted')
          AND ${runStatus} = ? AND ${runSettlement} = ?`
      )
      .bind(
        at,
        ...key,
        input.generation.generation,
        ...key,
        input.status,
        ...key,
        input.transitionId
      ),
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases
        SET status = ?, reason = ?, updated_at = ?
        WHERE ${caseKeyPredicate()}
          AND COALESCE(${runSettlement}, '') = ?`
      )
      .bind(input.requestCaseStatus, input.reason, at, ...key, ...key, input.transitionId),
  ];
}

/**
 * Release a generation that provably made no paid call (throttle, catalog or
 * model-resolution failure with no output): running→queued under our run, token and
 * generation, keeping the generation so the next claim increments it. Payer rows are
 * untouched; no outbox row is written.
 *
 * "No paid call" is proven from native admission state, never from a cost heuristic: a
 * model request for this generation past `selecting`, or any recorded attempt for it,
 * makes the release a no-op.
 */
export function releasePaidCaseGenerationStatements(
  db: D1Database,
  input: { key: PaidCaseKey; generation: PaidCaseGeneration; now?: number }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  return [
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'queued', executor_run_id = NULL, executor_token = NULL,
          started_at = NULL, updated_at = ?
        WHERE ${caseKeyPredicate()} AND status = 'running' AND result_usable = 0
          AND executor_run_id = ? AND executor_token = ? AND generation = ?
          -- Release is only legal before any native provider dispatch could have started.
          -- A recorded/attempted model request for this generation means inference may
          -- have run, so it is never reopened automatically.
          AND NOT EXISTS (
            SELECT 1 FROM paid_model_requests AS native
            WHERE native.engine_identity = benchmark_case_runs.engine_identity
              AND native.model = benchmark_case_runs.model
              AND native.variant = benchmark_case_runs.variant
              AND native.rep = benchmark_case_runs.rep
              AND native.case_id = benchmark_case_runs.case_id
              AND native.generation = benchmark_case_runs.generation
              -- admitted/used/completed prove a dispatch could have started. A refused
              -- model request never reached the provider, so it stays releasable.
              AND native.state IN ('admitted', 'used', 'completed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM paid_model_request_attempts AS attempt
            JOIN paid_model_requests AS model ON model.id = attempt.model_request_id
            WHERE model.engine_identity = benchmark_case_runs.engine_identity
              AND model.model = benchmark_case_runs.model
              AND model.variant = benchmark_case_runs.variant
              AND model.rep = benchmark_case_runs.rep
              AND model.case_id = benchmark_case_runs.case_id
              AND model.generation = benchmark_case_runs.generation
              AND attempt.status = 'accepted'
          )`
      )
      .bind(
        at,
        ...keyParams(input.key),
        input.generation.runId,
        input.generation.token,
        input.generation.generation
      ),
  ];
}

/**
 * The exact-slot unfunded stop. One batch, no request-wide close:
 * - the canonical case run passes running→`paused` with `failure_reason = 'no_funds'`
 *   only under the caller's exact run/token/generation, and only while no other active
 *   payer and no platform cover exists for that slot;
 * - every request that owns the case and has no other live case becomes `paused` with
 *   `pause_reason = 'no_funds'`; a request with another live case is kept untouched;
 * - the display row becomes `paused`, and no charge, profile failure or lane failure is
 *   written.
 *
 * A pause is not a cancel: the run, its other chunks, pairs and claims are untouched.
 * Results and admitted usage are never rewritten. Idempotent by `transitionId`, so a
 * replay is a no-op after the first success.
 *
 * The trailing SELECTs report the fenced outcome: [paused requests], [kept requests],
 * [case run status].
 */
export function pausePaidUnfundedCaseStatements(
  db: D1Database,
  input: {
    key: PaidCaseKey;
    generation: PaidCaseGeneration;
    reason?: string;
    /** The request that could not pay; its own rows never count as a competing payer. */
    funderRequestId?: string;
    transitionId: string;
    now?: number;
  }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  const reason = input.reason ?? 'no_funds';
  const excludeFunder = input.funderRequestId ? 'AND other.request_id <> ?' : '';
  const key = keyParams(input.key);
  const otherLiveCase = `EXISTS (
    SELECT 1 FROM paid_benchmark_request_cases AS live
    JOIN paid_benchmark_requests AS live_request ON live_request.id = live.request_id
    WHERE live.request_id = paid_benchmark_requests.id
      AND live.status IN ('queued', 'running')
      AND live_request.status = 'active'
      AND NOT (live.engine_identity = ? AND live.model = ? AND live.variant = ?
        AND live.rep = ? AND live.case_id = ?)
  )`;
  const ownsCase = `EXISTS (
    SELECT 1 FROM paid_benchmark_request_cases AS mine
    WHERE mine.request_id = paid_benchmark_requests.id
      AND mine.engine_identity = ? AND mine.model = ? AND mine.variant = ?
      AND mine.rep = ? AND mine.case_id = ?
      AND (mine.status IN ('queued', 'running')
        OR (mine.status = 'paused' AND mine.reason = 'no_funds'))
  )`;
  return [
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'paused', failure_reason = ?, settled_at = ?, settlement_id = ?,
          executor_run_id = NULL, executor_token = NULL, started_at = NULL, updated_at = ?
        WHERE ${caseKeyPredicate()} AND status = 'running'
          AND executor_run_id = ? AND executor_token = ? AND generation = ?
          AND result_usable = 0
          AND platform_covered = 0
          -- Reuse the picker's own eligibility: another active request staged on this
          -- case whose account is not detached can pay it, so the slot continues.
          AND NOT EXISTS (
            SELECT 1 FROM paid_benchmark_request_cases AS other
            JOIN paid_benchmark_requests AS other_request
              ON other_request.id = other.request_id
            WHERE other.engine_identity = benchmark_case_runs.engine_identity
              AND other.model = benchmark_case_runs.model
              AND other.variant = benchmark_case_runs.variant
              AND other.rep = benchmark_case_runs.rep
              AND other.case_id = benchmark_case_runs.case_id
              AND other.status IN ('queued', 'running')
              AND other.covered_by_kilo = 0
              AND other_request.status = 'active'
              ${excludeFunder}
              -- A candidate that is durably detached for this generation cannot pay it, so
              -- it never keeps the slot alive. One that is eligible/accepted (a late funded
              -- entrant) does, which is why this counts real eligibility rather than the
              -- existence of any staged request.
              AND NOT EXISTS (
                SELECT 1 FROM benchmark_case_payers AS detached
                WHERE ${caseKeyPredicate('detached')}
                  AND detached.generation = benchmark_case_runs.generation
                  AND detached.owner_type = other_request.owner_type
                  AND detached.owner_id = other_request.owner_id
                  AND detached.status = 'detached'
              )
              AND (
                EXISTS (
                  SELECT 1 FROM benchmark_case_payers AS live
                  WHERE ${caseKeyPredicate('live')}
                    AND live.generation = benchmark_case_runs.generation
                    AND live.owner_type = other_request.owner_type
                    AND live.owner_id = other_request.owner_id
                    AND live.status IN ('eligible', 'accepted')
                )
                OR NOT EXISTS (
                  SELECT 1 FROM benchmark_case_payers AS recorded
                  WHERE ${caseKeyPredicate('recorded')}
                    AND recorded.generation = benchmark_case_runs.generation
                    AND recorded.owner_type = other_request.owner_type
                    AND recorded.owner_id = other_request.owner_id
                )
              )
          )`
      )
      .bind(
        reason,
        at,
        input.transitionId,
        at,
        ...key,
        input.generation.runId,
        input.generation.token,
        input.generation.generation,
        ...(input.funderRequestId ? [input.funderRequestId] : []),
        // detached candidate, then the live-eligibility and recorded-assignment probes.
        ...key,
        ...key,
        ...key
      ),
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases
        SET status = 'paused', reason = ?, updated_at = ?
        WHERE ${caseKeyPredicate()} AND status IN ('queued', 'running')
          AND EXISTS (
            SELECT 1 FROM benchmark_case_runs AS stopped
            WHERE stopped.engine_identity = ? AND stopped.model = ?
              AND stopped.variant = ? AND stopped.rep = ? AND stopped.case_id = ?
              AND stopped.status = 'paused' AND stopped.settlement_id = ?
          )`
      )
      .bind(reason, at, ...key, ...key, input.transitionId),
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET status = 'paused', pause_reason = 'no_funds', paused_at = ?, updated_at = ?
        WHERE status = 'active' AND ${ownsCase} AND NOT ${otherLiveCase}
          AND EXISTS (
            SELECT 1 FROM benchmark_case_runs AS stopped
            WHERE stopped.engine_identity = ? AND stopped.model = ?
              AND stopped.variant = ? AND stopped.rep = ? AND stopped.case_id = ?
              AND stopped.status = 'paused' AND stopped.settlement_id = ?
          )`
      )
      .bind(at, at, ...key, ...key, ...key, input.transitionId),
    db
      .prepare(
        `SELECT owner.id, owner.status FROM paid_benchmark_requests AS owner
        JOIN paid_benchmark_request_cases AS mine ON mine.request_id = owner.id
        WHERE mine.engine_identity = ? AND mine.model = ? AND mine.variant = ?
          AND mine.rep = ? AND mine.case_id = ?`
      )
      .bind(...key),
    db.prepare(`SELECT status FROM benchmark_case_runs WHERE ${caseKeyPredicate()}`).bind(...key),
  ];
}

/**
 * Typed outcome of {@link pausePaidUnfundedCaseStatements}, read from the batch without
 * relying on statement indexes.
 */
export type PaidUnfundedStopOutcome = {
  /** Requests paused by this stop. */
  paused: string[];
  /** Requests that still own another live case and were left alone. */
  kept: string[];
  /** The canonical slot after the stop; `not_running` means it was not ours any more. */
  caseRun: 'paused' | 'not_running';
};

export function paidUnfundedStopOutcome(
  results: readonly {
    meta?: { changes?: number | null } | null;
    results?: readonly unknown[] | null;
  }[]
): PaidUnfundedStopOutcome {
  const ownerRows = (results[results.length - 2]?.results ?? []) as Array<{
    id?: string;
    status?: string;
  }>;
  const caseRun = (results[results.length - 1]?.results?.[0] as { status?: string } | undefined)
    ?.status;
  return {
    paused: ownerRows.filter(row => row.status === 'paused').map(row => String(row.id)),
    // Still active: another live case kept this owner funded, so it was not paused.
    kept: ownerRows.filter(row => row.status === 'active').map(row => String(row.id)),
    caseRun: caseRun === 'paused' ? 'paused' : 'not_running',
  };
}

/**
 * The sticky platform latch: once the platform requested a case run before it settled,
 * the platform pays it and no user account is attached afterwards. Existing user payer
 * rows are left alone — a latch never retroactively covers them. One UPDATE, so the
 * platform sync batch appends it without a read and cannot act on stale membership.
 */
export function platformCoverageStatements(
  db: D1Database,
  input:
    | {
        /**
         * One exact case run under a claim that already proved membership: the platform
         * run requested this pair while it was a current member, so the latch stands even
         * if the pair is later removed. Never used from a user claim.
         */
        key: PaidCaseKey;
        now?: number;
      }
    | {
        /**
         * Platform-scoped latch from the registry sync. It is conditioned on the exact
         * current membership row of the same (router, engine identity, model, variant,
         * repetitions) that the sync just wrote, so a stale snapshot at another
         * repetition count or another router can never latch Kilo onto a removed pair.
         * Pool membership is authoritative: no status filter narrows it.
         */
        membership: {
          router: string;
          engineIdentity: string;
          model: string;
          variant: string;
          repetitions: number;
        };
        now?: number;
      }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  if ('key' in input) {
    return [
      db
        .prepare(
          `UPDATE benchmark_case_runs SET platform_covered = 1, updated_at = ?
          WHERE ${caseKeyPredicate()} AND status IN ('queued', 'running')`
        )
        .bind(at, ...keyParams(input.key)),
    ];
  }
  const { router, engineIdentity, model, variant, repetitions } = input.membership;
  return [
    db
      .prepare(
        `UPDATE benchmark_case_runs SET platform_covered = 1, updated_at = ?
        WHERE engine_identity = ? AND model = ? AND variant = ?
          AND status IN ('queued', 'running')
          AND EXISTS (
            SELECT 1 FROM benchmark_profiles AS profile
            WHERE profile.router = ?
              AND profile.engine_identity = benchmark_case_runs.engine_identity
              AND profile.model = benchmark_case_runs.model
              AND profile.variant = benchmark_case_runs.variant
              AND profile.repetitions = ?
              AND profile.platform_requested = 1
          )`
      )
      .bind(at, engineIdentity, model, variant, router, repetitions),
  ];
}

/** Read the stored model request (state, assignment, signed gateway identity). */
export async function readPaidModelRequest(
  db: D1Database,
  modelRequestId: string
): Promise<PaidModelRequestRow | null> {
  return db
    .prepare(`SELECT * FROM paid_model_requests WHERE id = ?`)
    .bind(modelRequestId)
    .first<PaidModelRequestRow>();
}

/**
 * The funding actor of a pool request: the user who clicked, kept distinct from the
 * benchmark bot executor that signs the call. The callback validates this identity.
 */
export async function readPoolRequestActorUserId(
  db: D1Database,
  requestId: string
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT actor_user_id FROM paid_benchmark_requests WHERE id = ?`)
    .bind(requestId)
    .first<{ actor_user_id: string }>();
  return row?.actor_user_id ?? null;
}

export async function readPaidCaseRun(
  db: D1Database,
  key: PaidCaseKey
): Promise<PaidCaseRunRow | null> {
  return db
    .prepare(`SELECT * FROM benchmark_case_runs WHERE ${caseKeyPredicate()}`)
    .bind(...keyParams(key))
    .first<PaidCaseRunRow>();
}

export async function readPaidCasePayers(
  db: D1Database,
  key: PaidCaseKey,
  generation?: number
): Promise<PaidCasePayerRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM benchmark_case_payers WHERE ${caseKeyPredicate()}
        ${generation === undefined ? '' : 'AND generation = ?'}
      ORDER BY owner_type, owner_id, request_id`
    )
    .bind(...keyParams(key), ...(generation === undefined ? [] : [generation]))
    .all<PaidCasePayerRow>();
  return rows.results;
}

// ---------------------------------------------------------------------------
// Quotes and requests
// ---------------------------------------------------------------------------

export async function createPaidBenchmarkQuote(
  db: D1Database,
  input: {
    id: string;
    owner: PaidCreditOwner;
    organizationId?: string | null;
    router: string;
    routerId: string;
    poolVersion: string;
    engineIdentity: string;
    context: string;
    plan: string;
    estimateMicrodollars: number;
    maximumMicrodollars: number;
    planCases: number;
    expiresAt: string;
    now?: number;
  }
): Promise<void> {
  const at = iso(input.now ?? Date.now());
  await db
    .prepare(
      `INSERT INTO paid_benchmark_quotes (
        id, owner_type, owner_id, organization_id, router, router_id, pool_version,
        engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
        plan_cases, expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.owner.ownerType,
      input.owner.ownerId,
      input.organizationId ?? null,
      input.router,
      input.routerId,
      input.poolVersion,
      input.engineIdentity,
      input.context,
      input.plan,
      input.estimateMicrodollars,
      input.maximumMicrodollars,
      input.planCases,
      input.expiresAt,
      at,
      at
    )
    .run();
}

export async function readPaidBenchmarkQuote(
  db: D1Database,
  quoteId: string
): Promise<PaidBenchmarkQuoteRow | null> {
  return db
    .prepare(`SELECT * FROM paid_benchmark_quotes WHERE id = ?`)
    .bind(quoteId)
    .first<PaidBenchmarkQuoteRow>();
}

/** Delete quotes nobody can start any more (expired and unstarted). */
export async function deleteExpiredPaidBenchmarkQuotes(
  db: D1Database,
  input: { before: number; limit?: number }
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM paid_benchmark_quotes
      WHERE id IN (
        SELECT id FROM paid_benchmark_quotes
        WHERE expires_at < ? AND started_request_id IS NULL LIMIT ?
      )`
    )
    .bind(iso(input.before), Math.min(Math.max(input.limit ?? 100, 1), 500))
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Consume a quote and create its request in one batch: the quote is bound to owner, pool
 * version, engine identity, case plan and maximum, so a start can never price one case
 * set and run another. The request starts `preparing`; activation needs a full stage.
 *
 * Result indexes: [0] quote consume, [1] request insert. Both are no-ops when another
 * live request holds the pool, so a losing start leaves the quote usable.
 */
export function startPaidBenchmarkRequestStatements(
  db: D1Database,
  input: { quoteId: string; requestId: string; actorUserId: string; now?: number }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  return [
    // Consume the quote only when this start can actually create its request: a losing
    // a race must not poison the quote (a later authorized start may use it).
    db
      .prepare(
        `UPDATE paid_benchmark_quotes
        SET started_request_id = ?, updated_at = ?
        WHERE id = ? AND started_request_id IS NULL AND expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM paid_benchmark_requests AS live
            WHERE live.router_id = paid_benchmark_quotes.router_id
              AND live.status IN ('preparing', 'active')
          )`
      )
      .bind(input.requestId, at, input.quoteId, at),
    db
      .prepare(
        `INSERT INTO paid_benchmark_requests (
          id, owner_type, owner_id, organization_id, router, router_id, pool_version,
          engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
          charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
          context, created_at, updated_at
        )
        SELECT ?, owner_type, owner_id, organization_id, router, router_id, pool_version,
          engine_identity, 'preparing', id, estimate_microdollars, maximum_microdollars,
          0, plan_cases, 0, NULL, ?, context, ?, ?
        FROM paid_benchmark_quotes
        WHERE id = ? AND started_request_id = ?
          -- One live request per saved pool: the partial unique index is the backstop,
          -- this predicate keeps a losing race a no-op instead of a batch error.
          AND NOT EXISTS (
            SELECT 1 FROM paid_benchmark_requests AS live
            WHERE live.router_id = paid_benchmark_quotes.router_id
              AND live.status IN ('preparing', 'active')
          )`
      )
      .bind(input.requestId, input.actorUserId, at, at, input.quoteId, input.requestId),
  ];
}

export async function readPaidBenchmarkRequest(
  db: D1Database,
  requestId: string
): Promise<PaidBenchmarkRequestRow | null> {
  return db
    .prepare(`SELECT * FROM paid_benchmark_requests WHERE id = ?`)
    .bind(requestId)
    .first<PaidBenchmarkRequestRow>();
}

/**
 * Activate a request once its approved plan is fully staged. No hold and no outbox row:
 * per-model usage is billed just-in-time, so activation only makes its cases claimable.
 */
export function activatePaidBenchmarkRequestStatements(
  db: D1Database,
  input: { requestId: string; now?: number }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  return [
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET status = 'active', activated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'preparing' AND plan_cases > 0
          AND staged_cases = plan_cases`
      )
      .bind(at, at, input.requestId),
  ];
}

/**
 * Close a request from any live state: detach its payer rows so no new assignment picks
 * it, cancel the case runs it was alone in paying (a durable cancellation intent for
 * each), and mark its case rows. `pause_reason` distinguishes a billing pause
 * (`no_funds`) from an owner pause; the case-level close reason distinguishes an
 * explicit cancel from a pause.
 */
function closeRequestStatements(
  db: D1Database,
  input: {
    requestId: string;
    status: 'paused' | 'completed' | 'failed';
    reason?: string | null;
    retryable?: boolean;
    pauseReason?: 'no_funds' | 'owner' | null;
    requestCaseStatus: PaidBenchmarkRequestCaseRowStatus;
    now?: number;
  }
): D1PreparedStatement[] {
  const nowMs = input.now ?? Date.now();
  const at = iso(nowMs);
  const statusAssertion =
    input.status === 'failed'
      ? `failure_reason = ?, failure_retryable = ?`
      : input.status === 'paused'
        ? `paused_at = ?`
        : `completed_at = ?`;
  const statusBindings: Array<string | number | null> =
    input.status === 'failed' ? [input.reason ?? null, input.retryable ? 1 : 0] : [at];
  const closeId = `close:${input.requestId}`;
  return [
    db
      .prepare(
        `UPDATE paid_benchmark_requests SET status = ?, ${statusAssertion},
          pause_reason = ?, updated_at = ?
        WHERE id = ? AND status IN ('preparing', 'active')`
      )
      .bind(input.status, ...statusBindings, input.pauseReason ?? null, at, input.requestId),
    db
      .prepare(
        `UPDATE benchmark_case_payers SET status = 'detached', reason = ?, updated_at = ?
        WHERE request_id = ? AND status = 'eligible'`
      )
      .bind(input.reason ?? null, at, input.requestId),
    db
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = ?, failure_reason = ?, settled_at = ?, settlement_id = ?,
          updated_at = ?
        WHERE status IN ('queued', 'running') AND platform_covered = 0
          AND EXISTS (
            SELECT 1 FROM paid_benchmark_request_cases AS mine
            WHERE mine.engine_identity = benchmark_case_runs.engine_identity
              AND mine.model = benchmark_case_runs.model
              AND mine.variant = benchmark_case_runs.variant
              AND mine.rep = benchmark_case_runs.rep
              AND mine.case_id = benchmark_case_runs.case_id
              AND mine.request_id = ?
          )
          -- No other active payer and no platform cover: this request owned the slot.
          AND NOT EXISTS (
            SELECT 1 FROM paid_benchmark_request_cases AS other
            JOIN paid_benchmark_requests AS request ON request.id = other.request_id
            WHERE other.engine_identity = benchmark_case_runs.engine_identity
              AND other.model = benchmark_case_runs.model
              AND other.variant = benchmark_case_runs.variant
              AND other.rep = benchmark_case_runs.rep
              AND other.case_id = benchmark_case_runs.case_id
              AND other.status IN ('queued', 'running')
              AND request.status = 'active' AND other.request_id <> ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM benchmark_case_payers AS payer
            WHERE payer.engine_identity = benchmark_case_runs.engine_identity
              AND payer.model = benchmark_case_runs.model
              AND payer.variant = benchmark_case_runs.variant
              AND payer.rep = benchmark_case_runs.rep
              AND payer.case_id = benchmark_case_runs.case_id
              AND payer.generation = benchmark_case_runs.generation
              AND payer.status = 'eligible' AND payer.request_id <> ?
          )`
      )
      .bind(
        input.pauseReason === 'no_funds' ? 'paused' : 'cancelled',
        input.reason ?? null,
        at,
        closeId,
        at,
        input.requestId,
        input.requestId,
        input.requestId
      ),
    db
      .prepare(
        `INSERT INTO paid_benchmark_cancellations (
          engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, status, attempts, available_at, created_at, updated_at
        )
        SELECT engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, 'pending', 0, ?, ?, ?
        FROM benchmark_case_runs
        WHERE status = ? AND settlement_id = ?
          AND executor_run_id IS NOT NULL AND executor_token IS NOT NULL
        ON CONFLICT DO NOTHING`
      )
      .bind(
        nowMs,
        nowMs,
        nowMs,
        input.pauseReason === 'no_funds' ? 'paused' : 'cancelled',
        closeId
      ),
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases SET status = ?, reason = ?, updated_at = ?
        WHERE request_id = ? AND status IN ('queued', 'running')`
      )
      .bind(input.requestCaseStatus, input.reason ?? null, at, input.requestId),
  ];
}

export function pausePaidBenchmarkRequestStatements(
  db: D1Database,
  input: {
    requestId: string;
    reason: 'no_funds' | 'owner';
    now?: number;
  }
): D1PreparedStatement[] {
  return closeRequestStatements(db, {
    requestId: input.requestId,
    status: 'paused',
    reason: input.reason,
    pauseReason: input.reason,
    requestCaseStatus: 'paused',
    now: input.now,
  });
}

export function completePaidBenchmarkRequestStatements(
  db: D1Database,
  input: { requestId: string; now?: number }
): D1PreparedStatement[] {
  return closeRequestStatements(db, {
    ...input,
    status: 'completed',
    requestCaseStatus: 'paused',
  });
}

export function failPaidBenchmarkRequestStatements(
  db: D1Database,
  input: { requestId: string; reason: string; retryable: boolean; now?: number }
): D1PreparedStatement[] {
  return closeRequestStatements(db, {
    ...input,
    status: 'failed',
    requestCaseStatus: 'failed',
  });
}

/**
 * A request-facing reason for a case that finished without a usable result, when its own
 * canonical run recorded no controlled reason. Deliberately fixed copy: the raw scored error
 * of a shared execution can carry another payer's or provider's details, and the display row
 * is user-facing, so it never copies it.
 */
export const PAID_CASE_UNUSABLE_REASON = 'The measurement finished without a usable result.';

/**
 * Bring one request's **display** rows in line with the canonical case runs.
 *
 * `paid_benchmark_request_cases` is the console and aggregation view; `benchmark_case_runs`
 * is the measurement. A case that has conclusively finished unusable — `settled` with
 * `result_usable = 0`, or `failed` — must not leave its display row `queued`, or the request
 * waits forever on work nobody can measure any more. This is the only reconciliation that
 * turns a measured slot into `done`.
 *
 * Only a terminal canonical state can move a row: `queued`, `running`, `paused` and
 * `cancelled` runs are never read here, so a transient stop is never reported as terminal.
 *
 * The two statements split by what the row is now, so repeated passes do no work:
 * - `[0]` promotes an already `failed` row to `done` only when its run later proves usable —
 *   a shared result that lands after the slot was written stays reusable;
 * - `[1]` moves a `queued`/`running` row to its terminal display state, and never re-rewrites
 *   a row it already settled.
 *
 * The reason comes from the run's own controlled `failure_reason`, else
 * {@link PAID_CASE_UNUSABLE_REASON}. Raw scored errors stay in `case_results` as diagnostics
 * and are never copied to this user-facing row. No statement charges or creates work.
 */
export function syncPaidRequestCaseDisplayStatements(
  db: D1Database,
  input: { requestId: string; now?: number }
): D1PreparedStatement[] {
  const at = iso(input.now ?? Date.now());
  const caseKeyJoin = `run.engine_identity = rc.engine_identity
    AND run.model = rc.model AND run.variant = rc.variant
    AND run.rep = rc.rep AND run.case_id = rc.case_id`;
  return [
    // A terminal row whose measurement later proves usable. Only `failed` is a candidate, and
    // only a usable run matches, so a settled row is never touched again.
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases AS rc
        SET status = 'done', reason = NULL, updated_at = ?
        FROM benchmark_case_runs AS run
        WHERE ${caseKeyJoin}
          AND rc.request_id = ? AND rc.status = 'failed'
          AND run.status IN ('settled', 'failed') AND run.result_usable = 1`
      )
      .bind(at, input.requestId),
    // A live display row whose canonical run is already terminal.
    db
      .prepare(
        `UPDATE paid_benchmark_request_cases AS rc
        SET status = CASE WHEN run.result_usable = 1 THEN 'done' ELSE 'failed' END,
          reason = CASE WHEN run.result_usable = 1 THEN NULL
            ELSE COALESCE(run.failure_reason, ?) END,
          updated_at = ?
        FROM benchmark_case_runs AS run
        WHERE ${caseKeyJoin}
          AND rc.request_id = ? AND rc.status IN ('queued', 'running')
          AND run.status IN ('settled', 'failed')`
      )
      .bind(PAID_CASE_UNUSABLE_REASON, at, input.requestId),
  ];
}

const PROGRESS_CASE_STATUSES = ['queued', 'running', 'reused', 'done', 'failed', 'paused'] as const;

type ProgressCaseRow = {
  engine_identity: string;
  model: string;
  variant: string;
  rep: number;
  case_id: string;
  status: PaidBenchmarkRequestCaseRowStatus;
  covered_by_kilo: number;
  reason: string | null;
};

function encodeCursor(row: ProgressCaseRow): string {
  return encodeURIComponent(
    JSON.stringify([row.engine_identity, row.model, row.variant, row.rep, row.case_id])
  );
}

function decodeCursor(cursor: string): [string, string, string, number, string] {
  const parsed: unknown = JSON.parse(decodeURIComponent(cursor));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 5 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    !Number.isSafeInteger(parsed[3]) ||
    typeof parsed[4] !== 'string'
  )
    throw new Error('invalid paid benchmark cursor');
  return [parsed[0], parsed[1], parsed[2], parsed[3] as number, parsed[4]];
}

/**
 * The contract progress view: request totals, per-status counts and a page of case
 * rows. `reservedMicrodollars` is 0 under just-in-time billing; `chargedMicrodollars`
 * is the accepted usage the native writer billed.
 */
export async function readPaidBenchmarkProgress(
  db: D1Database,
  input: { requestId: string; cursor?: string; limit?: number }
): Promise<PaidBenchmarkProgress> {
  const request = await readPaidBenchmarkRequest(db, input.requestId);
  if (!request) return { status: 'empty' };
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const cursorPredicate = cursor
    ? `AND (
        engine_identity > ? OR
        (engine_identity = ? AND (
          model > ? OR
          (model = ? AND (
            variant > ? OR
            (variant = ? AND (rep > ? OR (rep = ? AND case_id > ?)))
          ))
        ))
      )`
    : '';
  const cursorBindings = cursor
    ? [
        cursor[0],
        cursor[0],
        cursor[1],
        cursor[1],
        cursor[2],
        cursor[2],
        cursor[3],
        cursor[3],
        cursor[4],
      ]
    : [];
  const [counts, cases, usage, pending] = await Promise.all([
    db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM paid_benchmark_request_cases
        WHERE request_id = ? GROUP BY status`
      )
      .bind(input.requestId)
      .all<{ status: PaidBenchmarkRequestCaseRowStatus; count: number }>(),
    db
      .prepare(
        `SELECT engine_identity, model, variant, rep, case_id, status, covered_by_kilo, reason
        FROM paid_benchmark_request_cases
        WHERE request_id = ? ${cursorPredicate}
        ORDER BY engine_identity, model, variant, rep, case_id LIMIT ?`
      )
      .bind(input.requestId, ...cursorBindings, limit + 1)
      .all<ProgressCaseRow>(),
    // Billed and pending are scoped to THIS request only: `usage.request_id` for a pool
    // charge, and `model.pool_request_id` for an in-flight admitted call. A shared case
    // therefore never bills B for A's call, and B's pending never counts A's outstanding
    // admitted request.
    db
      .prepare(
        `SELECT usage.engine_identity, usage.model, usage.variant, usage.rep,
          usage.case_id, COUNT(*) AS billed,
          COALESCE(SUM(usage.microdollars), 0) AS billed_microdollars,
          0 AS covered, 0 AS covered_microdollars
        FROM paid_attempt_usage AS usage
        WHERE usage.request_id = ? AND usage.platform_covered = 0
        GROUP BY usage.engine_identity, usage.model, usage.variant, usage.rep, usage.case_id
        UNION ALL
        -- Genuine live Kilo coverage for a case this request shares: a covered receipt
        -- carries no paying pool request, so it is found by the case key. The staged row
        -- must not be 'reused' (a historical result is not live coverage), and the partial
        -- index keeps this a seek.
        SELECT usage.engine_identity, usage.model, usage.variant, usage.rep,
          usage.case_id, 0, 0, COUNT(*), SUM(usage.microdollars)
        FROM paid_benchmark_request_cases AS staged
        JOIN paid_attempt_usage AS usage
          ON usage.engine_identity = staged.engine_identity
          AND usage.model = staged.model AND usage.variant = staged.variant
          AND usage.rep = staged.rep AND usage.case_id = staged.case_id
          AND usage.platform_covered = 1
          -- The generation THIS request's row joined, never the run's current one: a
          -- reclaimed generation's Kilo receipts are not cover for the newer exclusive user
          -- generation on the same slot, and an old paused row keeps its own generation.
          AND usage.generation = staged.generation
        WHERE staged.request_id = ? AND staged.status <> 'reused'
        GROUP BY usage.engine_identity, usage.model, usage.variant, usage.rep, usage.case_id`
      )
      .bind(input.requestId, input.requestId)
      .all<{
        engine_identity: string;
        model: string;
        variant: string;
        rep: number;
        case_id: string;
        billed: number;
        billed_microdollars: number;
        covered: number;
        covered_microdollars: number;
      }>(),
    // Admitted calls this request owns (`model.pool_request_id`), without a native
    // receipt yet. `admitted` is only the small in-flight set, so
    // IX_paid_model_requests_state bounds it. Kilo-covered calls are excluded because
    // Kilo, not the owner, owes them.
    db
      .prepare(
        `SELECT COUNT(*) AS owner_pending FROM paid_model_requests AS model
        WHERE model.state = 'admitted' AND model.platform_covered = 0
          AND model.pool_request_id = ?`
      )
      .bind(input.requestId)
      .all<{ owner_pending: number | null }>(),
  ]);
  // The aggregate is two indexed branches (own charges, shared Kilo coverage), so a case
  // can appear twice: merge by case, summing the disjoint counters.
  const usageByCase = new Map<string, (typeof usage.results)[number]>();
  for (const row of usage.results) {
    const id = paidCaseRunId({
      engineIdentity: row.engine_identity,
      model: row.model,
      variant: row.variant,
      rep: row.rep,
      caseId: row.case_id,
    });
    const existing = usageByCase.get(id);
    if (!existing) {
      usageByCase.set(id, { ...row });
      continue;
    }
    existing.billed += Number(row.billed);
    existing.billed_microdollars += Number(row.billed_microdollars);
    existing.covered += Number(row.covered);
    existing.covered_microdollars += Number(row.covered_microdollars);
  }
  const usageTotals = [...usageByCase.values()].reduce(
    (totals, row) => ({
      billed: totals.billed + Number(row.billed),
      covered: totals.covered + Number(row.covered),
      coveredMicrodollars: totals.coveredMicrodollars + Number(row.covered_microdollars),
    }),
    { billed: 0, covered: 0, coveredMicrodollars: 0 }
  );
  const countMap = Object.fromEntries(
    counts.results.map(row => [row.status, Number(row.count)])
  ) as Record<string, number>;
  const page = cases.results.slice(0, limit);
  const fields = {
    id: request.id,
    estimateMicrodollars: request.estimate_microdollars,
    maximumMicrodollars: request.maximum_microdollars,
    chargedMicrodollars: request.charged_microdollars,
    billedModelRequests: usageTotals.billed,
    kiloCoveredModelRequests: usageTotals.covered,
    kiloCoveredMicrodollars: usageTotals.coveredMicrodollars,
    pendingModelRequests: Number(pending.results[0]?.owner_pending ?? 0),
    counts: Object.fromEntries(
      PROGRESS_CASE_STATUSES.map(status => [status, countMap[status] ?? 0])
    ) as Record<(typeof PROGRESS_CASE_STATUSES)[number], number>,
    cases: page.map(row => {
      const caseId = paidCaseRunId({
        engineIdentity: row.engine_identity,
        model: row.model,
        variant: row.variant,
        rep: row.rep,
        caseId: row.case_id,
      });
      const caseUsage = usageByCase.get(caseId);
      return {
        id: caseId,
        model: row.model,
        variant: row.variant === '' ? null : row.variant,
        caseId: row.case_id,
        repetition: row.rep,
        status: row.status,
        billedModelRequests: Number(caseUsage?.billed ?? 0),
        kiloCoveredModelRequests: Number(caseUsage?.covered ?? 0),
        kiloCoveredMicrodollars: Number(caseUsage?.covered_microdollars ?? 0),
        // The quote's promise or a covered receipt this row actually shares. A case that
        // only carries the staged default was never covered.
        coveredByKilo: row.covered_by_kilo === 1 || Number(caseUsage?.covered ?? 0) > 0,
        // This owner's own receipts for this case, never the Kilo amount: `charged` and
        // `covered` are disjoint branches, so nothing is counted twice.
        chargedMicrodollars: Number(caseUsage?.billed_microdollars ?? 0),
        reason: wireCaseReason(row.reason),
      };
    }),
    nextCursor:
      cases.results.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
  };
  switch (request.status) {
    case 'preparing':
      return { status: 'preparing', ...fields };
    case 'active':
      return { status: 'active', ...fields };
    case 'completed':
      return { status: 'completed', ...fields };
    case 'paused': {
      // Every affected model, not only the first case page: the UI needs the full set
      // to explain a payment pause. Bounded by the request index, no extra storage.
      const models = await db
        .prepare(
          `SELECT DISTINCT model FROM paid_benchmark_request_cases
          WHERE request_id = ? AND status = 'paused'
          ORDER BY model`
        )
        .bind(input.requestId)
        .all<{ model: string }>();
      return {
        status: 'paused',
        ...fields,
        reason: request.pause_reason === 'no_funds' ? 'insufficient funds' : null,
        pausedModels: models.results.map(row => row.model),
      };
    }
    case 'failed':
      return {
        status: 'failed',
        ...fields,
        reason: request.failure_reason ?? 'benchmark request failed',
        retryable: request.failure_retryable === 1,
      };
    default:
      return { status: 'preparing', ...fields };
  }
}

// ---------------------------------------------------------------------------
// Pins outbox (bookkeeping only, amount 0)
// ---------------------------------------------------------------------------

export async function claimPaidBillingOutbox(
  db: D1Database,
  input: { limit: number; now?: number }
): Promise<PaidBillingOutboxRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM paid_benchmark_billing_outbox AS intent
      WHERE intent.status = 'pending' AND intent.available_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM paid_benchmark_billing_outbox AS earlier
          WHERE earlier.request_id = intent.request_id AND earlier.status = 'pending'
            AND earlier.seq < intent.seq
        )
      ORDER BY intent.seq LIMIT ?`
    )
    .bind(input.now ?? Date.now(), Math.min(Math.max(input.limit, 1), 500))
    .all<PaidBillingOutboxRow>();
  return rows.results;
}

export async function markPaidBillingOutboxDelivered(
  db: D1Database,
  input: { ids: readonly string[]; now?: number }
): Promise<void> {
  if (input.ids.length === 0) return;
  const nowMs = input.now ?? Date.now();
  await db
    .prepare(
      `UPDATE paid_benchmark_billing_outbox
      SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL
      WHERE status = 'pending' AND id IN (${input.ids.map(() => '?').join(', ')})`
    )
    .bind(nowMs, nowMs, ...input.ids)
    .run();
}

export async function failPaidBillingOutbox(
  db: D1Database,
  input: { id: string; error: string; now?: number }
): Promise<void> {
  const nowMs = input.now ?? Date.now();
  await db
    .prepare(
      `UPDATE paid_benchmark_billing_outbox
      SET attempts = attempts + 1,
        available_at = ? + MIN(3600000, 60000 * (1 << MIN(attempts, 6))),
        last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`
    )
    .bind(nowMs, input.error.slice(0, 500), nowMs, input.id)
    .run();
}

// ---------------------------------------------------------------------------
// Cancellation intents
// ---------------------------------------------------------------------------

/** Pending cancellations in retry order; a cancelled generation keeps retrying. */
export async function claimPaidCaseCancellations(
  db: D1Database,
  input: { limit: number; now?: number }
): Promise<PaidCaseCancellationRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM paid_benchmark_cancellations
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY available_at, created_at LIMIT ?`
    )
    .bind(input.now ?? Date.now(), Math.min(Math.max(input.limit, 1), 200))
    .all<PaidCaseCancellationRow>();
  return rows.results;
}

export async function markPaidCaseCancellationDelivered(
  db: D1Database,
  input: { key: PaidCaseKey; generation: number; now?: number }
): Promise<void> {
  const nowMs = input.now ?? Date.now();
  await db
    .prepare(
      `UPDATE paid_benchmark_cancellations
      SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL
      WHERE ${caseKeyPredicate()} AND generation = ? AND status = 'pending'`
    )
    .bind(nowMs, nowMs, ...keyParams(input.key), input.generation)
    .run();
}

export async function failPaidCaseCancellation(
  db: D1Database,
  input: { key: PaidCaseKey; generation: number; error: string; now?: number }
): Promise<void> {
  const nowMs = input.now ?? Date.now();
  await db
    .prepare(
      `UPDATE paid_benchmark_cancellations
      SET attempts = attempts + 1,
        available_at = ? + MIN(900000, 30000 * (1 << MIN(attempts, 5))),
        last_error = ?, updated_at = ?
      WHERE ${caseKeyPredicate()} AND generation = ? AND status = 'pending'`
    )
    .bind(nowMs, input.error.slice(0, 500), nowMs, ...keyParams(input.key), input.generation)
    .run();
}
