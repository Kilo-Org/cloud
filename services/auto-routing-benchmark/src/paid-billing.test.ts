import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomRouterPoolPinsRequestSchema,
  benchmarkProjectId,
} from '@kilocode/auto-routing-contracts';
import { openPaidDatabase } from '../test/paid-benchmark-d1';
import { drainPaidBillingOutbox, publishPaidPoolPins } from './paid-billing';
import {
  completePaidBenchmarkRequestStatements,
  enqueuePaidPoolPinsStatement,
  readPaidBenchmarkRequest,
} from './paid-case-store';
import type { PaidBenchmarkPlan } from './paid-benchmark-plan';

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';
const ROUTER_ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-01-01T00:00:00.000Z';
// Distinct times so a pin can only carry the confirming click, never the completion.
const ACTIVATED_AT = '2026-01-01T00:05:00.000Z';
const COMPLETED_AT = '2026-01-01T00:10:00.000Z';

const PLAN: PaidBenchmarkPlan = {
  version: 1,
  router: 'efficient',
  engineIdentity: 'engine-test',
  revision: 3,
  repetitions: 3,
  caseIds: ['case-a'],
  pairs: [
    {
      model: 'vendor/alpha',
      variant: '',
      serving: false,
      missing: btoa(String.fromCharCode(0b00000001)),
      covered: btoa(String.fromCharCode(0)),
      cost: [20000],
    },
  ],
  counts: { reused: 2, covered: 0, shared: 0, exclusive: 1 },
  estimateMicrodollars: 20000,
  maximumMicrodollars: 20000,
  aliases: [{ model: '~vendor/latest', target: 'vendor/alpha' }],
  projectId: benchmarkProjectId({
    scope: 'user',
    slug: 'pool-one',
    routerId: '11111111-1111-4111-8111-111111111111',
  }),
};

let sqlite: ReturnType<typeof openPaidDatabase>['sqlite'];
let db: D1Database;
let pins: unknown[];
let billing: unknown[];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return input;
}

function installFetch(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const rawBody = init?.body;
    const body: unknown = typeof rawBody === 'string' ? JSON.parse(rawBody) : null;
    if (url.includes('/api/internal/auto-routing/pool-pins')) {
      const parsed = CustomRouterPoolPinsRequestSchema.safeParse(body);
      if (!parsed.success) return new Response('bad pins', { status: 400 });
      pins.push(parsed.data);
      return json({
        routerId: parsed.data.routerId,
        poolUnchanged: true,
        applied: [],
        skipped: [],
      });
    }
    billing.push(body);
    return new Response(JSON.stringify({ error: 'no billing expected' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function env() {
  return {
    BENCH_DB: db,
    KILO_WEB_API_BASE_URL: 'https://web.test',
    INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
  };
}

function seedRequest(
  status: 'preparing' | 'active' | 'completed' | 'paused' | 'failed' = 'active'
) {
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_requests
        (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
          quote_id, estimate_microdollars, maximum_microdollars, plan_cases, staged_cases,
          actor_user_id, context, created_at, updated_at, activated_at, completed_at)
      VALUES (?, 'user', 'user-1', 'efficient', ?, 'pool-v1', 'engine-test', ?, ?, 20000, 20000,
        3, 3, 'user-1', '{}', ?, ?, ?, ?)`
    )
    .run(
      REQUEST_ID,
      ROUTER_ID,
      status,
      QUOTE_ID,
      AT,
      AT,
      status === 'preparing' ? null : ACTIVATED_AT,
      status === 'completed' ? COMPLETED_AT : null
    );
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_quotes
        (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, context,
          plan, estimate_microdollars, maximum_microdollars, plan_cases, expires_at,
          created_at, updated_at)
      VALUES (?, 'user', 'user-1', 'efficient', ?, 'pool-v1', 'engine-test', '{}', ?, 20000,
        20000, 3, '2026-01-02T00:00:00.000Z', ?, ?)`
    )
    .run(QUOTE_ID, ROUTER_ID, JSON.stringify(PLAN), AT, AT);
}

/**
 * Seed an outbox row. `kind` is the schema's closed union (`'pins'`), so a retired monetary
 * kind has to be written as raw text by the migration-rehearsal fixture, not here.
 */
function seedOutbox(id: string): void {
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_billing_outbox
        (id, kind, request_id, owner_type, owner_id, amount_microdollars, status,
          attempts, available_at, created_at, updated_at)
      VALUES (?, 'pins', ?, 'user', 'user-1', 0, 'pending', 0, 0, 0, 0)`
    )
    .run(id, REQUEST_ID);
}

function outboxStatus(id: string): string | undefined {
  const row = sqlite
    .prepare('SELECT status FROM paid_benchmark_billing_outbox WHERE id = ?')
    .get(id) as { status: string } | undefined;
  return row?.status;
}

beforeEach(() => {
  const opened = openPaidDatabase();
  sqlite = opened.sqlite;
  db = opened.db;
  pins = [];
  billing = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paid billing outbox', () => {
  it('delivers a pin intent and leaves no monetary intent to send', async () => {
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    seedOutbox(`pins:${REQUEST_ID}`);
    const summary = await drainPaidBillingOutbox(env(), { limit: 5 });
    expect(summary.pinned).toBe(1);
    expect(pins).toHaveLength(1);
    expect(billing).toHaveLength(0);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('delivered');
    // Every remaining intent kind is the pins kind: no monetary intent exists to send.
    const kinds = sqlite
      .prepare('SELECT DISTINCT kind FROM paid_benchmark_billing_outbox')
      .all() as { kind: string }[];
    expect(kinds.map(row => row.kind)).toEqual(['pins']);
    // A replay of the same drain finds nothing claimable and sends nothing again.
    expect(await drainPaidBillingOutbox(env(), { limit: 5 })).toEqual({
      delivered: 0,
      retried: 0,
      pinned: 0,
    });
    expect(pins).toHaveLength(1);
  });

  it('pins a reused case row as usable and keeps one intent per request', async () => {
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'reused', 0, 0, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    // The store writes the deterministic id; a second enqueue for the same request is a no-op.
    await db.batch([
      enqueuePaidPoolPinsStatement(db, { requestId: REQUEST_ID, now: 0 }),
      enqueuePaidPoolPinsStatement(db, { requestId: REQUEST_ID, now: 0 }),
    ]);
    const rows = sqlite.prepare('SELECT id FROM paid_benchmark_billing_outbox').all() as {
      id: string;
    }[];
    expect(rows.map(row => row.id)).toEqual([`pins:${REQUEST_ID}`]);
    const summary = await drainPaidBillingOutbox(env(), { limit: 5 });
    expect(summary.pinned).toBe(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
  });

  it('keeps a failed pin delivery pending so the replay delivers it', async () => {
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 0, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    seedOutbox(`pins:${REQUEST_ID}`);
    const failing = async () => {
      throw new Error('network down');
    };
    const first = await drainPaidBillingOutbox(env(), {
      limit: 5,
      fetchImpl: failing as typeof fetch,
      now: 1_000,
    });
    expect(first.retried).toBe(1);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('pending');
    // Still inside the backoff: nothing is claimable yet.
    expect((await drainPaidBillingOutbox(env(), { limit: 5, now: 1_500 })).delivered).toBe(0);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('pending');
    await drainPaidBillingOutbox(env(), { limit: 5, now: 120_000 });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('delivered');
  });
});

describe('paid pool pins', () => {
  it('publishes only aliases whose confirmed target has a usable result, after completion', async () => {
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    const request = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!request) throw new Error('request missing');
    const published = await publishPaidPoolPins(env(), request);
    expect(published.published).toBe(true);
    expect(pins).toHaveLength(1);
    const body = CustomRouterPoolPinsRequestSchema.parse(pins[0]);
    expect(body.requestId).toBe(REQUEST_ID);
    expect(body.routerId).toBe(ROUTER_ID);
    expect(body.poolVersion).toBe('pool-v1');
    // The pin carries the click that authorized it, never the later completion time.
    expect(body.confirmedAt).toBe(ACTIVATED_AT);
    expect(body.confirmedAt).not.toBe(COMPLETED_AT);
    expect(body.aliases).toEqual([{ model: '~vendor/latest', target: 'vendor/alpha' }]);
  });

  it('never publishes for a paused request nor without a usable target', async () => {
    seedRequest('paused');
    const paused = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!paused) throw new Error('request missing');
    expect((await publishPaidPoolPins(env(), paused)).published).toBe(false);
    expect(pins).toHaveLength(0);

    sqlite
      .prepare(
        "UPDATE paid_benchmark_requests SET status = 'completed', completed_at = ?, activated_at = ?"
      )
      .run(COMPLETED_AT, ACTIVATED_AT);
    const completed = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!completed) throw new Error('request missing');
    // No case row says the target was measured, so nothing is pinned.
    expect((await publishPaidPoolPins(env(), completed)).published).toBe(false);
    expect(pins).toHaveLength(0);
  });

  it('publishes a moved alias mid-run for the confirmed target only, never the new one', async () => {
    // The confirmed plan named vendor/alpha. While the run is active the alias starts resolving to
    // vendor/beta; completion must still publish only the target that was measured under the click.
    seedRequest('active');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/beta', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    const beforeCompletion = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!beforeCompletion) throw new Error('request missing');
    expect((await publishPaidPoolPins(env(), beforeCompletion)).published).toBe(false);
    expect(pins).toHaveLength(0);

    sqlite
      .prepare(
        "UPDATE paid_benchmark_requests SET status = 'completed', completed_at = ?, activated_at = ?"
      )
      .run(AT, AT);
    const completed = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!completed) throw new Error('request missing');
    // Only beta has a usable row, and the plan never confirmed beta, so nothing may pin.
    expect(await publishPaidPoolPins(env(), completed)).toMatchObject({
      published: false,
      reason: 'no_usable_targets',
    });
    expect(pins).toHaveLength(0);
  });

  it('completes a request exactly once through the store mutator', async () => {
    seedRequest('active');
    await db.batch(completePaidBenchmarkRequestStatements(db, { requestId: REQUEST_ID }));
    expect((await readPaidBenchmarkRequest(db, REQUEST_ID))?.status).toBe('completed');
    // A second close is a no-op: the store only closes preparing/active requests.
    await db.batch(completePaidBenchmarkRequestStatements(db, { requestId: REQUEST_ID }));
    expect((await readPaidBenchmarkRequest(db, REQUEST_ID))?.status).toBe('completed');
  });
});
