import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomRouterPoolPinsRequestSchema,
  benchmarkProjectId,
} from '@kilocode/auto-routing-contracts';
import { openPaidDatabase } from '../test/paid-benchmark-d1';
import { sqliteD1 } from '../test/sqlite-d1';
import {
  PAID_PIN_NOT_APPLIED_REASON,
  drainPaidBillingOutbox,
  publishPaidPoolPins,
} from './paid-billing';
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
/** Pins the stub web already wrote, so a replay reports them as `unchanged`, like the real
 * pure decision does. */
let appliedPins: Set<string>;

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
      // Mirror `decideServingPins`: a target already pinned by this request is reported as
      // `unchanged`, so a replay of the same confirmation does not look like a lost effect.
      const applied: { model: string; target: string; pinnedAt: string }[] = [];
      const skipped: { model: string; reason: 'unchanged' }[] = [];
      for (const alias of parsed.data.aliases) {
        const key = `${alias.model}\u001f${alias.target}`;
        if (appliedPins.has(key)) skipped.push({ model: alias.model, reason: 'unchanged' });
        else {
          appliedPins.add(key);
          applied.push({ model: alias.model, target: alias.target, pinnedAt: AT });
        }
      }
      return json({
        routerId: parsed.data.routerId,
        poolUnchanged: true,
        applied,
        skipped,
      });
    }
    billing.push(body);
    return new Response(JSON.stringify({ error: 'no billing expected' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** A pins response the web would send when its pure decision refused to write anything. */
function refusedPins(
  reason: 'pool_changed' | 'entry_missing' | 'not_a_gateway_entry' | 'link_applies'
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!requestUrl(input).includes('/api/internal/auto-routing/pool-pins'))
      throw new Error('unexpected url');
    const parsed = CustomRouterPoolPinsRequestSchema.parse(
      typeof init?.body === 'string' ? JSON.parse(init.body) : null
    );
    pins.push(parsed);
    return json({
      routerId: parsed.routerId,
      poolUnchanged: reason !== 'pool_changed',
      applied: [],
      skipped: parsed.aliases.map(alias => ({ model: alias.model, reason })),
    });
  }) as typeof fetch;
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

/** A `benchmark_runs` row, so the registry claim can be proved live (or terminal). */
function seedRun(id: string, status: 'running' | 'completed' | 'failed'): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO benchmark_runs
        (id, router, kind, status, started_at, engine_identity, repetitions,
          measurement_revision, min_accuracy, switch_cost_factor, max_concurrency)
      VALUES (?, 'efficient', 'decider', ?, ?, 'engine-test', 3, 3, 0.7, 1, 80)`
    )
    .run(id, status, AT);
}

/** A `running` registry row claiming `runId`, exactly as an in-flight finalization looks. */
function seedRunningProfile(model: string, runId: string, variant = ''): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO benchmark_profiles
        (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
          updated_at)
      VALUES ('efficient', ?, ?, 'engine-test', 3, 'running', ?, ?, ?)`
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
  appliedPins = new Set();
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
      abandoned: 0,
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
    expect(published).toEqual({ outcome: 'delivered', applied: 1 });
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
    // The intent is written with the completion, so a non-completed read is a transient state
    // that the next drain re-checks rather than a failure to record.
    expect(await publishPaidPoolPins(env(), paused)).toEqual({
      outcome: 'pending',
      reason: 'request_not_completed',
      applied: 0,
      pinOnly: false,
    });
    expect(pins).toHaveLength(0);

    sqlite
      .prepare(
        "UPDATE paid_benchmark_requests SET status = 'completed', completed_at = ?, activated_at = ?"
      )
      .run(COMPLETED_AT, ACTIVATED_AT);
    const completed = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!completed) throw new Error('request missing');
    // No case row says the target was measured, so the confirmation cannot be adopted.
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      outcome: 'abandoned',
      reason: 'no_usable_targets',
      applied: 0,
      pinOnly: false,
    });
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
    expect((await publishPaidPoolPins(env(), beforeCompletion)).outcome).toBe('pending');
    expect(pins).toHaveLength(0);

    sqlite
      .prepare(
        "UPDATE paid_benchmark_requests SET status = 'completed', completed_at = ?, activated_at = ?"
      )
      .run(AT, AT);
    const completed = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!completed) throw new Error('request missing');
    // Only beta has a usable row, and the plan never confirmed beta, so nothing may pin.
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      outcome: 'abandoned',
      reason: 'no_usable_targets',
      applied: 0,
      pinOnly: false,
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
    // The target has no ready profile: the reused row alone must not move the pin, and for a
    // pin-only request that is the whole confirmed effect, so the intent closes as abandoned
    // rather than being reported delivered.
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      outcome: 'abandoned',
      reason: 'serving_evidence_gone',
      applied: 0,
      pinOnly: true,
    });
    expect(pins).toHaveLength(0);

    // A `ready` row with no `run_id` names no measuring run, so it is not serving evidence and
    // nothing is measuring it either: the same terminal refusal, not an indefinite wait.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', '', 'engine-test', 3, 'ready', NULL, ?, ?)`
      )
      .run(AT, AT);
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      outcome: 'abandoned',
      reason: 'serving_evidence_gone',
      applied: 0,
      pinOnly: true,
    });
    expect(pins).toHaveLength(0);

    // With the ready profile present, the same reused row publishes the exact target.
    sqlite
      .prepare(
        `UPDATE benchmark_profiles SET run_id = 'run-ready'
        WHERE model = 'vendor/alpha' AND engine_identity = 'engine-test'`
      )
      .run();
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      outcome: 'delivered',
      applied: 1,
    });
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
    // an alias-lease deferral looks like). Its run is live, so the pin must not be dropped: it
    // waits for a finalization that is actually in flight.
    seedRun('run-live', 'running');
    seedRunningProfile('vendor/alpha', 'run-live');
    seedOutbox(`pins:${REQUEST_ID}`);
    const pending = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    expect(pending).toEqual({ delivered: 0, retried: 1, abandoned: 0, pinned: 0 });
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

    // The marker row alone must not pin the withdrawn target; the ready sibling still pins in
    // the same pass. The withdrawn alias can never be adopted by this intent, so the outcome
    // names it instead of reporting a clean delivery.
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      outcome: 'abandoned',
      reason: 'pin_target_withdrawn:vendor/alpha',
      applied: 1,
      pinOnly: false,
    });
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/other', target: 'vendor/beta' },
    ]);

    // With no ready target left the callback withholds entirely, so nothing is invented.
    sqlite.prepare("DELETE FROM benchmark_profiles WHERE model = 'vendor/beta'").run();
    pins.length = 0;
    expect(await publishPaidPoolPins(env(), completed)).toEqual({
      outcome: 'abandoned',
      reason: 'serving_evidence_gone',
      applied: 0,
      pinOnly: false,
    });
    expect(pins).toHaveLength(0);
  });

  it('pins a ready alias and keeps the intent open for a finalizing sibling', async () => {
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
    // beta's registry row exists and a live run is still finalizing it.
    seedRun('run-beta', 'running');
    seedRunningProfile('vendor/beta', 'run-beta');
    seedOutbox(`pins:${REQUEST_ID}`);

    // The ready alias pins immediately: waiting would hold a confirmed, usable pin back for a
    // target that is not this request's work. The intent stays pending, so the sibling is not
    // dropped — it publishes on a later drain instead of needing a second intent.
    const waiting = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    expect(waiting).toEqual({ delivered: 0, retried: 1, abandoned: 0, pinned: 1 });
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('pending');

    // Terminal readiness publishes both: the adopted alias replays as `unchanged`, the sibling
    // is written, and the intent closes.
    sqlite
      .prepare("UPDATE benchmark_profiles SET status = 'ready' WHERE model = 'vendor/beta'")
      .run();
    const delivered = await drainPaidBillingOutbox(env(), { limit: 5, now: 10 * 60 * 1000 });
    expect(delivered).toEqual({ delivered: 1, retried: 0, abandoned: 0, pinned: 1 });
    expect(pins).toHaveLength(2);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('delivered');
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[1]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
      { model: '~vendor/other', target: 'vendor/beta' },
    ]);
    expect(billing).toHaveLength(0);
  });

  it('pins a ready alias rather than wait on a withdrawn sibling', async () => {
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
               (?, 'engine-test', 'vendor/beta', '', 0, 'case-a', 'reused', 0, 0, ?)`
      )
      .run(REQUEST_ID, AT, REQUEST_ID, AT);
    seedReadyProfile('vendor/alpha', 'run-alpha');
    // beta is requeued with no measuring run: nothing executes it, so no drain would ever
    // publish it and waiting forever would strand the ready sibling.
    seedReadyProfile('vendor/beta', null);
    sqlite
      .prepare("UPDATE benchmark_profiles SET status = 'pending' WHERE model = 'vendor/beta'")
      .run();
    seedOutbox(`pins:${REQUEST_ID}`);

    const summary = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    // The ready alias still pins, and the intent closes as abandoned with the target named:
    // not delivered, not queued for an unbounded retry, and no paid work is created.
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 1 });
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('abandoned');
    const row = sqlite
      .prepare('SELECT last_error FROM paid_benchmark_billing_outbox WHERE id = ?')
      .get(`pins:${REQUEST_ID}`) as { last_error: string | null };
    expect(row.last_error).toBe('pin_target_withdrawn:vendor/beta');
    expect(billing).toHaveLength(0);

    // Terminal: the abandoned intent is never claimed again, so no automatic re-estimate or
    // launch can come from it.
    expect(await drainPaidBillingOutbox(env(), { limit: 5, now: 10 * 60 * 1000 })).toEqual({
      delivered: 0,
      retried: 0,
      abandoned: 0,
      pinned: 0,
    });
    expect(pins).toHaveLength(1);
  });

  it('pins a ready alias rather than wait on a claim whose run already ended', async () => {
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
               (?, 'engine-test', 'vendor/beta', '', 0, 'case-a', 'reused', 0, 0, ?)`
      )
      .run(REQUEST_ID, AT, REQUEST_ID, AT);
    seedReadyProfile('vendor/alpha', 'run-alpha');
    // beta's registry row still says `running`, but its run has already finished: the orphan
    // sweep has not failed that row yet. Nothing is finalizing beta, so waiting would hold the
    // intent open forever on a claim that can never resolve.
    seedRun('run-beta', 'completed');
    seedRunningProfile('vendor/beta', 'run-beta');
    seedOutbox(`pins:${REQUEST_ID}`);

    const summary = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    // The ready alias pins, and the intent closes as abandoned naming the dead claim: not
    // delivered, not pending, and no run, charge or re-estimate follows.
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 1 });
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('abandoned');
    const row = sqlite
      .prepare('SELECT last_error FROM paid_benchmark_billing_outbox WHERE id = ?')
      .get(`pins:${REQUEST_ID}`) as { last_error: string | null };
    expect(row.last_error).toBe('pin_target_withdrawn:vendor/beta');
    // A later drain never claims it again, even once the sweep flips the stale row.
    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'failed', run_id = NULL WHERE model = 'vendor/beta'"
      )
      .run();
    expect(await drainPaidBillingOutbox(env(), { limit: 5, now: 10 * 60 * 1000 })).toEqual({
      delivered: 0,
      retried: 0,
      abandoned: 0,
      pinned: 0,
    });
  });

  it('bounds consecutive finalization waits without counting delivery failures', async () => {
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
    // A live run is genuinely finalizing the target, so the first drains must wait.
    seedRun('run-live', 'running');
    seedRunningProfile('vendor/alpha', 'run-live');
    seedOutbox(`pins:${REQUEST_ID}`);
    const intent = `pins:${REQUEST_ID}`;
    sqlite
      .prepare(
        "UPDATE paid_benchmark_billing_outbox SET attempts = 55, last_error = 'controller down' WHERE id = ?"
      )
      .run(intent);
    expect(await drainPaidBillingOutbox(env(), { limit: 5, now: 0 })).toEqual({
      delivered: 0,
      retried: 1,
      abandoned: 0,
      pinned: 0,
    });
    expect(
      sqlite
        .prepare(
          'SELECT status, attempts, last_error FROM paid_benchmark_billing_outbox WHERE id = ?'
        )
        .get(intent)
    ).toEqual({ status: 'pending', attempts: 1, last_error: 'serving_evidence_pending' });
    sqlite
      .prepare(
        'UPDATE paid_benchmark_billing_outbox SET attempts = 47, available_at = 0 WHERE id = ?'
      )
      .run(intent);

    // One drain inside the bound keeps it pending.
    expect(await drainPaidBillingOutbox(env(), { limit: 5, now: 0 })).toEqual({
      delivered: 0,
      retried: 1,
      abandoned: 0,
      pinned: 0,
    });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('pending');

    // The next drain is the bound: the run never settled, so the intent stops waiting instead
    // of staying pending forever, and the pin-only completion is withdrawn.
    const summary = await drainPaidBillingOutbox(env(), { limit: 5, now: 60 * 60 * 1000 });
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 0 });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('abandoned');
    const row = sqlite
      .prepare('SELECT last_error FROM paid_benchmark_billing_outbox WHERE id = ?')
      .get(`pins:${REQUEST_ID}`) as { last_error: string | null };
    expect(row.last_error).toBe('serving_evidence_pending:no_progress');
    expect(
      sqlite
        .prepare(
          `SELECT status, failure_reason, failure_retryable FROM paid_benchmark_requests
          WHERE id = ?`
        )
        .get(REQUEST_ID)
    ).toEqual({
      status: 'failed',
      failure_reason: PAID_PIN_NOT_APPLIED_REASON,
      failure_retryable: 1,
    });
    expect(pins).toHaveLength(0);
    expect(billing).toHaveLength(0);
  });

  it('rolls back the pin-only report when the outbox write fails after it', async () => {
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
    seedOutbox(`pins:${REQUEST_ID}`);

    // The report and the close are one batch, so failing the outbox statement (the second one)
    // must roll the request report back with it. A commit split across two writes would leave a
    // terminal intent beside a false success that no later drain could ever repair.
    const baseDb = sqliteD1(sqlite);
    const db = {
      prepare: baseDb.prepare,
      exec: baseDb.exec,
      // A real transaction on the real connection: the request report (statement 0) executes
      // inside it, then the outbox statement fails. D1's own batch is atomic the same way, so
      // the rollback is the exact behaviour under test rather than an emulation of it.
      async batch(statements: D1PreparedStatement[]) {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements.slice(0, 1)) results.push(await statement.run());
          throw new Error('D1_ERROR: outbox write failed');
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as D1Database;

    await expect(
      drainPaidBillingOutbox({ ...env(), BENCH_DB: db }, { limit: 5, now: 0 })
    ).rejects.toThrow('outbox write failed');
    // Neither write committed: the request keeps saying completed and the intent is claimable.
    expect(
      sqlite
        .prepare('SELECT status, failure_reason FROM paid_benchmark_requests WHERE id = ?')
        .get(REQUEST_ID)
    ).toEqual({ status: 'completed', failure_reason: null });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('pending');

    // The next ordinary drain closes both together, so the crash is fully repairable.
    expect(await drainPaidBillingOutbox(env(), { limit: 5, now: 0 })).toEqual({
      delivered: 0,
      retried: 0,
      abandoned: 1,
      pinned: 0,
    });
    expect(
      sqlite
        .prepare(
          `SELECT status, failure_reason, failure_retryable FROM paid_benchmark_requests
          WHERE id = ?`
        )
        .get(REQUEST_ID)
    ).toEqual({
      status: 'failed',
      failure_reason: PAID_PIN_NOT_APPLIED_REASON,
      failure_retryable: 1,
    });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('abandoned');
  });

  it('never withdraws completion for an intent another delivery already closed', async () => {
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
    seedOutbox(`pins:${REQUEST_ID}`);
    // The intent was already closed by an earlier pass, but the request is still `completed`
    // because that pass predates this report (or its own report was skipped). A later delivery
    // must not turn that real success into a failure just because its own publication says the
    // aliases are gone — the report is guarded on the intent this delivery is closing still
    // being pending.
    sqlite
      .prepare(
        `UPDATE paid_benchmark_billing_outbox SET status = 'delivered', delivered_at = 5
        WHERE id = ?`
      )
      .run(`pins:${REQUEST_ID}`);
    // A terminal intent is not claimable, so a normal drain sees nothing to do at all.
    expect(await drainPaidBillingOutbox(env(), { limit: 5, now: 0 })).toEqual({
      delivered: 0,
      retried: 0,
      abandoned: 0,
      pinned: 0,
    });
    expect(
      sqlite
        .prepare('SELECT status, failure_reason FROM paid_benchmark_requests WHERE id = ?')
        .get(REQUEST_ID)
    ).toEqual({ status: 'completed', failure_reason: null });
  });

  it('abandons a pin-only move whose only alias lost its evidence', async () => {
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
    await db.batch([enqueuePaidPoolPinsStatement(db, { requestId: REQUEST_ID, now: 0 })]);

    // The ready row behind the free move was withdrawn, so the click's only effect is gone.
    const summary = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 0 });
    expect(pins).toHaveLength(0);
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('abandoned');
    const row = sqlite
      .prepare('SELECT last_error FROM paid_benchmark_billing_outbox WHERE id = ?')
      .get(`pins:${REQUEST_ID}`) as { last_error: string | null };
    expect(row.last_error).toBe('serving_evidence_gone');
    // Nothing was measured, claimed or charged on the way out.
    expect(billing).toHaveLength(0);
    const runs = sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM benchmark_case_runs WHERE status IN ('queued','running')"
      )
      .get() as { count: number };
    expect(runs.count).toBe(0);
    const requests = sqlite.prepare('SELECT COUNT(*) AS count FROM paid_model_requests').get() as {
      count: number;
    };
    expect(requests.count).toBe(0);
  });

  it('abandons a pin whose pool was edited after the click', async () => {
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    seedReadyProfile('vendor/alpha', 'run-ready');
    seedOutbox(`pins:${REQUEST_ID}`);
    const summary = await drainPaidBillingOutbox(env(), {
      limit: 5,
      fetchImpl: refusedPins('pool_changed'),
      now: 0,
    });
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 0 });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('abandoned');
    // The web wrote nothing, and the row records why instead of claiming success.
    const row = sqlite
      .prepare('SELECT last_error FROM paid_benchmark_billing_outbox WHERE id = ?')
      .get(`pins:${REQUEST_ID}`) as { last_error: string | null };
    expect(row.last_error).toBe('pool_changed');
    expect(await drainPaidBillingOutbox(env(), { limit: 5, now: 10 * 60 * 1000 })).toEqual({
      delivered: 0,
      retried: 0,
      abandoned: 0,
      pinned: 0,
    });
  });

  it('delivers a replay whose pins the web already holds as unchanged', async () => {
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    seedReadyProfile('vendor/alpha', 'run-ready');
    seedOutbox(`pins:${REQUEST_ID}`);
    // The first drain pins and crashes before its delivered write; the replay sees the pin it
    // already wrote. `unchanged` is adoption, so the intent still closes as delivered.
    await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    sqlite
      .prepare(
        `UPDATE paid_benchmark_billing_outbox SET status = 'pending', delivered_at = NULL
        WHERE id = ?`
      )
      .run(`pins:${REQUEST_ID}`);
    const replay = await drainPaidBillingOutbox(env(), { limit: 5, now: 10 * 60 * 1000 });
    expect(replay).toEqual({ delivered: 1, retried: 0, abandoned: 0, pinned: 0 });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('delivered');
  });

  it('abandons a pin intent that the web never answered for one alias', async () => {
    const first = PLAN.pairs[0];
    if (!first) throw new Error('fixture plan lost its pair');
    // Two confirmed aliases, so a partially complete answer is distinguishable from an empty
    // one: the second alias is simply missing from both lists.
    const twoAlias: PaidBenchmarkPlan = {
      ...PLAN,
      pairs: [first],
      aliases: [
        { model: '~vendor/latest', target: 'vendor/alpha' },
        { model: '~vendor/other', target: 'vendor/alpha' },
      ],
    };
    seedRequest('completed');
    sqlite.prepare('UPDATE paid_benchmark_quotes SET plan = ?').run(JSON.stringify(twoAlias));
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    seedReadyProfile('vendor/alpha', 'run-ready');
    seedOutbox(`pins:${REQUEST_ID}`);
    // `decideServingPins` answers for every alias it was sent, so a non-empty answer that skips
    // one alias is not adoption evidence for that alias. Counting it as delivered would drop the
    // omission silently — for a pin-only request, the whole effect of the click.
    const partial = (async () =>
      json({
        routerId: ROUTER_ID,
        poolUnchanged: true,
        applied: [{ model: '~vendor/latest', target: 'vendor/alpha', pinnedAt: AT }],
        skipped: [],
      })) as typeof fetch;
    const summary = await drainPaidBillingOutbox(env(), { limit: 5, fetchImpl: partial, now: 0 });
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 1 });
    expect(outboxStatus(`pins:${REQUEST_ID}`)).toBe('abandoned');
    const row = sqlite
      .prepare('SELECT last_error FROM paid_benchmark_billing_outbox WHERE id = ?')
      .get(`pins:${REQUEST_ID}`) as { last_error: string | null };
    expect(row.last_error).toBe('pin_delivery_unaccounted:~vendor/other');
    expect(billing).toHaveLength(0);
  });

  it('reports a refused pin-only move instead of leaving the request complete', async () => {
    const first = PLAN.pairs[0];
    if (!first) throw new Error('fixture plan lost its pair');
    // A move-only plan: nothing was measured, so `completed` is the claim that the pool now
    // serves the confirmed target.
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
    seedOutbox(`pins:${REQUEST_ID}`);

    // The ready evidence is gone, so the click's only effect cannot be applied.
    const summary = await drainPaidBillingOutbox(env(), { limit: 5, now: 0 });
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 0 });
    const request = sqlite
      .prepare(
        `SELECT status, failure_reason, failure_retryable FROM paid_benchmark_requests
        WHERE id = ?`
      )
      .get(REQUEST_ID) as {
      status: string;
      failure_reason: string | null;
      failure_retryable: number;
    };
    // The console and the owner read this row, so the false success is withdrawn with fixed
    // user-facing copy and a retryable flag that points at a fresh estimate.
    expect(request).toEqual({
      status: 'failed',
      failure_reason: PAID_PIN_NOT_APPLIED_REASON,
      failure_retryable: 1,
    });
    expect(pins).toHaveLength(0);
    expect(billing).toHaveLength(0);
    // No work, charge or automatic re-estimate follows from the report.
    const runs = sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM benchmark_case_runs WHERE status IN ('queued','running')"
      )
      .get() as { count: number };
    expect(runs.count).toBe(0);
    const modelRequests = sqlite
      .prepare('SELECT COUNT(*) AS count FROM paid_model_requests')
      .get() as { count: number };
    expect(modelRequests.count).toBe(0);
    // The quote stays unconsumed for a retried confirmation, and no new one is created.
    const quotes = sqlite.prepare('SELECT COUNT(*) AS count FROM paid_benchmark_quotes').get() as {
      count: number;
    };
    expect(quotes.count).toBe(1);
  });

  it('leaves a completed mixed request alone when only its pin bookkeeping is lost', async () => {
    // A mixed plan really did measure and charge, so a refused pin is bookkeeping, not a failed
    // request: the row must keep reporting completion.
    seedRequest('completed');
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, 'engine-test', 'vendor/alpha', '', 0, 'case-a', 'done', 0, 20000, NULL, ?)`
      )
      .run(REQUEST_ID, AT);
    seedReadyProfile('vendor/alpha', 'run-ready');
    seedOutbox(`pins:${REQUEST_ID}`);
    const summary = await drainPaidBillingOutbox(env(), {
      limit: 5,
      fetchImpl: refusedPins('pool_changed'),
      now: 0,
    });
    expect(summary).toEqual({ delivered: 0, retried: 0, abandoned: 1, pinned: 0 });
    expect(
      sqlite
        .prepare('SELECT status, failure_reason FROM paid_benchmark_requests WHERE id = ?')
        .get(REQUEST_ID)
    ).toEqual({ status: 'completed', failure_reason: null });
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
    // The default variant is ready; the high variant is mid-finalization. A target is decided
    // once, so the ready variant pins it whether or not the other is still in flight.
    seedReadyProfile('vendor/alpha', 'run-default', '');
    seedRun('run-high', 'running');
    seedRunningProfile('vendor/alpha', 'run-high', 'high');
    const request = await readPaidBenchmarkRequest(db, REQUEST_ID);
    if (!request) throw new Error('request missing');

    // The ready variant publishes the alias; the pending variant must not clobber it, and an
    // already-publishable target is not held open by its other variant.
    expect(await publishPaidPoolPins(env(), request)).toEqual({ outcome: 'delivered', applied: 1 });
    expect(pins).toHaveLength(1);
    expect(CustomRouterPoolPinsRequestSchema.parse(pins[0]).aliases).toEqual([
      { model: '~vendor/latest', target: 'vendor/alpha' },
    ]);
  });
});
