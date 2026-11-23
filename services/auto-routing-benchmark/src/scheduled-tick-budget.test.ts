import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaidBenchmarkPlan } from './paid-benchmark-plan';
import { computeEngineIdentity } from './run';
import worker from './index';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { seedBenchmarkConfig } from '../test/paid-benchmark-d1';

/**
 * The one-minute tick's D1 budget.
 *
 * D1 allows 1,000 queries per Worker invocation, and a `db.batch()` counts as one of them
 * (its statements are not counted individually; the "Batch limits" section of
 * https://developers.cloudflare.com/d1/platform/limits is explicit that the per-query limits
 * apply to each statement inside a batch, while the queries-per-invocation limit counts the
 * batch once). This suite drives the real `scheduled()` handler over the production migrations
 * with a counting binding, at the realistic worst case for every part of the tick, and reports
 * the per-component split so the paid-staging budget is sized against a measured total.
 */

const NOW = Date.parse('2026-11-23T07:00:00.000Z');
const ENGINE = computeEngineIdentity('decider', 'efficient');
const CASE_COUNT = 597;
const REPETITIONS = 3;
const AT = new Date(NOW).toISOString();

type QueryCounts = {
  /** What D1 counts against the 1,000-per-invocation limit: one per call, batch included. */
  queries: number;
  /** The stricter reading: a batch's statements counted one by one, for reference. */
  statements: number;
};

/**
 * A D1 binding that counts what the platform charges against the 1,000-queries-per-invocation
 * limit.
 *
 * `sqliteD1`'s round-trip hook fires exactly once per `run`/`all`/`first`/`raw`/`batch` call,
 * which is D1's own rule — a `batch()` is one query however many statements it carries — so
 * the hook supplies `queries`. The `batch` wrapper adds the statements a batch carries to
 * `statements`, the stricter reading, without touching `prepare` (whose statements must stay
 * attachable to this binding's batches).
 */
function countingDb(sqlite: DatabaseSync, counts: QueryCounts): D1Database {
  const db = sqliteD1(sqlite, () => {
    counts.queries += 1;
    counts.statements += 1;
  });
  return {
    prepare: db.prepare,
    exec: db.exec,
    async batch(statements: D1PreparedStatement[]) {
      counts.statements += Math.max(0, statements.length - 1);
      return db.batch(statements);
    },
  } as D1Database;
}

const CATALOG = { data: [{ id: 'vendor/one', pricing: { prompt: 1e-6, completion: 2e-6 } }] };

/**
 * The widest observed real pool (68 concrete pairs), every slot unmeasured. `platformCovered`
 * marks every slot as Kilo-paid instead, which is the fixture that exercises the covered
 * branch's platform-membership revalidation.
 */
function widestPlan(
  router: 'efficient' | 'frontier' = 'efficient',
  repetitions = REPETITIONS,
  caseCount = CASE_COUNT,
  platformCovered = false
): PaidBenchmarkPlan {
  const caseIds = Array.from({ length: caseCount }, (_, index) => `case-${index}`);
  const perPair = caseIds.length * repetitions;
  const bytes = Math.ceil(perPair / 8);
  const filled = btoa(String.fromCharCode(...new Uint8Array(bytes).fill(0xff)));
  const empty = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const slots = perPair * 68;
  return {
    version: 1,
    router,
    engineIdentity: computeEngineIdentity('decider', router),
    revision: 3,
    repetitions,
    caseIds,
    pairs: Array.from({ length: 68 }, (_, index) => ({
      model: `vendor/pair-${index}`,
      variant: '',
      serving: false,
      missing: filled,
      covered: platformCovered ? filled : empty,
      cost: caseIds.map(() => 1),
    })),
    counts: platformCovered
      ? { reused: 0, covered: slots, shared: 0, exclusive: 0 }
      : { reused: 0, covered: 0, shared: 0, exclusive: slots },
    estimateMicrodollars: slots,
    maximumMicrodollars: slots,
    aliases: [],
    projectId: 'bench-pool-project',
  };
}

/**
 * One `preparing` request per router shape, plus an `active` one to reconcile. `platformCovered`
 * makes every slot Kilo-paid, so the tick runs the covered branch over a full slice.
 */
function seedPaidRequests(sqlite: DatabaseSync, platformCovered = false): void {
  const insert = (status: 'preparing' | 'active', plan: PaidBenchmarkPlan) => {
    const requestId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const engine = plan.engineIdentity;
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_quotes
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
            plan_cases, expires_at, started_request_id, created_at, updated_at)
        VALUES (?, 'user', 'user-1', NULL, ?, ?, 'pool-v1', ?, '{}', ?, 0, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        quoteId,
        plan.router,
        crypto.randomUUID(),
        engine,
        JSON.stringify(plan),
        plan.counts.exclusive,
        new Date(NOW + 30 * 60_000).toISOString(),
        requestId,
        AT,
        AT
      );
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
            charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
            context, created_at, updated_at)
        VALUES (?, 'user', 'user-1', NULL, ?, ?, 'pool-v1', ?, ?, ?, 0, 0, 0, ?, 0, NULL,
          'user-1', '{}', ?, ?)`
      )
      .run(
        requestId,
        plan.router,
        crypto.randomUUID(),
        engine,
        status,
        quoteId,
        plan.counts.exclusive,
        AT,
        AT
      );
    return requestId;
  };
  // Both router shapes: an 88-slot efficient slice names about 30 distinct cases over 3
  // repetitions, and an 88-slot frontier slice names 88 cases over 1. Both must stay inside
  // D1's 100-bound-parameter limit, which the harness now enforces.
  insert('preparing', widestPlan('efficient', REPETITIONS, CASE_COUNT, platformCovered));
  insert('preparing', widestPlan('frontier', 1, 294, platformCovered));
  insert('active', widestPlan('efficient'));
}

/** A full claim pass: three running decider runs per router, so the drain may still start one. */
function seedRunningRuns(sqlite: DatabaseSync): void {
  for (const router of ['efficient', 'frontier'] as const) {
    for (let index = 0; index < 3; index += 1) {
      const runId = `${router}-run-${index}`;
      sqlite
        .prepare(
          `INSERT INTO benchmark_runs
            (id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
              max_concurrency, repetitions, engine_identity, benchmark_user_id,
              benchmark_org_id, admission_marker)
          VALUES (?, ?, 'decider', 'platform', 'running', ?, 0.7, 1, 0, 3, ?, 'bench-user',
            'bench-org', ?)`
        )
        .run(runId, router, AT, ENGINE, crypto.randomUUID());
      sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(runId);
      sqlite
        .prepare('INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, 1, 1)')
        .run(runId, `vendor/${router}-${index}`);
      sqlite
        .prepare(
          `INSERT INTO scheduler_chunks
            (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
          VALUES (?, ?, ?, '', '[]', 0, 0, ?, 'pending')`
        )
        .run(
          `${runId}-chunk`,
          runId,
          `vendor/${router}-${index}`,
          JSON.stringify([`case-${index}`])
        );
    }
  }
}

/** Ten pending outputs per router, the most one tick re-queues for recovery. */
function seedPendingOutputs(sqlite: DatabaseSync): void {
  for (const router of ['efficient', 'frontier'] as const)
    for (let index = 0; index < 10; index += 1)
      sqlite
        .prepare(
          `INSERT INTO pending_decider_outputs
            (run_id, model, variant, case_id, rep, payload, grading_lease_until)
          VALUES (?, ?, '', ?, 0, '{}', 0)`
        )
        .run(`${router}-run-0`, `vendor/${router}-0`, `case-${index}`);
}

/** Today's alias sync mid-run: both routers owe two full owner pages per tick. */
function seedAliasSync(sqlite: DatabaseSync): void {
  for (const router of ['efficient', 'frontier'] as const) {
    for (let index = 0; index < 100; index += 1)
      sqlite
        .prepare(
          `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot,
            updated_at)
          VALUES (?, 'user', ?, ?, ?, ?)`
        )
        .run(
          router,
          `${router}-owner-${index.toString().padStart(3, '0')}`,
          crypto.randomUUID(),
          JSON.stringify({ entries: [{ model: 'vendor/one', pairs: [] }], previousEntries: [] }),
          AT
        );
    sqlite
      .prepare(
        `INSERT INTO benchmark_daily_alias_sync
          (router, day, attempts, platform_status, owner_pages, owner_done, updated_at)
        VALUES (?, '2026-11-23', 0, 'pending', 0, 0, ?)`
      )
      .run(router, AT);
  }
}

describe('scheduled tick D1 budget (production migrations, real handler)', () => {
  const opened: Array<{ directory: string; sqlite: DatabaseSync }> = [];
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    send = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.endsWith('/api/openrouter/models'))
        return new Response(JSON.stringify(CATALOG), { status: 200 });
      if (url.pathname.endsWith('/api/internal/bot-token'))
        return new Response(JSON.stringify({ token: 'bot-token', expiresAt: AT }), { status: 200 });
      if (url.pathname.includes('/models'))
        return new Response(JSON.stringify(CATALOG), { status: 200 });
      return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
    });
  });

  afterEach(() => {
    for (const { sqlite, directory } of opened.splice(0)) {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function newTickDb(): DatabaseSync {
    const directory = mkdtempSync(join(tmpdir(), 'benchmark-tick-budget-'));
    const sqlite = new DatabaseSync(join(directory, 'tick.sqlite'));
    applyBenchmarkMigrations(sqlite);
    // A real deployment runs an internal bot user; the fixture's placeholder default is
    // refused by the identity resolver, which would stop the drain and alias sync early.
    seedBenchmarkConfig(sqlite, 'efficient', 'bot-internal-1');
    seedBenchmarkConfig(sqlite, 'frontier', 'bot-internal-1');
    sqlite
      .prepare('INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)')
      .run('2026-01-01T00:00:00.000Z');
    opened.push({ directory, sqlite });
    return sqlite;
  }

  /** One real one-minute tick over `sqlite`, returning what it cost D1. */
  async function runTick(sqlite: DatabaseSync): Promise<QueryCounts> {
    const counts = { queries: 0, statements: 0 };
    const env = {
      BENCH_DB: countingDb(sqlite, counts),
      BENCH_QUEUE: { send },
      KILO_WEB_API_BASE_URL: 'https://web.test',
      KILO_CLI_API_URL: 'https://cli.test',
      BENCH_RESULT_URL: 'https://bench.test/container/case-result',
      BENCHMARK_SCHEDULER_CONFIG: '{}',
      INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
      BOT_TOKEN_MINT_SECRET: { get: async () => 'bot-secret' },
    } as unknown as Env;
    await worker.scheduled({ cron: '* * * * *' } as ScheduledController, env);
    return { ...counts };
  }

  it('keeps a worst-case one-minute tick inside the 1,000-query limit, with the split', async () => {
    // Everything the tick does except paid staging: full claim pass over six running runs,
    // twenty pending outputs to re-queue, two full owner pages per router for today's sync.
    const otherSqlite = newTickDb();
    seedRunningRuns(otherSqlite);
    seedPendingOutputs(otherSqlite);
    seedAliasSync(otherSqlite);
    const other = await runTick(otherSqlite);
    expect(send.mock.calls.length).toBeGreaterThan(0);

    // The same tick with the widest paid plan staging its next slice, plus an active request.
    const worstSqlite = newTickDb();
    seedRunningRuns(worstSqlite);
    seedPendingOutputs(worstSqlite);
    seedAliasSync(worstSqlite);
    seedPaidRequests(worstSqlite);
    const worst = await runTick(worstSqlite);

    // The covered shape: every slot promised Kilo-paid with no latched platform run, which is
    // the branch that revalidates the pair's platform membership while staging.
    const coveredSqlite = newTickDb();
    seedRunningRuns(coveredSqlite);
    seedPendingOutputs(coveredSqlite);
    seedAliasSync(coveredSqlite);
    seedPaidRequests(coveredSqlite, true);
    const covered = await runTick(coveredSqlite);

    const components = {
      other: other.queries,
      staging: worst.queries - other.queries,
      worst: worst.queries,
      worstStatements: worst.statements,
      coveredWorst: covered.queries,
    };
    console.error(JSON.stringify(components));

    // Both router shapes staged for real: a frontier slice (1 repetition, 294 cases) binds just
    // as many parameters as an efficient one, so a silent binding failure on either would show
    // up here as a zero count.
    for (const router of ['efficient', 'frontier']) {
      const row = worstSqlite
        .prepare(
          `SELECT COALESCE(SUM(staged_cases), 0) AS staged FROM paid_benchmark_requests
          WHERE status = 'preparing' AND router = ?`
        )
        .get(router) as { staged: number } | undefined;
      expect(Number(row?.staged ?? 0)).toBeGreaterThan(0);
    }

    // Staging carries the 4,400-slot budget in 50 batches of 88, each with three slice reads
    // and a recount; both router shapes (efficient, 3 repetitions; frontier, 1) are preparing.
    expect(components.staging).toBeLessThanOrEqual(420);
    // The covered branch reads the pair's platform membership once per slice, not per slot: a
    // per-slot read would add thousands of queries on this fixture.
    expect(components.coveredWorst).toBeLessThanOrEqual(700);
    // The whole tick keeps a wide margin under D1's hard limit of 1,000 queries per
    // invocation: about a third stays free for anything a future addition needs.
    expect(components.worst).toBeLessThanOrEqual(700);
    expect(components.worst).toBeLessThan(1_000);
  }, 60_000);
});
