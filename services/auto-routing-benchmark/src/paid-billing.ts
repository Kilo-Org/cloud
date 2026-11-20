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
import { PaidBenchmarkPlanSchema } from './paid-benchmark-plan';

const DELIVERY_TIMEOUT_MS = 10_000;

export type PaidBillingEnv = {
  BENCH_DB: D1Database;
  KILO_WEB_API_BASE_URL: string;
  INTERNAL_API_SECRET_PROD: SecretsStoreSecret;
};

async function internalHeaders(env: PaidBillingEnv): Promise<Record<string, string>> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  // Both headers carry the same shared secret; the web accepts either spelling.
  return { 'content-type': 'application/json', 'x-internal-api-key': secret };
}

async function deliverPaidPoolPins(
  env: PaidBillingEnv,
  body: CustomRouterPoolPinsRequest,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; response: CustomRouterPoolPinsResponse } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(CUSTOM_ROUTER_POOL_PINS_PATH, env.KILO_WEB_API_BASE_URL), {
      method: 'POST',
      headers: await internalHeaders(env),
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

export type PaidBillingDrain = {
  delivered: number;
  retried: number;
  pinned: number;
};

export type PaidPinsPublication =
  | { published: false; reason: string; retryable: boolean }
  | { published: true; applied: number; poolUnchanged: boolean };

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
  if (request.status !== 'completed')
    return { published: false, reason: 'request_not_completed', retryable: false };
  const quote: PaidBenchmarkQuoteRow | null = await readPaidBenchmarkQuote(
    env.BENCH_DB,
    request.quote_id
  );
  if (!quote) return { published: false, reason: 'quote_missing', retryable: false };
  const plan = PaidBenchmarkPlanSchema.safeParse(JSON.parse(quote.plan));
  if (!plan.success || plan.data.aliases.length === 0)
    return { published: false, reason: 'no_aliases', retryable: false };
  const usable = await env.BENCH_DB.prepare(
    `SELECT DISTINCT model FROM paid_benchmark_request_cases
    WHERE request_id = ? AND status IN ('done', 'reused')`
  )
    .bind(request.id)
    .all<{ model: string }>();
  const usableModels = new Set(usable.results.map(row => row.model));
  const aliases = plan.data.aliases.filter(alias => usableModels.has(alias.target));
  if (aliases.length === 0)
    return { published: false, reason: 'no_usable_targets', retryable: false };

  const body = CustomRouterPoolPinsRequestSchema.safeParse({
    routerId: request.router_id,
    ownerType: request.owner_type === 'organization' ? 'org' : 'user',
    ownerId: request.owner_id,
    poolVersion: request.pool_version,
    requestId: request.id,
    // The explicit click that confirmed the target; a pin never moves on completion time.
    confirmedAt: request.activated_at ?? request.created_at,
    aliases,
  });
  if (!body.success) return { published: false, reason: 'pins_payload_invalid', retryable: false };
  const delivery = await deliverPaidPoolPins(env, body.data, fetchImpl);
  if (!delivery.ok) return { published: false, reason: delivery.error, retryable: true };
  return {
    published: true,
    applied: delivery.response.applied.length,
    poolUnchanged: delivery.response.poolUnchanged,
  };
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
  const summary: PaidBillingDrain = { delivered: 0, retried: 0, pinned: 0 };
  for (const row of rows) {
    if (options.requestId !== undefined && row.request_id !== options.requestId) continue;
    let request = requests.get(row.request_id);
    if (request === undefined) {
      request = await readPaidBenchmarkRequest(db, row.request_id);
      requests.set(row.request_id, request);
    }
    if (!request) {
      await failPaidBillingOutbox(db, {
        id: row.id,
        error: 'benchmark request row is missing',
        now: options.now,
      });
      summary.retried += 1;
      continue;
    }
    const publication = await publishPaidPoolPins(env, request, fetchImpl);
    if (publication.published) summary.pinned += 1;
    if (publication.published || !publication.retryable) {
      await markPaidBillingOutboxDelivered(db, { ids: [row.id], now: options.now });
      summary.delivered += 1;
    } else {
      await failPaidBillingOutbox(db, {
        id: row.id,
        error: publication.reason,
        now: options.now,
      });
      summary.retried += 1;
    }
  }
  return summary;
}
