import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_PLATFORM_PROJECT_ID,
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
  planReadChunks,
  stagePaidBenchmarkRequest,
  reconcilePaidBenchmarkRequests,
  reconcilePaidUsageReceipts,
  registerPaidBenchmarkRoutes,
} from './paid-benchmark';
import {
  enqueuePaidCaseBatchStatements,
  selectPaidModelRequestPayerStatements,
} from './paid-case-store';
import { SERVING_EVIDENCE_GONE_REASON, type PaidBenchmarkPlan } from './paid-benchmark-plan';
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

/** A deterministic `pinnedAt` the pins stub reports; the contract only requires an ISO instant. */
const PINNED_AT = '2026-01-01T00:00:00.000Z';

let app: Hono<HonoEnv>;
let db: D1Database;
let sqlite: ReturnType<typeof openPaidDatabase>['sqlite'];
let billing: Recorded[];
let pins: Recorded[];
/** `${model}\u001f${target}` keys the stub has already pinned, so a replay answers `unchanged`. */
let pinned: Set<string>;

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
      // `decideServingPins` answers for exactly the aliases it was sent: each is applied on the
      // first delivery and reported `unchanged` on a replay. An empty answer is a contract
      // violation, not adoption, so the stub must not answer one.
      const applied: { model: string; target: string; pinnedAt: string }[] = [];
      const skipped: { model: string; reason: 'unchanged' }[] = [];
      for (const alias of parsed.data.aliases) {
        const key = `${alias.model}\u001f${alias.target}`;
        if (pinned.has(key)) skipped.push({ model: alias.model, reason: 'unchanged' });
        else {
          pinned.add(key);
          applied.push({ model: alias.model, target: alias.target, pinnedAt: PINNED_AT });
        }
      }
      return json({
        routerId: parsed.data.routerId,
        poolUnchanged: true,
        applied,
        skipped,
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
  pinned = new Set();
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

  it('accepts a pin-only context change when the pool identity is unchanged', async () => {
    // A settlement published a serving pin between quote and start: the context now carries
    // it, but the measurement identity (and so `pool_version`) did not change. That must not
    // invalidate a valid quote.
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const withPin = {
      ...CONTEXT,
      entries: [
        {
          kind: 'gateway' as const,
          model: 'vendor/alpha',
          servingPin: {
            model: 'vendor/alpha',
            pinnedAt: '2026-01-01T00:00:00.000Z',
            confirmedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    };
    const started = await startResult(
      await post(startRequest(quoted.id, { context: withPin as typeof CONTEXT }))
    );
    expect(started.status).toBe('started');
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
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

  it('quotes zero to move a saved pin onto a ready shared target', async () => {
    const ALIAS = '~vendor/latest';
    const OLD_TARGET = 'vendor/old-target';
    const NEW_TARGET = 'vendor/alpha';
    // The alias moved to vendor/alpha and another pool's shared result already readied it;
    // this pool still pins the old target, so its only remaining decision is that move.
    catalog = {
      data: [...CATALOG.data, { id: ALIAS, alias_target: NEW_TARGET, pricing: null }],
    };
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready', 'run-ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const context = {
      ...CONTEXT,
      entries: [
        {
          kind: 'gateway' as const,
          model: ALIAS,
          servingPin: { model: OLD_TARGET, pinnedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
    };
    const quoteResponse = await post({
      action: 'quote',
      ownerType: 'user',
      ownerId: 'user-1',
      routerId: ROUTER_ID,
      poolVersion: 'pool-v1',
      poolSlug: 'pool-one',
      context,
    });
    expect(quoteResponse.status).toBe(200);
    const quoted = await parseBody(quoteResponse, PaidBenchmarkQuoteSchema);
    expect(quoted.status).toBe('ready');
    if (quoted.status !== 'ready') return;
    // A zero-dollar ready quote: every slot is a free reuse of the already measured target.
    expect(quoted.estimateMicrodollars).toBe(0);
    expect(quoted.maximumMicrodollars).toBe(0);
    expect(quoted.cases).toEqual({ reused: SLOTS, covered: 0, shared: 0, exclusive: 0 });
    expect(quoted.aliases).toEqual([{ model: ALIAS, target: NEW_TARGET }]);

    // Nothing runs or is queued before the owner explicitly clicks.
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_request_cases')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_model_requests')).toBe(0);
    expect(billing).toHaveLength(0);
    expect(pins).toHaveLength(0);

    const started = await startResult(await post(startRequest(quoted.id, { context })));
    if (started.status !== 'started') throw new Error('start refused');
    let progress = started.request;
    for (let attempt = 0; attempt < 20 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    expect(progress.status).toBe('completed');
    if (progress.status !== 'completed') return;
    expect(progress.chargedMicrodollars).toBe(0);
    expect(progress.counts.reused).toBe(SLOTS);
    // Reuse only: no benchmark case run, permit or usage exists for the move.
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_model_requests')).toBe(0);
    expect(billing).toHaveLength(0);

    // The real drain publishes the exact alias and target the owner confirmed.
    await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(pins).toHaveLength(1);
    const pinsBody = CustomRouterPoolPinsRequestSchema.parse(pins[0]?.body);
    expect(pinsBody).toMatchObject({
      routerId: ROUTER_ID,
      ownerType: 'user',
      ownerId: 'user-1',
      poolVersion: 'pool-v1',
      aliases: [{ model: ALIAS, target: NEW_TARGET }],
    });
    expect(pinsBody.requestId).toBe(startedRequestId(progress));
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_billing_outbox WHERE status = 'delivered'"
      )
    ).toBe(1);

    // Replaying the same confirmation delivers nothing again and spends nothing.
    const replay = await startResult(await post(startRequest(quoted.id, { context })));
    expect(replay.status).toBe('started');
    await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(pins).toHaveLength(1);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(0);
    expect(billing).toHaveLength(0);

    // Once the saved pin names the current target there is nothing left to ask for.
    const settled = await post({
      action: 'quote',
      ownerType: 'user',
      ownerId: 'user-1',
      routerId: ROUTER_ID,
      poolVersion: 'pool-v1',
      poolSlug: 'pool-one',
      context: {
        ...CONTEXT,
        entries: [
          {
            kind: 'gateway' as const,
            model: ALIAS,
            servingPin: { model: NEW_TARGET, pinnedAt: '2026-01-02T00:00:00.000Z' },
          },
        ],
      },
    });
    expect(await parseBody(settled, PaidBenchmarkQuoteSchema)).toEqual({ status: 'empty' });
  });

  it('completes and pins a mixed quote when its new target readies before the click', async () => {
    const ALIAS = '~vendor/latest';
    catalog = {
      data: [...CATALOG.data, { id: ALIAS, alias_target: 'vendor/alpha', pricing: null }],
    };
    // The launcher resolves the run identity before it reads the plan, and the shared fixture
    // seeds a saved override the bot-token mint refuses. A real deployment runs an internal
    // bot user, so install one to reach the branch under test instead of failing on config.
    sqlite.prepare(`UPDATE benchmark_config SET benchmark_user_id = 'bot-internal-1'`).run();
    // The serving alias target is already measured; the new concrete target is not.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready', 'run-ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const context = {
      ...CONTEXT,
      entries: [
        { kind: 'gateway' as const, model: ALIAS },
        { kind: 'gateway' as const, model: 'vendor/cheap' },
      ],
    };
    const quoted = await parseBody(
      await post({
        action: 'quote',
        ownerType: 'user',
        ownerId: 'user-1',
        routerId: ROUTER_ID,
        poolVersion: 'pool-v1',
        poolSlug: 'pool-one',
        context,
      }),
      PaidBenchmarkQuoteSchema
    );
    expect(quoted.status).toBe('ready');
    if (quoted.status !== 'ready') return;
    // Only the new target is demand; the alias target is a free reuse.
    expect(quoted.cases).toEqual({ reused: SLOTS, covered: 0, shared: 0, exclusive: SLOTS });
    expect(quoted.aliases).toEqual([{ model: ALIAS, target: 'vendor/alpha' }]);

    // Another measurement readies the new target before this owner clicks. The launch then
    // finds every non-serving quoted pair ready and completes without claiming a run.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/cheap', '', ?, 3, 'ready', 'run-ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);

    const started = await startResult(await post(startRequest(quoted.id, { context })));
    if (started.status !== 'started') throw new Error('start refused');
    let progress = started.request;
    for (let attempt = 0; attempt < 20 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    expect(progress.status).toBe('completed');
    if (progress.status !== 'completed') return;
    // Nothing was measured or charged: every target already serves, so completion cancels the
    // staged placeholder rows and claims no run.
    expect(progress.chargedMicrodollars).toBe(0);
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM benchmark_case_runs WHERE status IN ('queued', 'running')"
      )
    ).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_runs')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_model_requests')).toBe(0);
    expect(billing).toHaveLength(0);

    // The completion batch carried the pin intent; the real drain delivers the confirmed alias.
    await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(pins).toHaveLength(1);
    const pinsBody = CustomRouterPoolPinsRequestSchema.parse(pins[0]?.body);
    expect(pinsBody.aliases).toEqual([{ model: ALIAS, target: 'vendor/alpha' }]);
    expect(pinsBody.requestId).toBe(startedRequestId(progress));
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_billing_outbox WHERE status = 'delivered'"
      )
    ).toBe(1);

    const caseRunsBeforeReplay = countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs');
    // A replay neither starts a run nor delivers a second pin.
    const replay = await startResult(await post(startRequest(quoted.id, { context })));
    expect(replay.status).toBe('started');
    await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(pins).toHaveLength(1);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(
      caseRunsBeforeReplay
    );
    expect(billing).toHaveLength(0);
  });

  it('refuses a pin move whose ready evidence is gone, before consuming', async () => {
    const ALIAS = '~vendor/latest';
    const OLD_TARGET = 'vendor/old-target';
    const NEW_TARGET = 'vendor/alpha';
    catalog = {
      data: [...CATALOG.data, { id: ALIAS, alias_target: NEW_TARGET, pricing: null }],
    };
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready', 'run-ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const context = {
      ...CONTEXT,
      entries: [
        {
          kind: 'gateway' as const,
          model: ALIAS,
          servingPin: { model: OLD_TARGET, pinnedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
    };
    const quoted = await parseBody(
      await post({
        action: 'quote',
        ownerType: 'user',
        ownerId: 'user-1',
        routerId: ROUTER_ID,
        poolVersion: 'pool-v1',
        poolSlug: 'pool-one',
        context,
      }),
      PaidBenchmarkQuoteSchema
    );
    expect(quoted.status).toBe('ready');
    if (quoted.status !== 'ready') return;
    expect(quoted.maximumMicrodollars).toBe(0);

    // The ready profile behind the quote is removed before the owner clicks.
    sqlite
      .prepare("DELETE FROM benchmark_profiles WHERE model = 'vendor/alpha' AND status = 'ready'")
      .run();

    const started = await startResult(await post(startRequest(quoted.id, { context })));
    expect(started).toEqual({
      status: 'blocked',
      reason: SERVING_EVIDENCE_GONE_REASON,
      retryable: true,
    });
    // Nothing was consumed, staged, measured or pinned.
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_request_cases')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_model_requests')).toBe(0);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_billing_outbox')).toBe(0);
    const quoteRow = sqlite
      .prepare('SELECT started_request_id FROM paid_benchmark_quotes')
      .get() as { started_request_id: string | null };
    expect(quoteRow.started_request_id).toBeNull();
    expect(pins).toHaveLength(0);
    expect(billing).toHaveLength(0);

    // A re-inserted `ready` row with no measuring run is still not serving evidence: the same
    // quote refuses while it points nowhere, and confirms once provenance returns.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready', NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    expect(await startResult(await post(startRequest(quoted.id, { context })))).toEqual({
      status: 'blocked',
      reason: SERVING_EVIDENCE_GONE_REASON,
      retryable: true,
    });
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(0);
    sqlite
      .prepare("UPDATE benchmark_profiles SET run_id = 'run-ready' WHERE model = 'vendor/alpha'")
      .run();
    const retried = await startResult(await post(startRequest(quoted.id, { context })));
    expect(retried.status).toBe('started');
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(0);
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
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready', 'run-ready',
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
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready', 'run-ready',
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
    // This request paused before any case run was claimed, so there is no running generation
    // to cancel: the delivery attempt fails for its own reason and the committed pause stands
    // with nothing to redeliver. No intent is invented for a generation that never started.
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_cancellations WHERE status = 'pending'"
      )
    ).toBe(0);
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

  it('books a platform-covered receipt through the reconciler and credits no owner', async () => {
    // A covered call has no paying pool request; the reconciler must still book it (its
    // native read reports the run's benchmark organization) and must not add to any owner's
    // charged total.
    const platformOrg = 'org-benchmark-platform';
    sqlite
      .prepare(
        `INSERT INTO paid_model_requests
          (id, engine_identity, model, variant, rep, case_id, generation, pool_request_id,
            state, assignment_id, owner_type, owner_id, platform_covered, reason, api,
            executor_user_id, project_id, usage_id, platform_organization_id,
            created_at, updated_at)
        VALUES ('cov-1', 'engine-test', ?, '', 0, 'case-a', 1, NULL, 'admitted', ?,
          'user', 'user-1', 1, NULL, 'chat/completions', 'bot-internal-1', ?, ?, ?, ?, ?)`
      )
      .run(
        MIXED_CASE_MODEL,
        'ffff9999-9999-4999-8999-999999999999',
        BENCHMARK_PLATFORM_PROJECT_ID,
        'aaaa8888-8888-4888-8888-888888888888',
        platformOrg,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
    // Two owners each staged this exact case, so the receipt has real round-trip owners it
    // could be miscredited to. Any arbitrary-owner fallback would move one of these totals.
    // Each owner saves their own pool, so each request carries its own active router id.
    for (const [requestId, owner, routerId] of [
      ['owner-req', 'user-1', '33333333-3333-4333-8333-333333333331'],
      ['owner-req-2', 'user-2', '33333333-3333-4333-8333-333333333332'],
    ]) {
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_requests
            (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
              engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
              charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
              context, created_at, updated_at, activated_at)
          VALUES (?, 'user', ?, NULL, 'efficient', ?, 'v',
            'engine-test', 'active', 'q', 100, 100, 0, 1, 1, NULL, ?, '{}',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z')`
        )
        .run(requestId, owner, routerId, owner);
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_request_cases
            (request_id, engine_identity, model, variant, rep, case_id, status,
              covered_by_kilo, charged_microdollars, reason, updated_at)
          VALUES (?, 'engine-test', ?, '', 0, 'case-a', 'running', 0, 0, NULL,
            '2026-01-01T00:00:00.000Z')`
        )
        .run(requestId, MIXED_CASE_MODEL);
    }
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = BenchmarkUsageReceiptRequestSchema.parse(await request.json());
      return new Response(
        JSON.stringify({
          receipts: body.usageIds.map(usageId => ({
            usageId,
            status: 'recorded',
            microdollars: 90,
            payerType: 'organization',
            payerId: platformOrg,
            projectId: BENCHMARK_PLATFORM_PROJECT_ID,
            requestedModel: MIXED_CASE_MODEL.toLowerCase(),
            model: MIXED_CASE_MODEL,
            createdAt: '2026-01-01T00:00:00.000Z',
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const summary = await reconcilePaidUsageReceipts(paidBindings(db), { fetchImpl });
    expect(summary).toMatchObject({ recorded: 1, mismatched: 0, pending: 0 });
    const usage = sqlite
      .prepare(
        'SELECT usage_id, request_id, platform_covered, microdollars FROM paid_attempt_usage'
      )
      .all() as Array<Record<string, unknown>>;
    expect(usage).toEqual([
      {
        usage_id: 'aaaa8888-8888-4888-8888-888888888888',
        request_id: '',
        platform_covered: 1,
        microdollars: 90,
      },
    ]);
    // Neither linked owner is credited: Kilo paid it, and the covered receipt carries no
    // owning request at all.
    expect(
      sqlite
        .prepare('SELECT id, charged_microdollars FROM paid_benchmark_requests ORDER BY id')
        .all()
    ).toEqual([
      { id: 'owner-req', charged_microdollars: 0 },
      { id: 'owner-req-2', charged_microdollars: 0 },
    ]);
    expect(
      sqlite
        .prepare(
          'SELECT request_id, charged_microdollars FROM paid_benchmark_request_cases ORDER BY request_id'
        )
        .all()
    ).toEqual([
      { request_id: 'owner-req', charged_microdollars: 0 },
      { request_id: 'owner-req-2', charged_microdollars: 0 },
    ]);
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
  });
});

describe('permanent launch refusal', () => {
  /**
   * A second, genuinely launchable request on its own saved pool: its own quote carrying the
   * unchanged frozen plan, its own router id, and a real staged slot. It exists so a failure
   * of the first request can be proven not to touch funded sibling work.
   */
  function seedLaunchableSibling(planJson: string) {
    const requestId = 'sibling-request';
    const quoteId = 'sibling-quote';
    const at = '2026-01-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_quotes
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
            plan_cases, expires_at, started_request_id, created_at, updated_at)
        VALUES (?, 'user', 'user-2', NULL, 'efficient', ?, 'pool-v1', ?, '{}', ?, 100, 100, 0,
          '2027-01-01T00:00:00.000Z', ?, ?, ?)`
      )
      .run(quoteId, '22222222-2222-4222-8222-222222222222', ENGINE, planJson, requestId, at, at);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
            charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
            context, created_at, updated_at, activated_at)
        VALUES (?, 'user', 'user-2', NULL, 'efficient', ?, 'pool-v1', ?, 'active', ?, 100, 100,
          0, 0, 0, NULL, 'user-2', '{}', ?, ?, ?)`
      )
      .run(requestId, '22222222-2222-4222-8222-222222222222', ENGINE, quoteId, at, at, at);
    return requestId;
  }

  it('fails only the refused request and leaves a funded sibling untouched', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started' || started.request.status === 'empty')
      throw new Error('start refused');
    const requestId = started.request.id;
    const planJson = (
      sqlite.prepare('SELECT plan FROM paid_benchmark_quotes WHERE id = ?').get(quoted.id) as {
        plan: string;
      }
    ).plan;
    const siblingId = seedLaunchableSibling(planJson);
    // Freeze a plan the engine will refuse: 1 repetition while it now runs 3.
    const plan = JSON.parse(planJson) as Record<string, unknown>;
    sqlite
      .prepare('UPDATE paid_benchmark_quotes SET plan = ? WHERE id = ?')
      .run(JSON.stringify({ ...plan, repetitions: 1 }), quoted.id);
    sqlite
      .prepare(`UPDATE paid_benchmark_requests SET status = 'active', updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00.000Z', requestId);
    // A valid bot identity, so the refusal below is THIS plan's, not a deployment-wide config
    // error (which stays retryable by design and is asserted separately).
    sqlite.prepare(`UPDATE benchmark_config SET benchmark_user_id = 'bot-internal-1'`).run();

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(summary.failed).toEqual([requestId]);
    const refused = sqlite
      .prepare(
        'SELECT status, failure_reason, failure_retryable FROM paid_benchmark_requests WHERE id = ?'
      )
      .get(requestId) as { status: string; failure_reason: string; failure_retryable: number };
    expect(refused.status).toBe('failed');
    expect(refused.failure_reason).toMatch(/confirmed for 1 repetitions but the engine now runs/);
    expect(refused.failure_retryable).toBe(0);

    // The sibling is untouched: still active, no charge, and it got its own run.
    const sibling = sqlite
      .prepare('SELECT status, charged_microdollars FROM paid_benchmark_requests WHERE id = ?')
      .get(siblingId) as { status: string; charged_microdollars: number };
    expect(sibling).toEqual({ status: 'active', charged_microdollars: 0 });
    expect(countRows('SELECT COUNT(*) AS count FROM paid_attempt_usage')).toBe(0);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM benchmark_runs WHERE purpose = ?').get('user')
    ).not.toEqual({ count: 0 });
  });

  it('keeps a request active on a transient configuration fault', async () => {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started' || started.request.status === 'empty')
      throw new Error('start refused');
    const requestId = started.request.id;
    sqlite
      .prepare(`UPDATE paid_benchmark_requests SET status = 'active', updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00.000Z', requestId);
    // A deployment-wide fault (non-bot executor override), not this request's plan: the request
    // must stay active and retry, never be failed by a launch classification.
    sqlite.prepare(`UPDATE benchmark_config SET benchmark_user_id = 'bench-user'`).run();

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(summary.failed).toEqual([]);
    const request = sqlite
      .prepare('SELECT status, failure_reason FROM paid_benchmark_requests WHERE id = ?')
      .get(requestId) as { status: string; failure_reason: string | null };
    expect(request).toEqual({ status: 'active', failure_reason: null });

    // And once the fault is fixed the same request launches, so nothing was stranded.
    sqlite.prepare(`UPDATE benchmark_config SET benchmark_user_id = 'bot-internal-1'`).run();
    const retry = await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(retry.failed).toEqual([]);
    expect(
      sqlite.prepare('SELECT status FROM paid_benchmark_requests WHERE id = ?').get(requestId)
    ).toEqual({ status: 'active' });
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
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready', 'run-ready',
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

describe('terminal unusable measurement', () => {
  /** Quote, start and advance the real staging path until the request is active. */
  async function activeRequest(): Promise<{ requestId: string; cases: number }> {
    const quoted = await quote();
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const started = await startResult(await post(startRequest(quoted.id)));
    if (started.status !== 'started') throw new Error('start refused');
    let progress = started.request;
    for (let attempt = 0; attempt < 20 && progress.status === 'preparing'; attempt += 1)
      progress = await progressBody(await post(progressRequest()));
    if (progress.status !== 'active')
      throw new Error(`expected an active request, got ${progress.status}`);
    return { requestId: progress.id, cases: SLOTS };
  }

  /**
   * Settle every canonical case run of the request the way the measured path does for a
   * scored, unusable result: terminal `settled` with `result_usable = 0` and the scored
   * error of that exact execution. The display rows are deliberately left untouched, which
   * is the state that stranded the request.
   */
  function settleUnusable(
    error: string,
    only?: ReadonlyArray<{ model: string; variant: string; rep: number; case_id: string }>
  ): void {
    sqlite
      .prepare(
        `INSERT INTO case_results (
          run_id, model, variant, case_id, score, latency_ms, error, exit_code, rep,
          timed_out, prompt_revision
        )
        SELECT 'exec-1', model, variant, case_id, 0, 1, ?, 1, rep, 0, 1
        FROM benchmark_case_runs`
      )
      .run(error);
    const rows = sqlite
      .prepare('SELECT model, variant, rep, case_id FROM benchmark_case_runs')
      .all() as Array<{ model: string; variant: string; rep: number; case_id: string }>;
    const named = only
      ? new Set(only.map(row => JSON.stringify([row.model, row.variant, row.rep, row.case_id])))
      : null;
    for (const row of rows) {
      if (named && !named.has(JSON.stringify([row.model, row.variant, row.rep, row.case_id])))
        continue;
      sqlite
        .prepare(
          `UPDATE benchmark_case_runs
          SET status = 'settled', result_usable = 0, settled_at = '2026-01-02T00:00:00.000Z',
            settlement_id = 'settle-unusable', executor_run_id = 'exec-1',
            executor_token = 'token-1'
          WHERE model = ? AND variant = ? AND rep = ? AND case_id = ?`
        )
        .run(row.model, row.variant, row.rep, row.case_id);
    }
  }

  function insertPriorCharge(requestId: string, microdollars: number): void {
    const run = sqlite
      .prepare('SELECT model, variant, rep, case_id FROM benchmark_case_runs LIMIT 1')
      .get() as { model: string; variant: string; rep: number; case_id: string };
    sqlite
      .prepare(
        `INSERT INTO paid_model_requests (
          id, engine_identity, model, variant, rep, case_id, generation, pool_request_id,
          state, assignment_id, owner_type, owner_id, platform_covered, reason, created_at,
          updated_at
        ) VALUES ('mr-prior', ?, ?, ?, ?, ?, 1, ?, 'completed', 'assignment-prior', 'user',
          'user-1', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE, run.model, run.variant, run.rep, run.case_id, requestId);
    sqlite
      .prepare(
        `INSERT INTO paid_attempt_usage (
          usage_id, model_request_id, request_id, engine_identity, model, variant, rep,
          case_id, generation, owner_type, owner_id, microdollars, platform_covered, created_at
        ) VALUES ('usage-prior', 'mr-prior', ?, ?, ?, ?, ?, ?, 1, 'user', 'user-1', ?, 0,
          '2026-01-01T00:00:00.000Z')`
      )
      .run(requestId, ENGINE, run.model, run.variant, run.rep, run.case_id, microdollars);
    // The store's receipt batch also raises the request total; mirror it.
    sqlite
      .prepare('UPDATE paid_benchmark_requests SET charged_microdollars = ? WHERE id = ?')
      .run(microdollars, requestId);
  }

  it('terminalizes a request whose measured slots all finished unusable, once', async () => {
    // The exact fixture: every staged slot's canonical run settled with a scored
    // `admission_unavailable` and `result_usable = 0`, its display row still `queued`.
    const { requestId } = await activeRequest();
    insertPriorCharge(requestId, 250);
    settleUnusable('admission_unavailable: The gateway could not confirm admission; retry.');
    expect(requestRow()?.status).toBe('active');

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db));
    // Visible terminal state with a clear reason, never a silent `active` row.
    expect(summary.failed).toEqual([requestId]);
    expect(requestRow()).toMatchObject({ status: 'failed' });
    const failed = sqlite
      .prepare(
        'SELECT status, failure_reason, failure_retryable FROM paid_benchmark_requests WHERE id = ?'
      )
      .get(requestId) as { status: string; failure_reason: string; failure_retryable: number };
    expect(failed.status).toBe('failed');
    expect(failed.failure_reason).toBe('No case produced a usable result.');
    // Retryable: the owner may confirm again; nothing resumes this confirmation by itself.
    expect(failed.failure_retryable).toBe(1);
    // Each display row shows the fixed request-facing copy, never the raw scored error: the
    // fixture's error text came from a shared execution and is user-facing here only through
    // the controlled reason.
    expect(
      sqlite
        .prepare(
          'SELECT DISTINCT status, reason FROM paid_benchmark_request_cases WHERE request_id = ?'
        )
        .all(requestId)
    ).toEqual([{ status: 'failed', reason: 'The measurement finished without a usable result.' }]);
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_request_cases WHERE reason LIKE '%admission_unavailable%'"
      )
    ).toBe(0);
    // The prior billed call is untouched: no retro refund, no new spend, no new run.
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM paid_attempt_usage').get()).toEqual({
      count: 1,
    });
    const runs = countRows('SELECT COUNT(*) AS count FROM benchmark_runs');
    const caseRuns = countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs');

    // Already-terminal display rows are not rewritten: capture them, then prove repeated
    // passes change neither their status, reason nor `updated_at`.
    const before = sqlite
      .prepare(
        `SELECT case_id, status, reason, updated_at FROM paid_benchmark_request_cases
        WHERE request_id = ? ORDER BY case_id`
      )
      .all(requestId);

    // The same confirmation never relaunches: the next pass finds nothing live.
    const again = await reconcilePaidBenchmarkRequests(paidBindings(db));
    expect(again).toMatchObject({ failed: [], completed: [] });
    expect(requestRow()?.status).toBe('failed');
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_runs')).toBe(runs);
    expect(countRows('SELECT COUNT(*) AS count FROM benchmark_case_runs')).toBe(caseRuns);
    expect(countRows('SELECT COUNT(*) AS count FROM paid_attempt_usage')).toBe(1);
    for (let pass = 0; pass < 3; pass += 1) {
      await reconcilePaidBenchmarkRequests(paidBindings(db));
      await progressBody(await post(progressRequest()));
    }
    expect(
      sqlite
        .prepare(
          `SELECT case_id, status, reason, updated_at FROM paid_benchmark_request_cases
          WHERE request_id = ? ORDER BY case_id`
        )
        .all(requestId)
    ).toEqual(before);

    // The owner's own progress read reports the same terminal state.
    const progress = await progressBody(await post(progressRequest()));
    expect(progress.status).toBe('failed');
    if (progress.status !== 'failed') return;
    expect(progress.reason).toBe('No case produced a usable result.');
    expect(progress.retryable).toBe(true);
    expect(progress.counts.failed).toBe(SLOTS);
    expect(progress.chargedMicrodollars).toBe(250);
  });

  it('never copies a raw scored error into the request-facing reason', async () => {
    // Two slots finish unusable with different raw diagnostics, one of which looks like it
    // carries another payer's and provider's details. The display copy must not depend on
    // either: an unusable slot with no controlled reason shows one fixed safe note.
    const { requestId } = await activeRequest();
    const rows = sqlite
      .prepare(
        'SELECT model, variant, rep, case_id FROM benchmark_case_runs ORDER BY case_id LIMIT 2'
      )
      .all() as Array<{ model: string; variant: string; rep: number; case_id: string }>;
    const raw = [
      'HTTP 502 from upstream: org=acme key=sk-live-abc customer=someone@example.com',
      'admission_unavailable: The gateway could not confirm admission; retry.',
    ];
    rows.forEach((row, index) => {
      sqlite
        .prepare(
          `INSERT INTO case_results (
            run_id, model, variant, case_id, score, latency_ms, error, exit_code, rep,
            timed_out, prompt_revision
          ) VALUES ('exec-1', ?, ?, ?, 0, 1, ?, 1, ?, 0, 1)`
        )
        .run(row.model, row.variant, row.case_id, raw[index], row.rep);
      sqlite
        .prepare(
          `UPDATE benchmark_case_runs
          SET status = 'settled', result_usable = 0, failure_reason = NULL,
            settled_at = '2026-01-02T00:00:00.000Z', settlement_id = 'settle-unusable',
            executor_run_id = 'exec-1', executor_token = 'token-1'
          WHERE model = ? AND variant = ? AND rep = ? AND case_id = ?`
        )
        .run(row.model, row.variant, row.rep, row.case_id);
    });

    await progressBody(await post(progressRequest()));
    const shown = sqlite
      .prepare(
        `SELECT DISTINCT reason FROM paid_benchmark_request_cases
        WHERE request_id = ? AND case_id IN (?, ?) AND status = 'failed'`
      )
      .all(requestId, rows[0]?.case_id, rows[1]?.case_id) as Array<{ reason: string }>;
    expect(shown).toEqual([{ reason: 'The measurement finished without a usable result.' }]);
    const leaked = sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM paid_benchmark_request_cases
        WHERE request_id = ?
          AND (reason LIKE '%sk-live%' OR reason LIKE '%acme%' OR reason LIKE '%admission_unavailable%'
            OR reason LIKE '%example.com%')`
      )
      .get(requestId) as { count: number };
    expect(leaked).toEqual({ count: 0 });

    // The raw diagnostics are still in `case_results`, where an operator can read them.
    expect(
      countRows("SELECT COUNT(*) AS count FROM case_results WHERE error LIKE '%sk-live%'")
    ).toBe(1);
  });

  it('reports a controlled canonical reason when the run recorded one', async () => {
    // A permanently unavailable pair writes its own reason on the canonical run; that
    // worker-authored copy is the one an owner may see.
    const { requestId } = await activeRequest();
    const row = sqlite
      .prepare(
        'SELECT model, variant, rep, case_id FROM benchmark_case_runs ORDER BY case_id LIMIT 1'
      )
      .get() as { model: string; variant: string; rep: number; case_id: string };
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'failed', result_usable = 0, failure_reason = 'This model pair is no longer available.',
          settled_at = '2026-01-02T00:00:00.000Z', settlement_id = 'settle-unavailable'
        WHERE model = ? AND variant = ? AND rep = ? AND case_id = ?`
      )
      .run(row.model, row.variant, row.rep, row.case_id);

    await progressBody(await post(progressRequest()));
    expect(
      sqlite
        .prepare(
          'SELECT status, reason FROM paid_benchmark_request_cases WHERE request_id = ? AND case_id = ?'
        )
        .get(requestId, row.case_id)
    ).toEqual({ status: 'failed', reason: 'This model pair is no longer available.' });
  });

  it('keeps a live slot live, completes on a usable slot and promotes a late usable result', async () => {
    // Two slots behave differently: one conclusively unusable while the other is still
    // pending, so the request must NOT be terminalized yet; then the unusable slot's own
    // run proves usable late and must be promoted to done, and the request completes once
    // the last slot is terminal.
    const { requestId } = await activeRequest();
    const [first] = sqlite
      .prepare(
        'SELECT model, variant, rep, case_id FROM benchmark_case_runs ORDER BY case_id LIMIT 1'
      )
      .all() as Array<{ model: string; variant: string; rep: number; case_id: string }>;
    settleUnusable('admission_unavailable: retry.', [first]);

    const firstPass = await progressBody(await post(progressRequest()));
    if (firstPass.status !== 'active') throw new Error(`expected active, got ${firstPass.status}`);
    expect(firstPass.counts.queued).toBe(SLOTS - 1);
    expect(firstPass.counts.failed).toBe(1);
    expect(firstPass.counts.done).toBe(0);
    expect(requestRow()?.status).toBe('active');

    // A late usable result for that same execution arrives (the run's own late-result path
    // raises `result_usable` on the terminal row). The next read promotes it, never counts
    // it as a failure.
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs SET result_usable = 1
        WHERE model = ? AND variant = ? AND rep = ? AND case_id = ?`
      )
      .run(first.model, first.variant, first.rep, first.case_id);
    const promoted = await progressBody(await post(progressRequest()));
    if (promoted.status !== 'active') throw new Error(`expected active, got ${promoted.status}`);
    expect(promoted.counts.done).toBe(1);
    expect(promoted.counts.failed).toBe(0);
    expect(
      sqlite
        .prepare(
          'SELECT status, reason FROM paid_benchmark_request_cases WHERE request_id = ? AND case_id = ?'
        )
        .get(requestId, first.case_id)
    ).toEqual({ status: 'done', reason: null });

    // Every remaining slot finishes usable too: the request completes with its pins intent.
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs
        SET status = 'settled', result_usable = 1, settled_at = '2026-01-02T00:00:00.000Z',
          settlement_id = 'settle-usable', executor_run_id = 'exec-2', executor_token = 'token-2'
        WHERE status = 'queued'`
      )
      .run();
    const completed = await progressBody(await post(progressRequest()));
    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') return;
    expect(completed.counts.done).toBe(SLOTS);
    expect(completed.counts.failed).toBe(0);
  });
});

describe('bounded plan reads', () => {
  it('splits the served set so one plan query stays inside its byte budget', () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ quote_id: `q${index}` }));
    // Wide plans (~250 KB each) never share a query beyond the 2 MB budget.
    const wide = new Map(rows(12).map(row => [row.quote_id, 250_000]));
    const wideChunks = planReadChunks(rows(12), wide);
    expect(wideChunks.map(chunk => chunk.length)).toEqual([8, 4]);
    for (const chunk of wideChunks)
      expect(
        chunk.reduce((sum, row) => sum + (wide.get(row.quote_id) ?? 0), 0)
      ).toBeLessThanOrEqual(2 * 1024 * 1024);
    // Typical plans (~18 KB) all fit in one read.
    const typical = new Map(rows(50).map(row => [row.quote_id, 18_000]));
    expect(planReadChunks(rows(50), typical)).toHaveLength(1);
    // A single oversized plan still gets its own chunk, so it can never be unreachable.
    const huge = new Map([['q0', 9_000_000]]);
    expect(planReadChunks(rows(1), huge)).toHaveLength(1);
  });
});

describe('paid request staging liveness', () => {
  /** Two extra catalog models, so a test can quote a pool of three or four concrete pairs. */
  const WIDE_CATALOG = {
    data: [
      ...CATALOG.data,
      { id: 'vendor/third', pricing: { prompt: 1e-6, completion: 2e-6 } },
      { id: 'vendor/fourth', pricing: { prompt: 1e-6, completion: 2e-6 } },
    ],
  };
  const MINUTE_MS = 60 * 1000;
  const ABANDON_REASON = 'Benchmark request was never activated.';
  /** The old cron staged `STAGE_BATCH_SLOTS * 2` (80) a minute: one hour of it is 4,800. */
  const ONE_HOUR_OF_OLD_CRON_SLOTS = 4_800;

  type PoolContext = typeof CONTEXT;

  function poolContext(models: readonly string[]): PoolContext {
    return {
      ...CONTEXT,
      entries: models.map(model => ({ kind: 'gateway' as const, model })),
    };
  }

  async function quoteFor(context: PoolContext): Promise<PaidBenchmarkQuote> {
    const response = await post({
      action: 'quote',
      ownerType: 'user',
      ownerId: 'user-1',
      routerId: ROUTER_ID,
      poolVersion: 'pool-v1',
      poolSlug: 'pool-one',
      context,
    });
    expect(response.status).toBe(200);
    return parseBody(response, PaidBenchmarkQuoteSchema);
  }

  /** A started request for `models`; throws unless the worker accepted the click. */
  async function startFor(models: readonly string[]): Promise<{
    requestId: string;
    planCases: number;
    context: PoolContext;
  }> {
    catalog = WIDE_CATALOG;
    const context = poolContext(models);
    const quoted = await quoteFor(context);
    if (quoted.status !== 'ready') throw new Error(`quote not ready: ${quoted.status}`);
    expect(quoted.cases.exclusive).toBe(models.length * SLOTS);
    const started = await startResult(await post(startRequest(quoted.id, { context })));
    if (started.status !== 'started' || started.request.status === 'empty')
      throw new Error(`start refused: ${started.status}`);
    return {
      requestId: startedRequestId(started.request),
      planCases: quoted.cases.exclusive,
      context,
    };
  }

  function requestState(requestId: string): {
    status: string;
    staged_cases: number;
    plan_cases: number;
    last_staged_at: string | null;
    updated_at: string;
    failure_reason: string | null;
    failure_retryable: number;
  } {
    const row = sqlite
      .prepare(
        `SELECT status, staged_cases, plan_cases, last_staged_at, updated_at, failure_reason,
          failure_retryable
        FROM paid_benchmark_requests WHERE id = ?`
      )
      .get(requestId);
    if (!row) throw new Error('request row missing');
    return row as never;
  }

  function liveRequestCount(): number {
    return countRows(
      "SELECT COUNT(*) AS count FROM paid_benchmark_requests WHERE status IN ('preparing', 'active')"
    );
  }

  it('keeps a two-hour-old request preparing while its staging is still progressing', async () => {
    const { requestId, planCases } = await startFor([
      'vendor/alpha',
      'vendor/cheap',
      'vendor/third',
      'vendor/fourth',
    ]);
    const now = Date.now();
    // Created two hours ago, which the old creation-age guard abandons outright, but a slot
    // was staged a minute ago: the request is alive and must keep staging.
    sqlite
      .prepare(
        `UPDATE paid_benchmark_requests
        SET created_at = ?, last_staged_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        new Date(now - 120 * MINUTE_MS).toISOString(),
        new Date(now - MINUTE_MS).toISOString(),
        new Date(now - MINUTE_MS).toISOString(),
        requestId
      );

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), { now });
    expect(summary.closed).toEqual([]);
    const state = requestState(requestId);
    expect(state.status).toBe('preparing');
    // One cron pass stages the whole shared budget and the plan is wider than that, so it is
    // still staging rather than terminal or active.
    expect(state.staged_cases).toBeGreaterThan(0);
    expect(state.staged_cases).toBeLessThan(planCases);
    expect(state.failure_reason).toBeNull();
  });

  it('fails a request whose staging has made no progress for over an hour', async () => {
    const { requestId } = await startFor([
      'vendor/alpha',
      'vendor/cheap',
      'vendor/third',
      'vendor/fourth',
    ]);
    const now = Date.now();
    sqlite
      .prepare(
        `UPDATE paid_benchmark_requests
        SET created_at = ?, last_staged_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        new Date(now - 180 * MINUTE_MS).toISOString(),
        new Date(now - 61 * MINUTE_MS).toISOString(),
        new Date(now - 61 * MINUTE_MS).toISOString(),
        requestId
      );

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), { now });
    expect(summary.closed).toEqual([requestId]);
    expect(requestState(requestId)).toMatchObject({
      status: 'failed',
      failure_reason: ABANDON_REASON,
      failure_retryable: 1,
    });
    // The pool's only live-request slot is free again.
    expect(liveRequestCount()).toBe(0);
  });

  it('never treats a staging pass that inserts nothing as progress', async () => {
    const { requestId } = await startFor([
      'vendor/alpha',
      'vendor/cheap',
      'vendor/third',
      'vendor/fourth',
    ]);
    const base = Date.parse(requestState(requestId).last_staged_at ?? '');
    expect(Number.isFinite(base)).toBe(true);
    const stagedBefore = requestState(requestId).staged_cases;
    expect(stagedBefore).toBeGreaterThan(0);
    const row = sqlite
      .prepare(
        'SELECT engine_identity, model, variant, rep, case_id FROM benchmark_case_runs LIMIT 1'
      )
      .get() as {
      engine_identity: string;
      model: string;
      variant: string;
      rep: number;
      case_id: string;
    };
    const key = {
      engineIdentity: row.engine_identity,
      model: row.model,
      variant: row.variant,
      rep: row.rep,
      caseId: row.case_id,
    };

    // The cron keeps running staging passes that insert nothing. Each one rewrites the row
    // (`updated_at` moves, which is exactly what made a stuck request look alive), so the
    // liveness stamp must stay on the last slot that was actually written.
    for (let minute = 1; minute <= 61; minute += 1) {
      await db.batch(
        enqueuePaidCaseBatchStatements(db, {
          requestId,
          cases: [{ ...key, coveredByKilo: false }],
          now: base + minute * MINUTE_MS,
        })
      );
      const state = requestState(requestId);
      expect(state.staged_cases).toBe(stagedBefore);
      expect(state.last_staged_at).toBe(new Date(base).toISOString());
      expect(state.updated_at).toBe(new Date(base + minute * MINUTE_MS).toISOString());
    }

    const now = base + 62 * MINUTE_MS;
    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), { now });
    expect(summary.closed).toEqual([requestId]);
    expect(requestState(requestId)).toMatchObject({
      status: 'failed',
      failure_reason: ABANDON_REASON,
      failure_retryable: 1,
    });
    expect(liveRequestCount()).toBe(0);
  });

  it('stages a plan bigger than an hour of the old cron budget to active through cron alone', async () => {
    // Three pairs are 3 × SLOTS slots, more than one hour of the old 80-slots-a-minute cron,
    // and the browser never polls: every advance below is a scheduled reconcile pass.
    const { requestId, planCases } = await startFor([
      'vendor/alpha',
      'vendor/cheap',
      'vendor/third',
    ]);
    expect(planCases).toBeGreaterThan(ONE_HOUR_OF_OLD_CRON_SLOTS);
    expect(requestState(requestId).status).toBe('preparing');

    const now = Date.now();
    let passes = 0;
    let stagedBefore = requestState(requestId).staged_cases;
    while (requestState(requestId).status === 'preparing' && passes < 5) {
      passes += 1;
      const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), {
        now: now + passes * MINUTE_MS,
      });
      expect(summary.closed).toEqual([]);
      const stagedAfter = requestState(requestId).staged_cases;
      // Each pass carries the raised budget (4,400), not the retired 80-slot slice.
      expect(stagedAfter - stagedBefore).toBeLessThanOrEqual(4_400);
      stagedBefore = stagedAfter;
    }
    // A plan one hour of the old cron could not finish inside the inactivity window (and three
    // pairs of the measured case set is larger than the new per-tick budget) still activates
    // from cron passes alone, in two of them.
    expect(passes).toBe(2);
    expect(requestState(requestId)).toMatchObject({ status: 'active', staged_cases: planCases });
  });

  it('lets the same owner and router start again after an abandon, and the retry activates', async () => {
    const { requestId } = await startFor([
      'vendor/alpha',
      'vendor/cheap',
      'vendor/third',
      'vendor/fourth',
    ]);
    const now = Date.now();
    sqlite
      .prepare(`UPDATE paid_benchmark_requests SET last_staged_at = ?, updated_at = ? WHERE id = ?`)
      .run(
        new Date(now - 61 * MINUTE_MS).toISOString(),
        new Date(now - 61 * MINUTE_MS).toISOString(),
        requestId
      );
    const abandoned = await reconcilePaidBenchmarkRequests(paidBindings(db), { now });
    expect(abandoned.closed).toEqual([requestId]);
    expect(liveRequestCount()).toBe(0);

    // The "Get a fresh estimate" retry: a new quote and click on the same router and owner.
    // A failed row is outside the live-per-router unique index, so this creates a fresh
    // request instead of colliding with the abandoned one.
    const retried = await startFor(['vendor/alpha', 'vendor/cheap', 'vendor/third']);
    expect(retried.requestId).not.toBe(requestId);
    expect(requestState(retried.requestId).status).toBe('preparing');
    expect(requestState(requestId).status).toBe('failed');

    // Cron-only continuation reaches active with no browser polling.
    let passes = 0;
    while (requestState(retried.requestId).status === 'preparing' && passes < 5) {
      passes += 1;
      await reconcilePaidBenchmarkRequests(paidBindings(db), { now: now + passes * MINUTE_MS });
    }
    expect(requestState(retried.requestId).status).toBe('active');
    // The abandoned request stays failed and was never relaunched.
    expect(requestState(requestId).status).toBe('failed');
  });

  it('stays live across every tick the widest plan needs, and never expires midway', async () => {
    // The widest observed pool: 68 concrete pairs, every slot unmeasured, which is the plan
    // the staging budget was sized from. Inserted directly so the case list is exactly the
    // measured one and the request is the widest possible.
    const plan: PaidBenchmarkPlan = {
      version: 1,
      router: 'efficient',
      engineIdentity: ENGINE,
      revision: ACTIVE_MEASUREMENT_REVISION,
      repetitions: REPS,
      caseIds: CASES.map(benchCase => benchCase.id),
      pairs: Array.from({ length: 68 }, (_, index) => ({
        model: `vendor/wide-${index}`,
        variant: '',
        serving: false,
        missing: btoa(String.fromCharCode(...new Uint8Array(Math.ceil(SLOTS / 8)).fill(0xff))),
        covered: btoa(String.fromCharCode(...new Uint8Array(Math.ceil(SLOTS / 8)))),
        cost: CASES.map(() => 1),
      })),
      counts: { reused: 0, covered: 0, shared: 0, exclusive: SLOTS * 68 },
      estimateMicrodollars: SLOTS * 68,
      maximumMicrodollars: SLOTS * 68,
      aliases: [],
      projectId: benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID }),
    };
    const requestId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const at = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_quotes
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
            plan_cases, expires_at, started_request_id, created_at, updated_at)
        VALUES (?, 'user', 'user-1', NULL, 'efficient', ?, 'pool-v1', ?, '{}', ?, 0, 0, ?,
          '2027-01-01T00:00:00.000Z', ?, ?, ?)`
      )
      .run(quoteId, ROUTER_ID, ENGINE, JSON.stringify(plan), SLOTS * 68, requestId, at, at);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
            charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
            context, created_at, updated_at)
        VALUES (?, 'user', 'user-1', NULL, 'efficient', ?, 'pool-v1', ?, 'preparing', ?, 0, 0, 0,
          ?, 0, NULL, 'user-1', '{}', ?, ?)`
      )
      .run(requestId, ROUTER_ID, ENGINE, quoteId, SLOTS * 68, at, at);

    const ticks = Math.ceil((SLOTS * 68) / 4_400) + 5;
    let stagedBefore = 0;
    let lastStamp = '';
    let passes = 0;
    for (let tick = 1; tick <= ticks; tick += 1) {
      if (requestState(requestId).status !== 'preparing') break;
      passes += 1;
      const now = Date.now() + tick * MINUTE_MS;
      const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), { now });
      // Every tick that stages keeps the pool's only live-request slot: it is never closed for
      // age, never abandoned between passes, and its stamp advances with real progress.
      expect(summary.closed).toEqual([]);
      const state = requestState(requestId);
      expect(['preparing', 'active']).toContain(state.status);
      expect(state.staged_cases).toBeGreaterThan(stagedBefore);
      expect(state.last_staged_at).not.toBeNull();
      expect(Date.parse(state.last_staged_at ?? '')).toBe(now);
      expect(state.last_staged_at).not.toBe(lastStamp);
      stagedBefore = state.staged_cases;
      lastStamp = state.last_staged_at ?? '';
    }
    // It finished on its own, inside the window, without a single browser poll: the final
    // staging pass both completed the plan and activated the request.
    const final = requestState(requestId);
    expect(final.status).toBe('active');
    expect(final.staged_cases).toBe(SLOTS * 68);
    expect(liveRequestCount()).toBe(1);
    expect(passes).toBeGreaterThan(20);
  }, 120_000);

  /** One single-pair efficient plan (the widest shape a pool can hold for one pair). */
  function singlePairPlan(): PaidBenchmarkPlan {
    return {
      version: 1,
      router: 'efficient',
      engineIdentity: ENGINE,
      revision: ACTIVE_MEASUREMENT_REVISION,
      repetitions: REPS,
      caseIds: CASES.map(benchCase => benchCase.id),
      pairs: [
        {
          model: 'vendor/shared',
          variant: '',
          serving: false,
          missing: btoa(String.fromCharCode(...new Uint8Array(Math.ceil(SLOTS / 8)).fill(0xff))),
          covered: btoa(String.fromCharCode(...new Uint8Array(Math.ceil(SLOTS / 8)))),
          cost: CASES.map(() => 1),
        },
      ],
      counts: { reused: 0, covered: 0, shared: 0, exclusive: SLOTS },
      estimateMicrodollars: SLOTS,
      maximumMicrodollars: SLOTS,
      aliases: [],
      projectId: 'bench-pool-project',
    };
  }

  /**
   * `count` preparing requests, each its own pool. `stamp(index)` sets that request's creation
   * and last-staged instants, which is what the stalest-first scan orders on.
   */
  function seedPreparingRequests(
    count: number,
    stamp: (index: number) => { createdAt: string; lastStagedAt: string | null } = () => ({
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastStagedAt: null,
    })
  ): string[] {
    const plan = singlePairPlan();
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const requestId = crypto.randomUUID();
      const quoteId = crypto.randomUUID();
      const { createdAt, lastStagedAt } = stamp(index);
      ids.push(requestId);
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_quotes
            (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
              engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
              plan_cases, expires_at, started_request_id, created_at, updated_at)
          VALUES (?, 'user', ?, NULL, 'efficient', ?, 'pool-v1', ?, '{}', ?, 0, 0, ?,
            '2027-01-01T00:00:00.000Z', ?, ?, ?)`
        )
        .run(
          quoteId,
          `user-${index}`,
          crypto.randomUUID(),
          ENGINE,
          JSON.stringify(plan),
          SLOTS,
          requestId,
          createdAt,
          createdAt
        );
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_requests
            (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
              engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
              charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
              context, created_at, updated_at, last_staged_at)
          VALUES (?, 'user', ?, NULL, 'efficient', ?, 'pool-v1', ?, 'preparing', ?, 0, 0, 0,
            ?, 0, NULL, ?, '{}', ?, ?, ?)`
        )
        .run(
          requestId,
          `user-${index}`,
          crypto.randomUUID(),
          ENGINE,
          quoteId,
          SLOTS,
          `user-${index}`,
          createdAt,
          createdAt,
          lastStagedAt
        );
    }
    return ids;
  }

  it.each([1, 25, 100])(
    'keeps the tick under budget and every waiting request alive with %i preparing requests',
    async concurrent => {
      const ids = seedPreparingRequests(concurrent);

      // The scan's own order decides who is served: exactly the stalest `min(N, 50)` requests.
      const scanOrder = (
        sqlite
          .prepare(
            `SELECT id FROM paid_benchmark_requests WHERE status = 'preparing'
            ORDER BY COALESCE(last_staged_at, created_at), id`
          )
          .all() as Array<{ id: string }>
      ).map(row => row.id);
      const servedFirstTick = new Set(scanOrder.slice(0, 50));

      /** Progress of one tick: total staged, and which ids advanced. */
      const tick = async (index: number) => {
        const before = new Map(ids.map(id => [id, requestState(id).staged_cases]));
        const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), {
          now: Date.now() + index * MINUTE_MS,
        });
        const advanced = ids.filter(id => requestState(id).staged_cases > (before.get(id) ?? 0));
        const total = advanced.reduce(
          (sum, id) => sum + requestState(id).staged_cases - (before.get(id) ?? 0),
          0
        );
        return { summary, advanced, total };
      };

      const first = await tick(1);
      // The budget is spent (>= 90% of whatever the served plans can absorb) and never
      // exceeded, and only the stalest 50 are served.
      const absorbable = Math.min(4_400, Math.min(concurrent, 50) * SLOTS);
      expect(first.total).toBeLessThanOrEqual(4_400);
      expect(first.total).toBeGreaterThanOrEqual(absorbable * 0.9);
      expect(new Set(first.advanced)).toEqual(servedFirstTick);
      expect(first.summary.closed).toEqual([]);

      // The next tick serves the rest: every request is served within two consecutive ticks.
      const second = await tick(2);
      expect(second.total).toBeLessThanOrEqual(4_400);
      expect(second.summary.closed).toEqual([]);
      for (const id of ids) expect(requestState(id).staged_cases).toBeGreaterThan(0);
      for (const id of ids) expect(['preparing', 'active']).toContain(requestState(id).status);
    },
    180_000
  );
  it('never closes a request that rotation skipped, and closes one that had budget and stalled', async () => {
    // Ordering is stalest-first, so a request the cap skips is one whose stamp is no older than
    // the served ones: the cap trims a queue of stale requests, and the trimmed tail must stay
    // alive rather than be failed for a tick it was never offered.
    const stale = 61 * MINUTE_MS;
    // Seeded through the shared fixture; the assertions read the rows back by scan order.
    seedPreparingRequests(60, () => ({
      createdAt: new Date(Date.now() - 130 * MINUTE_MS).toISOString(),
      lastStagedAt: new Date(Date.now() - stale).toISOString(),
    }));
    const scanOrder = (
      sqlite
        .prepare(
          `SELECT id FROM paid_benchmark_requests WHERE status = 'preparing'
          ORDER BY COALESCE(last_staged_at, created_at), id`
        )
        .all() as Array<{ id: string }>
    ).map(row => row.id);
    const skipped = scanOrder.slice(50);

    const first = await reconcilePaidBenchmarkRequests(paidBindings(db), { now: Date.now() });
    // The fifty this tick could offer budget to were stale and stalled: closed, correctly.
    expect(first.closed).toHaveLength(50);
    // The ten beyond the cap were never offered budget: all still live, none closed.
    expect(first.closed.filter(id => skipped.includes(id))).toEqual([]);
    for (const id of skipped) expect(requestState(id).status).toBe('preparing');

    // The next tick reaches them: still stale, so they are offered budget and closed then.
    const second = await reconcilePaidBenchmarkRequests(paidBindings(db), {
      now: Date.now() + MINUTE_MS,
    });
    expect(new Set(second.closed)).toEqual(new Set(skipped));
  }, 120_000);

  it('serves a request the cap skipped on the next tick, and it stages normally', async () => {
    // Fifty stale requests plus one fresh: tick one closes the stale fifty and cannot reach the
    // fresh one; tick two serves it, and it stages.
    const ids = seedPreparingRequests(51, index =>
      index === 50
        ? {
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            lastStagedAt: null,
          }
        : {
            createdAt: new Date(Date.now() - 130 * MINUTE_MS).toISOString(),
            lastStagedAt: new Date(Date.now() - 61 * MINUTE_MS).toISOString(),
          }
    );
    const skipped = ids[50]!;

    const first = await reconcilePaidBenchmarkRequests(paidBindings(db), { now: Date.now() });
    expect(first.closed).toHaveLength(50);
    expect(first.closed).not.toContain(skipped);
    expect(requestState(skipped).status).toBe('preparing');
    expect(requestState(skipped).staged_cases).toBe(0);

    const second = await reconcilePaidBenchmarkRequests(paidBindings(db), {
      now: Date.now() + MINUTE_MS,
    });
    expect(second.closed).toEqual([]);
    // It was served this tick: it staged real slots (and, with a plan this small, the same pass
    // both finished staging and activated it).
    expect(requestState(skipped).staged_cases).toBeGreaterThan(0);
    expect(['preparing', 'active']).toContain(requestState(skipped).status);
  }, 120_000);

  /**
   * A request with every slot really staged and its status still `preparing`: the state a
   * failed activation write leaves behind (rows written, activation not committed).
   */
  async function fullyStagedButUnactivated(requestId: string): Promise<void> {
    const request = sqlite
      .prepare('SELECT * FROM paid_benchmark_requests WHERE id = ?')
      .get(requestId) as never;
    const staged = await stagePaidBenchmarkRequest(
      paidBindings(db) as never,
      request,
      singlePairPlan(),
      { budgetSlots: Number.MAX_SAFE_INTEGER }
    );
    expect(staged.status).toBe('staged');
    expect(requestState(requestId)).toMatchObject({ status: 'preparing' });
    expect(requestState(requestId).staged_cases).toBe(requestState(requestId).plan_cases);
  }

  it('keeps a fully staged request for its own activation window, not the staging window', async () => {
    const [requestId] = seedPreparingRequests(1);
    await fullyStagedButUnactivated(requestId!);
    sqlite
      .prepare('UPDATE paid_benchmark_requests SET last_staged_at = ?, updated_at = ? WHERE id = ?')
      .run(
        new Date(Date.now() - 61 * MINUTE_MS).toISOString(),
        new Date(Date.now() - 61 * MINUTE_MS).toISOString(),
        requestId!
      );
    // 61 minutes: past the staging window, inside the activation window. It must not close and
    // must activate, in this pass, with no browser call.
    const first = await reconcilePaidBenchmarkRequests(paidBindings(db), { now: Date.now() });
    expect(first.closed).toEqual([]);
    expect(requestState(requestId!).status).toBe('active');

    // The same state past the activation window closes with its own, clear reason.
    const [secondId] = seedPreparingRequests(1);
    await fullyStagedButUnactivated(secondId!);
    sqlite
      .prepare('UPDATE paid_benchmark_requests SET last_staged_at = ?, updated_at = ? WHERE id = ?')
      .run(
        new Date(Date.now() - 3 * 60 * MINUTE_MS).toISOString(),
        new Date(Date.now() - 3 * 60 * MINUTE_MS).toISOString(),
        secondId!
      );
    const closed = await reconcilePaidBenchmarkRequests(paidBindings(db), { now: Date.now() });
    expect(closed.closed).toEqual([secondId]);
    const row = sqlite
      .prepare('SELECT failure_reason, failure_retryable FROM paid_benchmark_requests WHERE id = ?')
      .get(secondId!) as { failure_reason: string; failure_retryable: number };
    expect(row.failure_reason).toBe('The benchmark was ready but was not activated in time.');
    expect(row.failure_retryable).toBe(1);
  }, 120_000);

  it('closes a stalled request and still stages the healthy requests behind it', async () => {
    // Fifty stalled requests sort first (stalest) and would otherwise take the whole budget
    // before the healthy request behind them is reached.
    const stale = 61 * MINUTE_MS;
    const ids = seedPreparingRequests(51, index =>
      index < 50
        ? {
            createdAt: new Date(Date.now() - 130 * MINUTE_MS).toISOString(),
            lastStagedAt: new Date(Date.now() - stale).toISOString(),
          }
        : {
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            lastStagedAt: null,
          }
    );
    const healthy = ids[50]!;

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), { now: Date.now() });
    // Every stalled request is closed…
    expect(summary.closed).toHaveLength(50);
    expect(summary.closed).not.toContain(healthy);
    expect(requestState(healthy).status).toBe('preparing');
    expect(requestState(healthy).staged_cases).toBe(0);
    // The invariant behind the order: the grants never exceed the budget and every staging
    // request is granted exactly its share. (Under either order the grants are identical —
    // `offered` is computed over exactly the rows that can reach the call — so this asserts the
    // property, not a difference the reorder creates.)
    const staging = 51;
    expect(Math.floor(4_400 / staging) * staging).toBeLessThanOrEqual(4_400);

    // …and the closing did not consume the budget: the healthy request is served next (the
    // scan bound is 50, so it enters the scan once the stalled rows are gone) and stages with
    // the whole budget available.
    const next = await reconcilePaidBenchmarkRequests(paidBindings(db), {
      now: Date.now() + MINUTE_MS,
    });
    expect(next.closed).toEqual([]);
    expect(requestState(healthy).staged_cases).toBeGreaterThan(0);
  }, 120_000);

  it("does not let a fully staged request dilute a staging request's share", async () => {
    // One wide plan that needs slots, plus nine fully staged requests waiting to activate.
    const ids = seedPreparingRequests(9);
    for (const id of ids) {
      const request = sqlite
        .prepare('SELECT * FROM paid_benchmark_requests WHERE id = ?')
        .get(id) as never;
      const staged = await stagePaidBenchmarkRequest(
        paidBindings(db) as never,
        request,
        singlePairPlan(),
        { budgetSlots: Number.MAX_SAFE_INTEGER }
      );
      expect(staged.status).toBe('staged');
    }
    const [wide] = seedPreparingRequests(1);

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db), { now: Date.now() });
    expect(summary.closed).toEqual([]);
    // Every fully staged request activated…
    for (const id of ids) expect(requestState(id).status).toBe('active');
    // …and the wide plan staged its whole plan in this one tick: the share was the full budget,
    // not a tenth of it (which is what a divisor counting the nine would have given).
    expect(requestState(wide!).staged_cases).toBeGreaterThan(SLOTS * 0.9);
  }, 120_000);

  it('survives one unreadable plan and still drains the billing outbox', async () => {
    // Two staging requests; the second's stored plan is not valid JSON.
    const ids = seedPreparingRequests(2);
    sqlite
      .prepare(
        'UPDATE paid_benchmark_quotes SET plan = ? WHERE id = (SELECT quote_id FROM paid_benchmark_requests WHERE id = ?)'
      )
      .run('{not json', ids[1]!);
    // A delivered-after-completion intent proves the drain still runs at the end of the pass.
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_billing_outbox (id, kind, request_id, owner_type, owner_id,
          amount_microdollars, attempts, available_at, created_at, updated_at, status)
        VALUES (?, 'pins', ?, 'user', 'user-0', 0, 0, ?, ?, ?, 'pending')`
      )
      .run(
        crypto.randomUUID(),
        ids[0]!,
        Date.now(),
        new Date().toISOString(),
        new Date().toISOString()
      );

    const summary = await reconcilePaidBenchmarkRequests(paidBindings(db));
    // The good request staged; the unreadable one is left alone (not failed, not charged), and
    // the pass completed instead of aborting.
    expect(requestState(ids[0]!).staged_cases).toBeGreaterThan(0);
    expect(requestState(ids[1]!).status).toBe('preparing');
    expect(summary.closed).toEqual([]);
    expect(billing).toHaveLength(0);
    expect(
      countRows(
        "SELECT COUNT(*) AS count FROM paid_benchmark_billing_outbox WHERE status = 'pending'"
      )
    ).toBe(1);
  }, 120_000);

  it('answers a second start with the live request on its own plan, not the second quote', async () => {
    // The live request's plan is wider than the second start's: three pairs versus one.
    const { requestId } = await startFor(['vendor/alpha', 'vendor/cheap', 'vendor/third']);
    expect(requestState(requestId).status).toBe('preparing');
    expect(liveRequestCount()).toBe(1);
    const stagedBefore = requestState(requestId).staged_cases;

    // A second quote for a DIFFERENT (narrower) pool on the same router, then a click. The
    // quote is read-only, so it succeeds; the click cannot create a request because the pool
    // already holds its one live slot.
    const quoted = await quoteFor(poolContext(['vendor/cheap']));
    if (quoted.status !== 'ready') throw new Error('quote not ready');
    const response = await post(startRequest(quoted.id));
    expect(response.status).toBe(200);
    const second = await startResult(response);
    // The old web release validates this body too, so the answer keeps the `started` shape and
    // marks the join with a field it ignores.
    expect(second.status).toBe('started');
    if (second.status !== 'started') return;
    expect(second.alreadyInProgress).toBe(true);
    // The caller is handed the request that is already live, with its real progress.
    const progress = second.request;
    if (progress.status === 'empty') throw new Error('already-in-progress request was empty');
    expect(progress.status).toBe('preparing');
    expect(progress.id).toBe(requestId);
    // It kept staging against its OWN frozen three-pair plan: the narrower second quote never
    // re-scoped it, and the live row's plan count is unchanged.
    const live = requestState(requestId);
    expect(live.plan_cases).toBe(3 * SLOTS);
    expect(live.staged_cases).toBeGreaterThan(stagedBefore);
    // Nothing new was created, and the second quote was not consumed.
    expect(countRows('SELECT COUNT(*) AS count FROM paid_benchmark_requests')).toBe(1);
    expect(
      sqlite
        .prepare('SELECT started_request_id FROM paid_benchmark_quotes WHERE id = ?')
        .get(quoted.id)
    ).toEqual({ started_request_id: null });
    // The live request still reaches `active` on its own plan through cron passes only.
    let passes = 0;
    while (requestState(requestId).status === 'preparing' && passes < 5) {
      passes += 1;
      await reconcilePaidBenchmarkRequests(paidBindings(db), {
        now: Date.now() + passes * MINUTE_MS,
      });
    }
    expect(requestState(requestId)).toMatchObject({
      status: 'active',
      staged_cases: 3 * SLOTS,
      plan_cases: 3 * SLOTS,
    });
  });
});
