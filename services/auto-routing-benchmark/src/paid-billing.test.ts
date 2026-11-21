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
 * A current ready registry row for one target. Publication pins a target only while its row
 * still exists at this engine and repetition count and names its measuring run, so a test that
 * expects a pin must seed this. `runId` null models a withdrawn/incomplete row on purpose.
 */
function seedReadyProfile(model: string, runId: string | null, variant = ''): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO benchmark_profiles
        (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
          updated_at)
      VALUES ('efficient', ?, ?, 'engine-test', 3, 'ready', ?, ?, ?)`
    )
    .run(model, variant, runId, AT, AT);
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
    // The target must still serve for the callback to pin it; this test is about delivery.
    seedReadyProfile('vendor/alpha', 'run-ready');
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
    seedReadyProfile('vendor/alpha', 'run-ready');
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
    seedReadyProfile('vendor/alpha', 'run-ready');
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
    // The confirmed target must still be a ready row that names its measuring run, or the
    // callback withholds the pin; this test is about which alias is published, not about a
    // withdrawn target (covered separately).
    seedReadyProfile('vendor/alpha', 'run-ready');
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

  it('publishes a pin-only move only while its serving evidence is still ready', async () => {
    const first = PLAN.pairs[0];
    if (!first) throw new Error('fixture plan lost its pair');
    const pinOnly: PaidBenchmarkPlan = {
      ...PLAN,
      pairs: [{ ...first, serving: true, missing: btoa('\0'), cost: [0] }],
      counts: { reused: 3, covered: 0, shared: 0, exclusive: 0 },
      estimateMicrodollars: 0,
      maximumMicrodollars: 0,
    };
    seedRequest('completed');
    sqlite.prepare('UPDATE paid_benchmark_quotes SET plan = ?').run(JSON.stringify(pinOnly));
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'reused', 0, 0, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    const completed = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!completed) throw new Error('request missing');
    // The target has no ready profile: the reused row alone must not move the pin.
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      published: false,
      reason: 'serving_evidence_gone',
      retryable: false,
    });
    expect(pins).toHaveLength(0);

    // A `ready` row with no `run_id` names no measuring run, so it is not serving evidence.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', '', 'engine-test', 3, 'ready', NULL, ?, ?)`
      )
      .run(AT, AT);
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      published: false,
      reason: 'serving_evidence_gone',
      retryable: false,
    });
    expect(pins).toHaveLength(0);

    // With the ready profile present, the same reused row publishes the exact target.
    sqlite
      .prepare(
        `UPDATE benchmark_profiles SET run_id = 'run-ready'
        WHERE model = 'vendor/alpha' AND engine_identity = 'engine-test'`
      )
      .run();
    expect((await publishPaidPoolPins(env(), completed)).published).toBe(true);
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
  });

  it('waits for a still-finalizing target, then pins it once it is ready', async () => {
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    // The case rows settled but the registry finalization is still running (this is also what
    // an alias-lease deferral looks like). The pin must not be dropped: it waits.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', '', 'engine-test', 3, 'running', 'run-live', ?, ?)`
      )
      .run(AT, AT);
    seedOutbox(`pins:${REQUEST_ID}`);
    const pending = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    expect(pending).toEqual({ delivered: 0, retried: 1, pinned: 0 });
    expect(pins).toHaveLength(0);
    // Still pending, so the intent survives for the next drain instead of being dropped.
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('pending');

    // Finalization completes: the same intent now delivers exactly once, at no extra cost.
    sqlite
      .prepare("UPDATE benchmark_profiles SET status = 'ready' WHERE model = 'vendor/alpha'")
      .run();
    const ready = await drainPaidBillingOutbox(env(), { limit: 5, now: 10 * 60 * 1000 });
    expect(ready.pinned).toBe(1);
    expect(pins).toHaveLength(1);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('delivered');
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
    expect(billing).toHaveLength(0);
  });

  it('withholds a withdrawn mixed target without blocking a ready sibling alias', async () => {
    const first = PLAN.pairs[0];
    if (!first) throw new Error('fixture plan lost its pair');
    // A mixed plan: the alias target became serving after the quote (so its display row is a
    // launch-time serving reuse) while a second pair is measured by this request.
    const mixed: PaidBenchmarkPlan = {
      ...PLAN,
      pairs: [
        { ...first, serving: true, missing: btoa('\0'), cost: [0] },
        {
          model: 'vendor/beta',
          variant: '',
          serving: false,
          missing: btoa('\u0001'),
          covered: btoa('\0'),
          cost: [20_000],
        },
      ],
      aliases: [
        { model: '~vendor/latest', target: 'vendor/alpha' },
        { model: '~vendor/other', target: 'vendor/beta' },
      ],
    };
    seedRequest('completed');
    sqlite.prepare('UPDATE paid_benchmark_quotes SET plan = ?').run(JSON.stringify(mixed));
    // The serving row carries the marker the launch reconcile writes; the sibling is `done`.
    const insertCase = sqlite.prepare(
      `INSERT INTO paid_benchmark_request_cases
        (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
          charged_microdollars, reason, updated_at)
      VALUES (?, 'engine-test', ?, '', 0, 'case-a', ?, 0, 0, ?, ?)`
    );
    insertCase.run(REQUEST_ID, 'vendor/alpha', 'reused', 'serving_reuse', AT);
    insertCase.run(REQUEST_ID, 'vendor/beta', 'done', null, AT);
    // Only the sibling's target still has ready provenance; the serving target was withdrawn.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/beta', '', 'engine-test', 3, 'ready', 'run-ready', ?, ?)`
      )
      .run(AT, AT);
    const completed = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!completed) throw new Error('request missing');

    // The marker row alone must not pin the withdrawn target, and the ready sibling still pins.
    expect(await publishPaidPoolPins(env(), completed)).toMatchObject({ published: true });
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/other', target: 'vendor/beta' },
    ]);

    // With no ready target left the callback withholds entirely, so nothing is invented.
    sqlite.prepare("DELETE FROM benchmark_profiles WHERE model = 'vendor/beta'").run();
    pins.length = 0;
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      published: false,
      reason: 'serving_evidence_gone',
      retryable: false,
    });
    expect(pins).toHaveLength(0);
  });

  it('waits while a sibling target is finalizing, then publishes both once', async () => {
    const first = PLAN.pairs[0];
    if (!first) throw new Error('fixture plan lost its pair');
    const mixed: PaidBenchmarkPlan = {
      ...PLAN,
      pairs: [
        { ...first, serving: true, missing: btoa('\0'), cost: [0] },
        {
          model: 'vendor/beta',
          variant: '',
          serving: true,
          missing: btoa('\0'),
          covered: btoa('\0'),
          cost: [0],
        },
      ],
      aliases: [
        { model: '~vendor/latest', target: 'vendor/alpha' },
        { model: '~vendor/other', target: 'vendor/beta' },
      ],
    };
    seedRequest('completed');
    sqlite.prepare('UPDATE paid_benchmark_quotes SET plan = ?').run(JSON.stringify(mixed));
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'reused', 0, 0, ?),
               (?, 'engine-test', 'vendor/beta', '', 0, 'case-a', 'done', 0, 20000, ?)`
      )
      .run(REQUEST_ID, AT, REQUEST_ID, AT);
    seedReadyProfile('vendor/alpha', 'run-alpha');
    // beta's registry row exists but is still finalizing.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/beta', '', 'engine-test', 3, 'running', 'run-beta', ?, ?)`
      )
      .run(AT, AT);
    seedOutbox(`pins:${REQUEST_ID}`);

    // A ready sibling must NOT be delivered alone: one intent delivers once, so delivering now
    // would permanently drop the sibling still finalizing.
    const waiting = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    expect(waiting).toEqual({ delivered: 0, retried: 1, pinned: 0 });
    expect(pins).toHaveLength(0);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('pending');

    // Terminal readiness publishes both aliases in the one intent.
    sqlite
      .prepare("UPDATE benchmark_profiles SET status = 'ready' WHERE model = 'vendor/beta'")
      .run();
    const delivered = await drainPaidBillingOutbox(env(), { limit: 5, now: 10 * 60 * 1000 });
    expect(delivered.pinned).toBe(1);
    expect(pins).toHaveLength(1);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('delivered');
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
      { model: '~vendor/other', target: 'vendor/beta' },
    ]);
    expect(billing).toHaveLength(0);
  });

  it('keeps both effort variants of one target, publishing while either is ready', async () => {
    const first = PLAN.pairs[0];
    if (!first) throw new Error('fixture plan lost its pair');
    // Two effort variants of the same model: a map keyed by model would keep only one, so a
    // ready high variant could be lost behind a still-finalizing low one (or the reverse).
    const twoVariants: PaidBenchmarkPlan = {
      ...PLAN,
      pairs: [
        { ...first, serving: true, missing: btoa('\0'), cost: [0] },
        { ...first, variant: 'high', serving: true, missing: btoa('\0'), cost: [0] },
      ],
    };
    seedRequest('completed');
    sqlite.prepare('UPDATE paid_benchmark_quotes SET plan = ?').run(JSON.stringify(twoVariants));
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'reused', 0, 0, ?)`
      )
      .run(REQUEST_ID, AT);
    // The default variant is ready; the high variant is still finalizing.
    seedReadyProfile('vendor/alpha', 'run-default', '');
    seedReadyProfile('vendor/alpha', 'run-high', 'high');
    sqlite.prepare("UPDATE benchmark_profiles SET status = 'running' WHERE variant = 'high'").run();
    const request = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!request) throw new Error('request missing');

    // The ready variant publishes the alias; the pending variant must not clobber it.
    expect((await publishPaidPoolPins(env(), request)).published).toBe(true);
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
  });
});
