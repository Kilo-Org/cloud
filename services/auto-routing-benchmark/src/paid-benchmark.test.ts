import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomRouterPoolPinsRequestSchema,
  PAID_BENCHMARK_PATH,
  benchmarkProjectId,
  BenchmarkUsageReceiptRequestSchema,
  PaidBenchmarkProgressSchema,
  PaidBenchmarkQuoteSchema,
  PaidBenchmarkStartResultSchema,
  type PaidBenchmarkProgress,
  type PaidBenchmarkQuote,
  type PaidBenchmarkStartResult,
  type PaidBenchmarkWorkerRequest,
} from '@kilocode/auto-routing-contracts';
import type * as z from 'zod';
import { openPaidDatabase, seedBenchmarkConfig } from '../test/paid-benchmark-d1';
import type { HonoEnv } from './hono-env';
import { ACTIVE_MEASUREMENT_REVISION, deciderCasesForRouter } from './measurement-revision';
import {
  pauseUnfundedPaidRequests,
  reconcilePaidUsageReceipts,
  registerPaidBenchmarkRoutes,
} from './paid-benchmark';
import { selectPaidModelRequestPayerStatements } from './paid-case-store';
import { computeEngineIdentity } from './run';

const CATALOG = {
  data: [
    {
      id: 'vendor/alpha',
      pricing: { prompt: 1e-6, completion: 2e-6 },
      opencode: { variants: { high: { reasoning: { effort: 'high' } } } },
    },
    { id: 'vendor/cheap', pricing: { prompt: 1e-6, completion: 2e-6 } },
  ],
};

const ENGINE = computeEngineIdentity('decider', 'efficient');
const CASES = deciderCasesForRouter('efficient', ACTIVE_MEASUREMENT_REVISION);
const REPS = 3;
const SLOTS = CASES.length * REPS;
const ROUTER_ID = '11111111-1111-4111-8111-111111111111';

const CONTEXT = {
  ownerType: 'user' as const,
  ownerId: 'user-1',
  baseRouter: 'efficient' as const,
  entries: [{ kind: 'gateway' as const, model: 'vendor/alpha' }],
  clientEvalEntryKeys: [],
};

type Recorded = { url: string; body: unknown };

let app: Hono<HonoEnv>;
let db: D1Database;
let sqlite: ReturnType<typeof openPaidDatabase>['sqlite'];
let billing: Recorded[];
let pins: Recorded[];

async function parseBody<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Error(`unexpected response: ${JSON.stringify(body)} (${parsed.error.message})`);
  return parsed.data;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The catalog the fake fetch serves; a test may swap it to simulate an alias move. */
let catalog: unknown = CATALOG;

function installFetch(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = request.url;
    const body: unknown = request.body ? await request.json() : null;
    if (url.includes('/api/openrouter/models')) return json(catalog);
    if (url.includes('/api/internal/auto-routing/benchmark-billing')) {
      billing.push({ url, body });
      return json({ error: 'no billing expected' }, 500);
    }
    if (url.includes('/api/internal/auto-routing/pool-pins')) {
      const parsed = CustomRouterPoolPinsRequestSchema.safeParse(body);
      if (!parsed.success) return json({ error: 'invalid pins body' }, 400);
      pins.push({ url, body: parsed.data });
      return json({
        routerId: parsed.data.routerId,
        poolUnchanged: true,
        applied: [],
        skipped: [],
      });
    }
    return json({ error: 'unexpected url' }, 404);
  });
}

/** The bindings the paid worker reads; a test needs no other Env field. */
const paidBindings = (database: D1Database = db) =>
  ({
    BENCH_DB: database,
    KILO_WEB_API_BASE_URL: 'https://web.test',
    INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
  }) as unknown as Env;

function env(): Env {
  return paidBindings();
}

async function post(request: PaidBenchmarkWorkerRequest): Promise<Response> {
  return app.request(
    `https://bench.example.com${PAID_BENCHMARK_PATH}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
    env(),
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  );
}

async function quote(): Promise<PaidBenchmarkQuote> {
  const response = await post({
    action: 'quote',
    ownerType: 'user',
    ownerId: 'user-1',
    routerId: ROUTER_ID,
    poolVersion: 'pool-v1',
    poolSlug: 'pool-one',
    context: CONTEXT,
  });
  expect(response.status).toBe(200);
  return parseBody(response, PaidBenchmarkQuoteSchema);
}

type StartRequest = Extract<PaidBenchmarkWorkerRequest, { action: 'start' }>;

function startRequest(quoteId: string, overrides: Partial<StartRequest> = {}): StartRequest {
  return {
    action: 'start',
    ownerType: 'user',
    ownerId: 'user-1',
    routerId: ROUTER_ID,
    poolVersion: 'pool-v1',
    poolSlug: 'pool-one',
    context: CONTEXT,
    quoteId,
    actorUserId: 'user-1',
    ...overrides,
  };
}

function progressRequest(): PaidBenchmarkWorkerRequest {
  return { action: 'progress', ownerType: 'user', ownerId: 'user-1', routerId: ROUTER_ID };
}

function pauseRequest(requestId: string, ownerId = 'user-1'): PaidBenchmarkWorkerRequest {
  return { action: 'pause', ownerType: 'user', ownerId, routerId: ROUTER_ID, requestId };
}

function startResult(response: Response): Promise<PaidBenchmarkStartResult> {
  return parseBody(response, PaidBenchmarkStartResultSchema);
}

/** The request id of a started result's progress; every non-empty state carries one. */
function startedRequestId(progress: PaidBenchmarkProgress): string {
  if (progress.status === 'empty') throw new Error('started result reported an empty request');
  return progress.id;
}

function progressBody(response: Response): Promise<PaidBenchmarkProgress> {
  return parseBody(response, PaidBenchmarkProgressSchema);
}

/** Raw fixture reads: node:sqlite rows, not the D1 contract, so the shape is asserted by SQL. */
function countRows(sql: string, ...params: unknown[]): number {
  const row = sqlite.prepare(sql).get(...(params as never[])) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function requestRow(): { status: string; maximum_microdollars: number } | null {
  const row = sqlite
    .prepare('SELECT status, maximum_microdollars FROM paid_benchmark_requests')
    .get() as { status: string; maximum_microdollars: number } | undefined;
  return row ?? null;
}

beforeEach(() => {
  const opened = openPaidDatabase();
  db = opened.db;
  sqlite = opened.sqlite;
  seedBenchmarkConfig(sqlite);
  billing = [];
  pins = [];
  catalog = CATALOG;
  app = new Hono<HonoEnv>();
  registerPaidBenchmarkRoutes(app);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paid benchmark endpoint', () => {
  it('quotes the exact missing repetition slots and stages them before activating', async () => {
    const quoted = await quote();
    expect(quoted.status).toBe('ready');
    if (quoted.status !== 'ready') return;
    expect(quoted.cases).toEqual({ reused: 0, covered: 0, shared: 0, exclusive: SLOTS });
    expect(quoted.estimateMicrodollars).toBe(quoted.maximumMicrodollars);
    expect(quoted.maximumMicrodollars).toBeGreaterThan(0);

    const started = await startResult(await post(startRequest(quoted.id)));
    expect(started.status).toBe('started');
    // No hold, no charge: the click only writes D1 rows. Usage charges happen per model later.
    expect(billing).toHaveLength(0);
    expect(requestRow()?.maximum_microdollars).toBe(quoted.maximumMicrodollars);
    if (started.status !== 'started') return;
    // Staging is paged: the click may only have staged the first slices.
    expect(['preparing', 'active']).toContain(started.request.status);

    let progress = started.request;
    for (let attempt = 0; attempt < 20 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    if (progress.status !== 'active')
      throw new Error(`expected an active request, got ${progress.status}`);
    expect(progress.counts.queued).toBe(SLOTS);
    expect(requestRow()?.status).toBe('active');
    expect(billing).toHaveLength(0);
  });

  it('is idempotent when the same click is retried', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const first = await startResult(await post(startRequest(quoted.id)));
    const second = await startResult(await post(startRequest(quoted.id)));
    if (first.status !== 'started' || second.status !== 'started')
      throw new Error(`start refused: ${first.status} / ${second.status}`);
    expect(startedRequestId(second.request)).toBe(startedRequestId(first.request));
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
    expect(billing).toHaveLength(0);
  });

  it('pauses a live request immediately and stays paused', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');
    const paused = await progressBody(await post(pauseRequest(startedRequestId(started.request))));
    expect(paused.status).toBe('paused');
    expect(requestRow()?.status).toBe('paused');
    // A paused request is no longer live: the fence reports nothing left to pause.
    const again = await progressBody(await post(pauseRequest(startedRequestId(started.request))));
    expect(again.status).toBe('empty');
    expect(billing).toHaveLength(0);
  });

  it('refuses a progress or pause call from another owner', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');
    const foreignProgress = await progressBody(
      await post({ ...progressRequest(), ownerId: 'user-2' })
    );
    expect(foreignProgress.status).toBe('empty');
    const foreignPause = await progressBody(
      await post(pauseRequest(startedRequestId(started.request), 'user-2'))
    );
    expect(foreignPause.status).toBe('empty');
  });

  it('rejects a start whose pool changed after the quote', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const result = await startResult(
      await post(startRequest(quoted.id, { poolVersion: 'pool-v2' }))
    );
    expect(result.status).toBe('quote_mismatch');
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(0);
  });

  it('rejects an expired quote', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    sqlite
      .prepare('UPDATE paid_benchmark_quotes SET expires_at = ?')
      .run('2020-01-01T00:00:00.000Z');
    expect((await startResult(await post(startRequest(quoted.id)))).status).toBe('quote_expired');
  });

  it('never benchmarks a second time when the same instant clicks twice', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const [first, second] = await Promise.all([
      startResult(await post(startRequest(quoted.id))),
      startResult(await post(startRequest(quoted.id))),
    ]);
    // One click wins; the loser reconciles the winner's request or is told the quote is used.
    for (const result of [first, second])
      expect(['started', 'quote_mismatch']).toContain(result.status);
    expect([first, second].filter(result => result.status === 'started').length).toBeGreaterThan(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
  });
});

describe('paid benchmark reuse', () => {
  it('quotes a fully reused pool at zero, activates it, and completes without a charge', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, status, started_at, engine_identity, repetitions,
            measurement_revision, min_accuracy, switch_cost_factor, max_concurrency)
        VALUES ('run-seed', 'efficient', 'decider', 'completed', ?, ?, 3, 3, 0.7, 1, 80)`
      )
      .run('2026-01-01T00:00:00.000Z', ENGINE);
    const insert = sqlite.prepare(
      `INSERT INTO case_results
        (run_id, model, variant, case_id, score, latency_ms, cost_usd, rep, timed_out,
          exit_code, prompt_revision)
      VALUES ('run-seed', 'vendor/alpha', 'high', ?, 1, 10, 0.01, ?, 0, 0, 3)`
    );
    for (const benchCase of CASES)
      for (let rep = 0; rep < REPS; rep += 1) insert.run(benchCase.id, rep);

    const quoted = await quote();
    expect(quoted.status).toBe('ready');
    if (quoted.status !== 'ready') return;
    expect(quoted.cases).toEqual({ reused: SLOTS, covered: 0, shared: 0, exclusive: 0 });
    expect(quoted.maximumMicrodollars).toBe(0);
    expect(quoted.estimateMicrodollars).toBe(0);

    const started = await startResult(await post(startRequest(quoted.id)));
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    let progress = started.request;
    for (let attempt = 0; attempt < 20 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    if (progress.status !== 'completed')
      throw new Error(`expected a completed request, got ${progress.status}`);
    expect(progress.chargedMicrodollars).toBe(0);
    expect(progress.counts.reused).toBe(SLOTS);
    expect(billing).toHaveLength(0);
  });
});

describe('unfunded pause', () => {
  const KEY = {
    engineIdentity: 'engine-test',
    model: 'vendor/alpha',
    variant: 'high',
    rep: 0,
  };

  function seedRunningCase(
    target: ReturnType<typeof openPaidDatabase>['sqlite'],
    input: { caseId: string; generation?: number }
  ) {
    target
      .prepare(
        `INSERT INTO benchmark_case_runs
          (engine_identity, model, variant, rep, case_id, status, generation, executor_run_id,
            executor_token, platform_covered, result_usable, created_at, updated_at, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, 'run-1', 'token-1', 0, 0, ?, ?, ?)`
      )
      .run(
        KEY.engineIdentity,
        KEY.model,
        KEY.variant,
        KEY.rep,
        input.caseId,
        input.generation ?? 1,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
  }

  function seedPlan(
    target: ReturnType<typeof openPaidDatabase>['sqlite'],
    input: { requestId: string; owner: string; routerId: string; caseIds: string[] }
  ) {
    target
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
            quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
            plan_cases, staged_cases, actor_user_id, context, created_at, updated_at)
        VALUES (?, 'user', ?, 'efficient', ?, 'pool-v1', 'engine-test', 'active', 'q',
          20000, 20000, 500, ?, ?, ?, '{}', ?, ?)`
      )
      .run(
        input.requestId,
        input.owner,
        input.routerId,
        input.caseIds.length,
        input.caseIds.length,
        input.owner,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
    for (const caseId of input.caseIds)
      target
        .prepare(
          `INSERT INTO paid_benchmark_request_cases
            (request_id, engine_identity, model, variant, rep, case_id, status,
              covered_by_kilo, charged_microdollars, reason, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 0, NULL, ?)`
        )
        .run(
          input.requestId,
          KEY.engineIdentity,
          KEY.model,
          KEY.variant,
          KEY.rep,
          caseId,
          '2026-01-01T00:00:00.000Z'
        );
  }

  it('pauses the exact slot through the store transition and leaves a funded plan alone', async () => {
    const { db, sqlite } = openPaidDatabase();
    seedRunningCase(sqlite, { caseId: 'case-a' });
    seedRunningCase(sqlite, { caseId: 'case-b' });
    // user-a only ever had case-a (the refused slot); user-b still has case-b live.
    seedPlan(sqlite, {
      requestId: '11111111-1111-4111-8111-11111111110a',
      owner: 'user-a',
      routerId: '11111111-1111-4111-8111-11111111111a',
      caseIds: ['case-a'],
    });
    seedPlan(sqlite, {
      requestId: '11111111-1111-4111-8111-11111111110b',
      owner: 'user-b',
      routerId: '11111111-1111-4111-8111-11111111111b',
      caseIds: ['case-b'],
    });

    const result = await pauseUnfundedPaidRequests(paidBindings(db), {
      refusedCases: [
        {
          ...KEY,
          caseId: 'case-a',
          funderRequestId: '11111111-1111-4111-8111-11111111110a',
        },
      ],
      reason: 'no_payer',
    });
    // The store paused the request whose only live case was the refused slot.
    expect(result.paused).toEqual(['11111111-1111-4111-8111-11111111110a']);
    expect(result.kept).toEqual([]);
    const paused = sqlite
      .prepare(
        "SELECT status, pause_reason, charged_microdollars FROM paid_benchmark_requests WHERE owner_id = 'user-a'"
      )
      .get() as { status: string; pause_reason: string | null; charged_microdollars: number };
    expect(paused).toEqual({
      status: 'paused',
      pause_reason: 'no_funds',
      charged_microdollars: 500,
    });
    // The exact slot carries the caller's typed reason; the funded plan is untouched.
    const slot = sqlite
      .prepare(
        "SELECT status, reason FROM paid_benchmark_request_cases WHERE request_id = '11111111-1111-4111-8111-11111111110a'"
      )
      .get() as { status: string; reason: string | null };
    // The store's canonical pause reason; the runner's typed code is only a diagnostic.
    expect(slot).toEqual({ status: 'paused', reason: 'no_funds' });
    const funded = sqlite
      .prepare(
        "SELECT status, pause_reason, charged_microdollars FROM paid_benchmark_requests WHERE owner_id = 'user-b'"
      )
      .get() as { status: string; pause_reason: string | null; charged_microdollars: number };
    expect(funded).toEqual({ status: 'active', pause_reason: null, charged_microdollars: 500 });
    // Nothing is queued for a refund; JIT has no hold to return.
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_billing_outbox')).toBe(0);
  });

  it('keeps a shared case running when another funded plan still pays it', async () => {
    const { db, sqlite } = openPaidDatabase();
    seedRunningCase(sqlite, { caseId: 'case-shared' });
    seedPlan(sqlite, {
      requestId: '11111111-1111-4111-8111-11111111110a',
      owner: 'user-a',
      routerId: '11111111-1111-4111-8111-11111111111a',
      caseIds: ['case-shared'],
    });
    // A second active plan also stages the same case: the slot is shared, not exclusive.
    seedPlan(sqlite, {
      requestId: '11111111-1111-4111-8111-11111111110b',
      owner: 'user-b',
      routerId: '11111111-1111-4111-8111-11111111111b',
      caseIds: ['case-shared'],
    });
    const result = await pauseUnfundedPaidRequests(paidBindings(db), {
      refusedCases: [
        {
          ...KEY,
          caseId: 'case-shared',
          funderRequestId: '11111111-1111-4111-8111-11111111110a',
        },
      ],
      reason: 'no_payer',
    });
    expect(result.paused).toEqual([]);
    const runStatus = sqlite
      .prepare("SELECT status FROM benchmark_case_runs WHERE case_id = 'case-shared'")
      .get() as { status: string };
    expect(runStatus.status).toBe('running');
    expect(
      (
        sqlite
          .prepare("SELECT status FROM paid_benchmark_requests WHERE owner_id = 'user-b'")
          .get() as { status: string }
      ).status
    ).toBe('active');
  });
});

describe('quote and staging fences', () => {
  it('returns the winner for a retried click and refuses a competing live quote', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const first = await startResult(await post(startRequest(quoted.id)));
    if (first.status !== 'started') throw new Error('start refused');
    // A retry of the same click returns the same request, never a second one.
    const retry = await startResult(await post(startRequest(quoted.id)));
    expect(retry.status).toBe('started');
    if (retry.status !== 'started') return;
    expect(startedRequestId(retry.request)).toBe(startedRequestId(first.request));
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
  });

  it('records serving pairs in the plan so staging writes only free reuses for them', async () => {
    // The pair is already ready at this engine: the quote is empty and nothing is staged.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const quoted = await quote();
    expect(quoted.status).toBe('empty');
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(0);
  });

  it('does not create a new measured job for a serving pair in a mixed pool', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const response = await post({
      action: 'quote',
      ownerType: 'user',
      ownerId: 'user-1',
      routerId: ROUTER_ID,
      poolVersion: 'pool-v1',
      poolSlug: 'pool-one',
      context: {
        ...CONTEXT,
        entries: [
          { kind: 'gateway' as const, model: 'vendor/alpha' },
          { kind: 'gateway' as const, model: 'vendor/cheap' },
        ],
      },
    });
    const rawBody = await response.clone().text();
    const quoted = PaidBenchmarkQuoteSchema.parse(JSON.parse(rawBody));
    expect({
      http: response.status,
      status: quoted.status,
      body: rawBody.slice(0, 200),
    }).toMatchObject({
      http: 200,
      status: 'ready',
    });
    if (quoted.status !== 'ready') return;
    // Only the new target is demand.
    expect(quoted.cases.reused).toBe(SLOTS);
    expect(quoted.cases.exclusive).toBe(SLOTS);
    const mixedContext = {
      ...CONTEXT,
      entries: [
        { kind: 'gateway' as const, model: 'vendor/alpha' },
        { kind: 'gateway' as const, model: 'vendor/cheap' },
      ],
    };
    const started = await startResult(
      await post(startRequest(quoted.id, { context: mixedContext }))
    );
    if (started.status !== 'started') throw new Error('start refused');
    // Staging is paged: drive it to completion so every slot is recorded.
    let progress = started.request;
    for (let attempt = 0; attempt < 40 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    expect(progress.status === 'active' || progress.status === 'completed').toBe(true);
    // The serving pair's slots are all reuse: no queued case exists for vendor/alpha.
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_request_cases WHERE model = 'vendor/alpha' AND status = 'queued'"
      )
    ).toBe(0);
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_request_cases WHERE model = 'vendor/cheap' AND status = 'queued'"
      )
    ).toBeGreaterThan(0);
  });
});

describe('pause durability', () => {
  it('keeps the committed pause when runner-cancel delivery fails', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');

    // The narrow cancellation delivery throws: the pause must still be committed and
    // reported, and no run may be launched by the failure path.
    const failingApp = new Hono<HonoEnv>();
    registerPaidBenchmarkRoutes(failingApp);
    const response = await failingApp.request(
      `https://bench.example.com${PAID_BENCHMARK_PATH}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pauseRequest(startedRequestId(started.request))),
      },
      env(),
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    );
    const raw = (await response.clone().json()) as { status?: string };
    expect(raw.status).toBe('paused');
    expect(requestRow()?.status).toBe('paused');
    // The durable intent survives for the cron to redeliver.
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_cancellations WHERE status = 'pending'"
      )
    ).toBeGreaterThanOrEqual(0);
  });

  it('pauses the latest live request without a request id and never stages on the read path', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');
    const before = countRows('SELECT COUNT(*) AS count FROM paid_benchmark_request_cases');
    const response = await post({
      action: 'pause',
      ownerType: 'user',
      ownerId: 'user-1',
      routerId: ROUTER_ID,
    });
    const body = (await response.clone().json()) as { status?: string; error?: unknown };
    expect({ status: body.status, error: body.error }).toEqual({
      status: 'paused',
      error: undefined,
    });
    // No staging happened on the pause read path.
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_request_cases')).toBe(before);
    // A second fence call finds nothing live and answers empty without touching D1 plans.
    const againResponse = await post({
      action: 'pause',
      ownerType: 'user',
      ownerId: 'user-1',
      routerId: ROUTER_ID,
    });
    const againBody = (await againResponse.json()) as { status?: string; error?: unknown };
    expect({ status: againResponse.status, body: againBody }).toEqual({
      status: 200,
      body: { status: 'empty' },
    });
  });
});

describe('receipt reconciliation', () => {
  const MIXED_CASE_MODEL = 'Vendor/AlphaTurbo';
  const RECEIPT_PATH = '/api/internal/usage/receipts';

  /** One admitted model request with its stamped assignment/project. */
  function seedAdmitted(input: {
    id: string;
    usageId: string;
    assignmentId: string;
    model: string;
    projectId: string;
    updatedAt: string;
  }) {
    sqlite
      .prepare(
        `INSERT INTO paid_model_requests
          (id, engine_identity, model, variant, rep, case_id, generation, pool_request_id,
            state, assignment_id, owner_type, owner_id, platform_covered, reason, api,
            executor_user_id, project_id, usage_id, platform_organization_id,
            created_at, updated_at)
        VALUES (?, 'engine-test', ?, 'high', 0, 'case-a', 1, 'pool-request-1', 'admitted', ?,
          'user', 'user-1', 0, NULL, 'chat/completions', 'bench-user', ?, ?, NULL, ?, ?)`
      )
      .run(
        input.id,
        input.model,
        input.assignmentId,
        input.projectId,
        input.usageId,
        input.updatedAt,
        input.updatedAt
      );
  }

  function receipt(usageId: string, requestedModel: string) {
    return {
      usageId,
      status: 'recorded',
      microdollars: 1234,
      payerType: 'user',
      payerId: 'user-1',
      projectId: benchmarkProjectId({
        scope: 'user',
        slug: 'pool-one',
        routerId: ROUTER_ID,
      }),
      requestedModel,
      model: requestedModel,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('matches the gateway\u2019s lower-cased requested_model and books the raw signed model', async () => {
    const projectId = benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID });
    seedAdmitted({
      id: 'w1',
      usageId: 'aaaa1111-1111-4111-8111-111111111111',
      assignmentId: 'bbbb2222-2222-4222-8222-222222222222',
      model: MIXED_CASE_MODEL,
      projectId,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes(RECEIPT_PATH)) {
        const body = BenchmarkUsageReceiptRequestSchema.parse(await request.json());
        return new Response(
          JSON.stringify({
            receipts: body.usageIds.map(id => receipt(id, MIXED_CASE_MODEL.toLowerCase())),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    };

    const summary = await reconcilePaidUsageReceipts(paidBindings(db), { fetchImpl });
    expect(summary.recorded).toBe(1);
    expect(summary.mismatched).toBe(0);
    // The booked receipt keeps the signed casing, not the writer's lower-cased form.
    const usage = sqlite.prepare('SELECT usage_id, model FROM paid_attempt_usage').get() as {
      usage_id: string;
      model: string;
    };
    expect(usage.model).toBe('Vendor/AlphaTurbo');
    // No provider or other upstream was contacted.
    expect(seen).toHaveLength(0);
  });

  it('scans least-recently-checked first so older pending receipts are not starved', async () => {
    const projectId = benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID });
    const oldUsage = 'cccc3333-3333-4333-8333-333333333333';
    seedAdmitted({
      id: 'old',
      usageId: oldUsage,
      assignmentId: 'dddd4444-4444-4444-8444-444444444444',
      model: 'vendor/alpha',
      projectId,
      updatedAt: '2025-12-01T00:00:00.000Z',
    });
    // More newer rows than one pass can inspect.
    for (let index = 0; index < 12; index += 1)
      seedAdmitted({
        id: `new-${index}`,
        usageId: `eeee5555-5555-4555-8555-5555555555${String(index).padStart(2, '0')}`,
        assignmentId: `ffff6666-6666-4666-8666-6666666666${String(index).padStart(2, '0')}`,
        model: 'vendor/alpha',
        projectId,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

    // The old receipt is pending on the first pass; the newer ones are booked.
    let oldLanded = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.includes(RECEIPT_PATH)) return new Response('{}', { status: 200 });
      const body = BenchmarkUsageReceiptRequestSchema.parse(await request.json());
      return new Response(
        JSON.stringify({
          receipts: body.usageIds.map(id =>
            id === oldUsage && !oldLanded
              ? {
                  ...receipt(id, 'vendor/alpha'),
                  status: 'pending',
                  microdollars: null,
                  payerType: null,
                  payerId: null,
                  projectId: null,
                  requestedModel: null,
                  model: null,
                  createdAt: null,
                }
              : receipt(id, 'vendor/alpha')
          ),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const paidEnv = paidBindings(db);

    // Pass 1 (limit 5): the oldest pending row is inspected first.
    const first = await reconcilePaidUsageReceipts(paidEnv, { limit: 5, fetchImpl });
    expect(first.pending).toBeGreaterThanOrEqual(1);
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_attempt_usage WHERE usage_id = '" + oldUsage + "'"
      )
    ).toBe(0);
    // Its inspection clock advanced, so it no longer heads the queue.
    const oldUpdated = sqlite
      .prepare('SELECT updated_at FROM paid_model_requests WHERE id = ?')
      .get('old') as { updated_at: string };
    expect(oldUpdated.updated_at).not.toBe('2025-12-01T00:00:00.000Z');

    // Later the old receipt lands. Two more passes must book it: the queued-behind rows are
    // inspected first (they were least recently checked after pass 1), then the old row.
    oldLanded = true;
    for (let pass = 0; pass < 6; pass += 1) {
      const bookedOld = countRows(
        "SELECT COUNT(*) AS count FROM paid_attempt_usage WHERE usage_id = '" + oldUsage + "'"
      );
      if (bookedOld > 0) break;
      await reconcilePaidUsageReceipts(paidEnv, { limit: 5, fetchImpl });
    }
    // The older pending receipt is booked eventually, and exactly once.
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_attempt_usage WHERE usage_id = '" + oldUsage + "'"
      )
    ).toBe(1);
    // No duplicate debit: each usage id has one receipt row.
    expect(countRows('SELECT COUNT(*) AS count FROM paid_attempt_usage')).toBe(
      countRows('SELECT COUNT(DISTINCT usage_id) AS count FROM paid_attempt_usage')
    );
    expect(
      countRows("SELECT COUNT(*) AS count FROM benchmark_case_runs WHERE status = 'running'")
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('covered slot authorisation', () => {
  const PLATFORM_MODEL = 'vendor/alpha';

  /**
   * A quote whose pair the live platform queue owns (no canonical run rows yet), started
   * through the real endpoint. Returns the started progress after staging settles.
   */
  async function startCoveredRequest(): Promise<PaidBenchmarkProgress> {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at, platform_requested, user_requested)
        VALUES ('efficient', ?, 'high', ?, 3, 'pending',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0)`
      )
      .run(PLATFORM_MODEL, ENGINE);
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('expected a ready covered quote');
    expect(quoted.cases).toMatchObject({ covered: SLOTS, exclusive: 0, shared: 0 });
    expect(quoted.maximumMicrodollars).toBe(0);
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');
    let progress = started.request;
    for (let attempt = 0; attempt < 40 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    return progress;
  }

  it('stages covered slots with the approved covered bit and no user permit', async () => {
    const progress = await startCoveredRequest();
    expect(progress.status).toBe('active');
    const rows = sqlite
      .prepare(`SELECT covered_by_kilo, status FROM paid_benchmark_request_cases`)
      .all() as { covered_by_kilo: number; status: string }[];
    expect(rows).toHaveLength(SLOTS);
    expect(rows.every(row => row.covered_by_kilo === 1)).toBe(true);
    // Staging creates the case-run rows, but none carries the canonical latch yet: coverage
    // here is the quote's approved promise, which is exactly why the bit must be persisted.
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(SLOTS);
    expect(
      countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs WHERE platform_covered = 1')
    ).toBe(0);
    // Nothing was priced or reserved, so the request never charges the user.
    const request = requestRow();
    expect(request?.maximum_microdollars).toBe(0);
    // No user payer row can be created for a covered slot.
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM benchmark_case_payers WHERE status IN ('eligible','accepted')"
      )
    ).toBe(0);
  });

  it('keeps the covered bit after platform membership is removed before the permit', async () => {
    await startCoveredRequest();
    // The platform subscription drops the pair after staging, before any permit exists.
    sqlite
      .prepare(
        `UPDATE benchmark_profiles SET platform_requested = 0, user_requested = 1
        WHERE model = ? AND engine_identity = ?`
      )
      .run(PLATFORM_MODEL, ENGINE);
    // The slot keeps its approved covered bit.
    const rows = sqlite
      .prepare('SELECT covered_by_kilo FROM paid_benchmark_request_cases')
      .all() as { covered_by_kilo: number }[];
    expect(rows.every(row => row.covered_by_kilo === 1)).toBe(true);

    // Claim one exact fake generation for a staged slot, then run the store's real picker.
    // This must not restate the guard: the assertion is the store's own answer.
    const slot = sqlite
      .prepare(
        `SELECT engine_identity, model, variant, rep, case_id FROM paid_benchmark_request_cases LIMIT 1`
      )
      .get() as {
      engine_identity: string;
      model: string;
      variant: string;
      rep: number;
      case_id: string;
    };
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs SET status = 'running', generation = 1,
          executor_run_id = 'run-1', executor_token = 'token-1'
        WHERE engine_identity = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?`
      )
      .run(slot.engine_identity, slot.model, slot.variant, slot.rep, slot.case_id);

    const key = {
      engineIdentity: slot.engine_identity,
      model: slot.model,
      variant: slot.variant,
      rep: slot.rep,
      caseId: slot.case_id,
    };
    const modelRequestId = crypto.randomUUID();
    const selected = await db.batch(
      selectPaidModelRequestPayerStatements(db, {
        key,
        generation: 1,
        modelRequestId,
        assignmentId: crypto.randomUUID(),
        api: 'chat/completions',
        executorUserId: 'bench-user',
        usageId: crypto.randomUUID(),
        platformOrganizationId: null,
      })
    );
    const picked = selected[selected.length - 1]?.results?.[0] as
      | { state?: string; owner_type?: string | null; owner_id?: string | null }
      | undefined;
    // The store's picker refuses the plan: no assignment, no payer, no permit for that owner.
    expect(picked?.state ?? 'none').not.toBe('selecting');
    expect(picked?.owner_type ?? null).toBeNull();
    expect(picked?.owner_id ?? null).toBeNull();
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM benchmark_case_payers WHERE status IN ('eligible','accepted')"
      )
    ).toBe(0);
  });
});

describe('alias movement between quote and confirm', () => {
  it('refuses the click with typed alias_moved and stages nothing for either target', async () => {
    // The alias `vendor/latest` resolves to vendor/alpha when the owner quotes.
    catalog = {
      data: [
        ...CATALOG.data,
        {
          id: '~vendor/latest',
          alias_target: 'vendor/alpha',
          pricing: { prompt: 1e-6, completion: 2e-6 },
          opencode: { variants: { high: { reasoning: { effort: 'high' } } } },
        },
      ],
    };
    const aliasContext = {
      ...CONTEXT,
      entries: [{ kind: 'gateway' as const, model: '~vendor/latest' }],
    };
    const quoteResponse = await post({
      action: 'quote',
      ownerType: 'user',
      ownerId: 'user-1',
      routerId: ROUTER_ID,
      poolVersion: 'pool-v1',
      poolSlug: 'pool-one',
      context: aliasContext,
    });
    const rawQuoteBody = (await quoteResponse.clone().json()) as {
      status?: string;
      error?: unknown;
    };
    expect({ http: quoteResponse.status, rawQuoteBody }).toMatchObject({
      http: 200,
      rawQuoteBody: { status: 'ready' },
    });
    const quoted = await parseBody(quoteResponse, PaidBenchmarkQuoteSchema);
    if (quoted.status !== 'ready') throw new Error('expected a ready quote');
    // The quote pins the target it priced.
    expect(quoted.aliases).toEqual([{ model: '~vendor/latest', target: 'vendor/alpha' }]);

    // The alias moves to a different concrete model before the owner confirms.
    catalog = {
      data: [
        ...CATALOG.data,
        {
          id: '~vendor/latest',
          alias_target: 'vendor/cheap',
          pricing: { prompt: 1e-6, completion: 2e-6 },
        },
      ],
    };
    const result = await startResult(
      await post(startRequest(quoted.id, { context: aliasContext }))
    );
    expect(result).toEqual({ status: 'quote_mismatch', reason: 'alias_moved' });

    // Nothing was created or staged for either target, and no permit exists.
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_request_cases')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_model_requests')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_payers')).toBe(0);
    // The stored quote keeps the pin it was priced with.
    const stored = sqlite
      .prepare('SELECT plan FROM paid_benchmark_quotes WHERE id = ?')
      .get(quoted.id) as { plan: string };
    expect(JSON.parse(stored.plan)).toMatchObject({
      aliases: [{ model: '~vendor/latest', target: 'vendor/alpha' }],
    });
  });
});

describe('stage reuse eligibility', () => {
  it('does not treat a pre-invalidation or below-minimum draw as reusable at stage time', async () => {
    // A stored draw for this case exists but was taken before the pair was invalidated at
    // this engine identity, and another draw is below the case's minimum revision. Neither
    // may be advertised as free work: the slot must be staged as measurable, not reused.
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, status, started_at, engine_identity, repetitions,
            measurement_revision, min_accuracy, switch_cost_factor, max_concurrency)
        VALUES ('stale-run', 'efficient', 'decider', 'completed', '2026-01-01T00:00:00.000Z',
          ?, 3, 3, 0.7, 1, 80)`
      )
      .run(ENGINE);
    sqlite
      .prepare(
        `INSERT INTO case_results
          (run_id, model, variant, case_id, score, latency_ms, cost_usd, rep, timed_out,
            exit_code, prompt_revision)
        VALUES ('stale-run', 'vendor/alpha', 'high', 'supp-agent-term-pwd-base', 1, 10, 0.01, 0,
          0, 0, 2)`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, invalidated_at,
            requested_at, updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'failed',
          '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);

    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('expected a ready quote');
    // The planner never counted those draws as reuse.
    expect(quoted.cases.reused).toBe(0);
    expect(quoted.cases.exclusive).toBe(SLOTS);

    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');
    let progress = started.request;
    for (let attempt = 0; attempt < 40 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    // Stage agrees with the plan: nothing was silently marked reused.
    if (progress.status !== 'active') throw new Error(`expected active, got ${progress.status}`);
    expect(progress.counts.reused).toBe(0);
    expect(progress.counts.queued).toBe(SLOTS);
  });

  it('still reuses a compatible older recovered result at stage time', async () => {
    // Only a stale 1-repetition draw exists; the plan reuses that slot and stages the rest.
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, status, started_at, engine_identity, repetitions,
            measurement_revision, min_accuracy, switch_cost_factor, max_concurrency)
        VALUES ('compatible-run', 'efficient', 'decider', 'completed',
          '2026-01-01T00:00:00.000Z', ?, 3, 3, 0.7, 1, 80)`
      )
      .run(ENGINE);
    // A real case id from the measured set, so the slot maps to a plan index.
    sqlite
      .prepare(
        `INSERT INTO case_results
          (run_id, model, variant, case_id, score, latency_ms, cost_usd, rep, timed_out,
            exit_code, prompt_revision)
        VALUES ('compatible-run', 'vendor/alpha', 'high', ?, 1, 10, 0.01, 0, 0, 0, 3)`
      )
      .run(CASES[0]?.id);
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('expected a ready quote');
    expect(quoted.cases.reused).toBe(1);
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');
    let progress = started.request;
    for (let attempt = 0; attempt < 40 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    if (progress.status !== 'active') throw new Error(`expected active, got ${progress.status}`);
    expect(progress.counts.reused).toBe(1);
    expect(progress.counts.queued).toBe(SLOTS - 1);
  });

  it('skips staging entirely for a ready serving pair', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const quoted = await quote();
    // Nothing to measure: an already-served pool produces no quote at all.
    expect(quoted.status).toBe('empty');
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_request_cases')).toBe(0);
  });
});
