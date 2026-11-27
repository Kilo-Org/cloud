/**
 * Durable bookkeeping delivery for paid benchmarks.
 *
 * Per-model spend happens through normal gateway usage, so this worker never holds, charges
 * or releases credit: accounting receipts come from the usage writer. The one intent this
 * module delivers is the pool-pin notification a completed request queues. Delivery is
 * ordered and idempotent per intent id.
 */
import {
  CUSTOM_ROUTER_POOL_PINS_PATH,
  CustomRouterPoolPinsRequestSchema,
  CustomRouterPoolPinsResponseSchema,
  type CustomRouterPoolPinsRequest,
  type CustomRouterPoolPinsResponse,
} from '@kilocode/auto-routing-contracts';
import {
  claimPaidBillingOutbox,
  failPaidBillingOutbox,
  markPaidBillingOutboxDelivered,
  readPaidBenchmarkQuote,
  readPaidBenchmarkRequest,
  type PaidBenchmarkQuoteRow,
  type PaidBenchmarkRequestRow,
} from './paid-case-store';
import { exactPairKey } from './db';
import type { BenchmarkProfileRowStatus } from './db-schema';
import { variantFromStorage } from './reasoning-effort';
import {
  PaidBenchmarkPlanSchema,
  isPinOnlyPlan,
  type PaidBenchmarkPlan,
} from './paid-benchmark-plan';
import {
  STS_WEB_AUTO_ROUTING_POOL_PINS_WRITE,
  webInternalCredential,
  type WebInternalAuthEnv,
} from '@kilocode/worker-utils/web-internal-credential';

const DELIVERY_TIMEOUT_MS = 10_000;

export type PaidBillingEnv = WebInternalAuthEnv & {
  BENCH_DB: D1Database;
  KILO_WEB_API_BASE_URL: string;
  INTERNAL_API_SECRET_PROD: SecretsStoreSecret;
};

async function deliverPaidPoolPins(
  env: PaidBillingEnv,
  body: CustomRouterPoolPinsRequest,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; response: CustomRouterPoolPinsResponse } | { ok: false; error: string }> {
  // The internal secret unless `WEB_INTERNAL_AUTH=sts`, then a `web:auto-routing.pool-pins.write`
  // STS token. Without one the intent stays pending for a later drain.
  const credential = await webInternalCredential(env, STS_WEB_AUTO_ROUTING_POOL_PINS_WRITE, {
    header: 'x-internal-api-key',
    secret: () => env.INTERNAL_API_SECRET_PROD.get(),
  });
  if (credential.kind === 'unavailable') {
    return { ok: false, error: `pool pins credential ${credential.reason}` };
  }
  let response: Response;
  try {
    response = await fetchImpl(new URL(CUSTOM_ROUTER_POOL_PINS_PATH, env.KILO_WEB_API_BASE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [credential.header]: credential.value },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'pool pins fetch failed' };
  }
  if (!response.ok) return { ok: false, error: `pool pins HTTP ${response.status}` };
  const parsed = CustomRouterPoolPinsResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  return parsed.success
    ? { ok: true, response: parsed.data }
    : { ok: false, error: 'pool pins response shape is invalid' };
}

/**
 * One drain pass. `delivered` counts intents that closed having adopted their effect (including
 * a replay the web already holds), `abandoned` counts intents closed without adoption,
 * `retried` counts intents left pending for a later pass, and `pinned` counts intents whose
 * attempt wrote at least one pin — so a partial delivery is visible while it is still pending.
 */
export type PaidBillingDrain = {
  delivered: number;
  retried: number;
  abandoned: number;
  pinned: number;
};

/**
 * What one pin intent did on this attempt. The outbox holds one row per request, so this
 * outcome decides whether that row closes:
 *
 * - `nothing`: the confirmed plan moves no alias, so the intent has no effect to deliver.
 * - `delivered`: every confirmed alias is pinned now, or already was — either by this request
 *   on an earlier attempt or by a newer confirmation that superseded it.
 * - `pending`: the outcome can still change. A run that is still `running` is finalizing a
 *   confirmed target, or the callback itself failed, so the row stays claimable for a later
 *   drain — bounded by {@link PAID_PINS_MAX_PENDING_ATTEMPTS}, because a run that never
 *   settles must not hold the effect forever.
 * - `abandoned`: the confirmation can never be adopted — the target's measurement was
 *   withdrawn, the pool was edited after the click, the alias stopped being a pinnable entry,
 *   the answer never accounted for it, or the request row is gone. The row closes *without*
 *   being counted as delivered and keeps the reason; when the plan was pin-only the drain also
 *   withdraws the completion, since for that shape this callback is the whole effect of the
 *   click. Nothing is measured, charged or re-estimated here; a fresh estimate stays an
 *   explicit owner action.
 *
 * `applied` is the web's own count of pins this attempt wrote, so a partial delivery is
 * visible even while a sibling target is still finalizing. `pinOnly` marks a request whose
 * plan moves still-serving pins and measures nothing, so its completion *is* the claim "the
 * pool now serves the confirmed target"; the drain uses it to withdraw that claim when the
 * move cannot be adopted.
 */
export type PaidPinsPublication =
  | { outcome: 'nothing' }
  | { outcome: 'delivered'; applied: number }
  | { outcome: 'pending'; reason: string; applied: number; pinOnly: boolean }
  | { outcome: 'abandoned'; reason: string; applied: number; pinOnly: boolean };

/** A live run is finalizing a confirmed target; the next drain publishes it. */
const PINS_EVIDENCE_PENDING = 'serving_evidence_pending';
/** Nothing is measuring a confirmed target, so only a fresh estimate can pin it. */
const PINS_EVIDENCE_GONE = 'serving_evidence_gone';
/** The saved pool changed after the click, so the confirmation no longer applies. */
const PINS_POOL_CHANGED = 'pool_changed';
/** This request has no settled or reused case row for any confirmed alias. */
const PINS_NO_USABLE_TARGET = 'no_usable_targets';

/**
 * How many drains may wait on a registry finalization before the move is reported as not
 * applied. A real finalization resolves in minutes, and the store's backoff is capped at an
 * hour, so this bounds the wait at roughly two days: enough for a slow run plus a quiet cron,
 * short enough that a run which never settles cannot hold a confirmed pin — and, for a pin-only
 * request, the click's whole effect — pending forever. The bound uses the outbox's own durable
 * attempt counter, so no clock decision is invented here.
 *
 * It applies only to {@link PINS_EVIDENCE_PENDING}. A callback or request-read failure is
 * transient infrastructure, so it keeps the ordinary backoff retry instead of being closed as a
 * lost effect after an outage.
 */
const PAID_PINS_MAX_PENDING_ATTEMPTS = 48;

/**
 * What the console and owner read when a pin-only request's move could not be applied. Fixed
 * copy, because the casing of an internal outbox reason is not user-facing text, and it names
 * the one action that can recover the target.
 */
export const PAID_PIN_NOT_APPLIED_REASON =
  'The measured target could not be pinned to this pool; request a new estimate.';

/**
 * Tell the web which confirmed alias targets now have a usable measurement. Only a completed
 * request publishes (never a pause or a failure); only aliases whose target has a settled or
 * reused case row in this request are sent; and `confirmedAt` is the click that authorized
 * the target, so replaying an older request cannot advance a newer pin.
 */
export async function publishPaidPoolPins(
  env: PaidBillingEnv,
  request: PaidBenchmarkRequestRow,
  fetchImpl: typeof fetch = fetch
): Promise<PaidPinsPublication> {
  // The intent and the completion are written in one batch, so a request that is not completed
  // is a transient read. Stay pending: the same deterministic intent delivers once it is.
  if (request.status !== 'completed')
    return { outcome: 'pending', reason: 'request_not_completed', applied: 0, pinOnly: false };
  const quote: PaidBenchmarkQuoteRow | null = await readPaidBenchmarkQuote(
    env.BENCH_DB,
    request.quote_id
  );
  // Neither shape can know whether the plan was pin-only, so neither reports a withdrawn claim.
  if (!quote) return { outcome: 'abandoned', reason: 'quote_missing', applied: 0, pinOnly: false };
  const plan = PaidBenchmarkPlanSchema.safeParse(JSON.parse(quote.plan));
  if (!plan.success)
    return { outcome: 'abandoned', reason: 'plan_invalid', applied: 0, pinOnly: false };
  // A pin-only plan measures nothing, so completing it claims the pool now serves the confirmed
  // target. That is the one shape whose whole effect can be withdrawn by a failed pin, which is
  // what the drain reports back on the request instead of leaving a bare success.
  const pinOnly = isPinOnlyPlan(plan.data);
  // A plan with no alias moves nothing, so this intent has no effect to lose.
  if (plan.data.aliases.length === 0) return { outcome: 'nothing' };
  const usable = await env.BENCH_DB.prepare(
    `SELECT DISTINCT model FROM paid_benchmark_request_cases
    WHERE request_id = ? AND status IN ('done', 'reused')`
  )
    .bind(request.id)
    .all<{ model: string }>();
  const usableModels = new Set(usable.results.map(row => row.model));
  const aliases = plan.data.aliases.filter(alias => usableModels.has(alias.target));
  if (aliases.length === 0)
    return { outcome: 'abandoned', reason: PINS_NO_USABLE_TARGET, applied: 0, pinOnly };
  // A `reused` progress row is not by itself proof that its target still serves: a plan-time
  // `serving` pair stages its rows from the quote's claim, and the launch reconcile converts a
  // queued row the same way, while the registry evidence behind either can be withdrawn before
  // this callback. So each alias is decided from its target's own current registry rows.
  //
  // A target may name several effort variants, and each is a separate registry row, so they
  // are grouped by model and never collapsed to one variant. The alias publishes while any of
  // its variants is ready with a measuring run — the same model-level rule the usable-target
  // filter above already uses.
  const targets = aliases.map(alias => ({
    alias,
    variants: plan.data.pairs
      .filter(pair => pair.model === alias.target)
      .map(pair => ({ model: pair.model, variant: variantFromStorage(pair.variant) })),
  }));
  const models = [...new Set(targets.flatMap(target => target.variants.map(pair => pair.model)))];
  // One bounded read. `model IN (...)` selects the registry PK prefix (router, model, …); the
  // exact (model, variant) pairing is then applied in JS, so this stays one indexed query
  // instead of a full-table expression scan.
  const statusByKey = new Map<
    string,
    { status: BenchmarkProfileRowStatus; runId: string | null }
  >();
  if (models.length > 0) {
    const rows = await env.BENCH_DB.prepare(
      `SELECT model, variant, status, run_id FROM benchmark_profiles
      WHERE router = ? AND engine_identity = ? AND repetitions = ?
        AND model IN (SELECT value FROM json_each(?))`
    )
      .bind(
        plan.data.router,
        plan.data.engineIdentity,
        plan.data.repetitions,
        JSON.stringify(models)
      )
      .all<{
        model: string;
        variant: string;
        status: BenchmarkProfileRowStatus;
        run_id: string | null;
      }>();
    for (const row of rows.results)
      statusByKey.set(exactPairKey(row.model, variantFromStorage(row.variant)), {
        status: row.status,
        runId: row.run_id,
      });
  }
  // The registry row's own `status`/`run_id` cannot prove a run is still alive: a run that
  // died leaves its rows `running` (the orphan sweep only fails them after its own age guard),
  // and `run_id` may name a run that is already terminal. Waiting on that would hold this
  // request's only effect pending forever, so liveness is read from `benchmark_runs` itself:
  // a `running` profile counts as finalizing only while its exact run is still `running`.
  const liveRunIds = new Set<string>();
  const runIds = [
    ...new Set(
      [...statusByKey.values()].flatMap(row =>
        row.status === 'running' && row.runId != null && row.runId !== '' ? [row.runId] : []
      )
    ),
  ];
  for (let offset = 0; offset < runIds.length; offset += 50) {
    const live = await env.BENCH_DB.prepare(
      `SELECT id FROM benchmark_runs WHERE status = 'running'
        AND id IN (SELECT value FROM json_each(?))`
    )
      .bind(JSON.stringify(runIds.slice(offset, offset + 50)))
      .all<{ id: string }>();
    for (const row of live.results) liveRunIds.add(row.id);
  }
  const statusOf = (pair: { model: string; variant: string | null }) =>
    statusByKey.get(exactPairKey(pair.model, pair.variant));
  const isReady = (pair: { model: string; variant: string | null }) => {
    const row = statusOf(pair);
    return row?.status === 'ready' && row.runId != null && row.runId !== '';
  };
  const isFinalizing = (pair: { model: string; variant: string | null }) => {
    const row = statusOf(pair);
    return row?.status === 'running' && row.runId != null && liveRunIds.has(row.runId);
  };
  // Three states per confirmed alias. `ready` pins now. `finalizing` is a row a live run owns,
  // so it must resolve and the next drain sees which way. `withdrawn` cannot become pinnable
  // from anything in flight: no row, a `ready` row with no measuring run, a requeued one, or a
  // `running` row whose run is no longer alive. Waiting on any of those would hold the ready
  // aliases (and a pin-only move's whole effect) hostage indefinitely, so `withdrawn` never
  // gates a delivery.
  const readyAliases: PaidBenchmarkPlan['aliases'] = [];
  const finalizingAliases: PaidBenchmarkPlan['aliases'] = [];
  const withdrawnAliases: PaidBenchmarkPlan['aliases'] = [];
  for (const target of targets) {
    if (target.variants.some(isReady)) readyAliases.push(target.alias);
    else if (target.variants.some(isFinalizing)) finalizingAliases.push(target.alias);
    else withdrawnAliases.push(target.alias);
  }
  const withdrawn = withdrawnAliases[0]?.target;
  if (readyAliases.length === 0)
    return finalizingAliases.length > 0
      ? { outcome: 'pending', reason: PINS_EVIDENCE_PENDING, applied: 0, pinOnly }
      : { outcome: 'abandoned', reason: PINS_EVIDENCE_GONE, applied: 0, pinOnly };

  const body = CustomRouterPoolPinsRequestSchema.safeParse({
    routerId: request.router_id,
    ownerType: request.owner_type === 'organization' ? 'org' : 'user',
    ownerId: request.owner_id,
    poolVersion: request.pool_version,
    requestId: request.id,
    // The explicit click that confirmed the target; a pin never moves on completion time.
    confirmedAt: request.activated_at ?? request.created_at,
    aliases: readyAliases,
  });
  if (!body.success)
    return { outcome: 'abandoned', reason: 'pins_payload_invalid', applied: 0, pinOnly };
  const delivery = await deliverPaidPoolPins(env, body.data, fetchImpl);
  if (!delivery.ok) return { outcome: 'pending', reason: delivery.error, applied: 0, pinOnly };
  const applied = delivery.response.applied.length;
  // A pool edited after the click pins nothing: the confirmation named a pool state that no
  // longer exists. No retry can change that, and a pin-only request's one effect is lost, so
  // the intent closes as abandoned instead of being counted as delivered.
  if (!delivery.response.poolUnchanged)
    return { outcome: 'abandoned', reason: PINS_POOL_CHANGED, applied, pinOnly };
  // `unchanged` (already pinned by this request) and `superseded` (a newer confirmation won)
  // are adoptions, not refusals. Anything else means this confirmed alias will never pin.
  const refused = delivery.response.skipped.find(
    skipped => skipped.reason !== 'unchanged' && skipped.reason !== 'superseded'
  );
  if (refused !== undefined)
    return { outcome: 'abandoned', reason: `pin_not_adopted:${refused.reason}`, applied, pinOnly };
  // `decideServingPins` answers for exactly the aliases it was sent — each is applied or
  // skipped — so an alias the answer does not mention has no adoption evidence. That answer is
  // a pure function of the pool, the alias list and `confirmedAt`, so a retry of the same
  // confirmation gets the same omission: retrying cannot fix it, and closing it as delivered
  // would drop that alias silently — for a pin-only request, the whole effect of the click.
  // It therefore becomes a terminal non-adoption naming the alias, while any pins the same
  // attempt did write stand (they are idempotent per request).
  const accounted = new Set([
    ...delivery.response.applied.map(entry => entry.model),
    ...delivery.response.skipped.map(entry => entry.model),
  ]);
  const unaccounted = readyAliases.find(alias => !accounted.has(alias.model));
  if (unaccounted !== undefined)
    return {
      outcome: 'abandoned',
      reason: `pin_delivery_unaccounted:${unaccounted.model}`,
      applied,
      pinOnly,
    };
  // Ready aliases were delivered above; one intent still waits for the siblings a live run is
  // finalizing, so the next drain sends them (re-sending the adopted ones is a no-op). A
  // withdrawn sibling cannot be recovered by this intent either, so it closes with its name
  // rather than dying silently beside the one that did pin.
  if (finalizingAliases.length > 0)
    return { outcome: 'pending', reason: PINS_EVIDENCE_PENDING, applied, pinOnly };
  if (withdrawn !== undefined)
    return { outcome: 'abandoned', reason: `pin_target_withdrawn:${withdrawn}`, applied, pinOnly };
  return { outcome: 'delivered', applied };
}

/**
 * Close an intent whose confirmed effect can never be adopted. Deliberately not `delivered`:
 * for a pin-only request this callback is the whole effect of the click, so the row keeps the
 * reason and stays visible instead of reporting success. Nothing re-enqueues it — a fresh
 * estimate is an explicit owner action — so `abandoned` is terminal.
 *
 * A pin-only request's completion claims the pool now serves the confirmed target, so that
 * claim is withdrawn in the *same* batch. Two separate writes would leave a terminal
 * `abandoned` intent beside a `completed` request if the process died between them, and no
 * later drain could repair it: the intent is already terminal, so the false success would
 * stand forever. The request statement runs first and is guarded on the intent still being
 * pending for that exact request, so it can only fire for the delivery that is closing it;
 * the outbox statement then fires unconditionally on the same pending row. Either both commit
 * or neither does, and a crash before the batch leaves the intent pending for the next drain.
 */
async function closeAbandonedOutboxIntent(
  db: D1Database,
  input: { id: string; requestId: string; error: string; pinOnly: boolean; now?: number }
): Promise<void> {
  const nowMs = input.now ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const outbox = db
    .prepare(
      `UPDATE paid_benchmark_billing_outbox
      SET status = 'abandoned', attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`
    )
    .bind(input.error.slice(0, 500), nowMs, input.id);
  if (!input.pinOnly) {
    await outbox.run();
    return;
  }
  // A mixed plan really did measure and charge, so only a pin-only shape withdraws completion.
  await db.batch([
    db
      .prepare(
        `UPDATE paid_benchmark_requests
        SET status = 'failed', failure_reason = ?, failure_retryable = 1, updated_at = ?
        WHERE id = ? AND status = 'completed' AND failure_reason IS NULL
          AND EXISTS (
            SELECT 1 FROM paid_benchmark_billing_outbox AS intent
            WHERE intent.id = ? AND intent.request_id = ? AND intent.status = 'pending'
          )`
      )
      .bind(PAID_PIN_NOT_APPLIED_REASON, at, input.requestId, input.id, input.requestId),
    outbox,
  ]);
}

/**
 * Deliver pending bookkeeping in durable order. The only intent kind is `pins`, and the
 * store only hands out a request's next intent when no earlier one is pending, so a later
 * effect can never overtake an earlier one. Delivery is idempotent per intent id.
 */
export async function drainPaidBillingOutbox(
  env: PaidBillingEnv,
  options: { limit?: number; requestId?: string; fetchImpl?: typeof fetch; now?: number } = {}
): Promise<PaidBillingDrain> {
  const db = env.BENCH_DB;
  const fetchImpl = options.fetchImpl ?? fetch;
  const rows = await claimPaidBillingOutbox(db, { limit: options.limit ?? 25, now: options.now });
  const requests = new Map<string, PaidBenchmarkRequestRow | null>();
  const summary: PaidBillingDrain = { delivered: 0, retried: 0, abandoned: 0, pinned: 0 };
  for (const row of rows) {
    if (options.requestId !== undefined && row.request_id !== options.requestId) continue;
    let request = requests.get(row.request_id);
    if (request === undefined) {
      request = await readPaidBenchmarkRequest(db, row.request_id);
      requests.set(row.request_id, request);
    }
    if (!request) {
      // No request means no confirmation to replay and no alias list to rebuild: the intent
      // can never be adopted, so it closes here instead of retrying forever.
      await closeAbandonedOutboxIntent(db, {
        id: row.id,
        requestId: row.request_id,
        error: 'benchmark request row is missing',
        pinOnly: false,
        now: options.now,
      });
      summary.abandoned += 1;
      continue;
    }
    const publication = await publishPaidPoolPins(env, request, fetchImpl);
    if (publication.outcome === 'nothing') {
      await markPaidBillingOutboxDelivered(db, { ids: [row.id], now: options.now });
      summary.delivered += 1;
      continue;
    }
    if (publication.applied > 0) summary.pinned += 1;
    switch (publication.outcome) {
      case 'delivered':
        await markPaidBillingOutboxDelivered(db, { ids: [row.id], now: options.now });
        summary.delivered += 1;
        break;
      case 'abandoned':
        // One batch: a pin-only request's completion is withdrawn only for the delivery that
        // closes its still-pending intent, so a crash can never strand a terminal intent beside
        // a false success.
        await closeAbandonedOutboxIntent(db, {
          id: row.id,
          requestId: row.request_id,
          error: publication.reason,
          pinOnly: publication.pinOnly,
          now: options.now,
        });
        summary.abandoned += 1;
        break;
      case 'pending': {
        // Bound consecutive finalization waits, not time spent retrying a different failure.
        const finalizing = publication.reason === PINS_EVIDENCE_PENDING;
        if (
          finalizing &&
          row.last_error === PINS_EVIDENCE_PENDING &&
          row.attempts >= PAID_PINS_MAX_PENDING_ATTEMPTS
        ) {
          await closeAbandonedOutboxIntent(db, {
            id: row.id,
            requestId: row.request_id,
            error: `${publication.reason}:no_progress`,
            pinOnly: publication.pinOnly,
            now: options.now,
          });
          summary.abandoned += 1;
          break;
        }
        await failPaidBillingOutbox(db, {
          id: row.id,
          error: publication.reason,
          resetOnReasonChange: finalizing,
          now: options.now,
        });
        summary.retried += 1;
        break;
      }
    }
  }
  return summary;
}
