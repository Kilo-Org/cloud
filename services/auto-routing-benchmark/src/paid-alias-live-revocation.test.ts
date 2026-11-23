import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_CASE_INFERENCE_PATH,
  BENCHMARK_MODEL_REQUEST_ID_HEADER,
  benchmarkProjectId,
  type BenchmarkCaseInvocation,
} from '@kilocode/auto-routing-contracts';
import { openPaidDatabase } from '../test/paid-benchmark-d1';
import { BENCHMARK_CASE_HEADER, issueCaseInferenceCapability } from './case-inference-capability';
import {
  createCaseInferenceDeps,
  handleCaseInference,
  type CaseInferenceBindings,
} from './case-inference';
import { assembleCustomRouterTable, lookupCustomRouterStatuses } from './custom-routers';
import { buildPaidBenchmarkPlan } from './paid-benchmark-plan';
import { readPaidCaseRun } from './paid-case-store';
import { computeEngineIdentity } from './run';
import { deciderCasesForRouter } from './measurement-revision';

/**
 * R41/R42, active path: a paid case is in flight against the concrete alias target its quote
 * froze, the owner then points `*-latest` somewhere else, and a runner asks to infer the *new*
 * target under the *old* capability. That request must be refused before any permit or provider
 * call, the in-flight old-target generation must keep its accounting, and nothing may start a new
 * paid request from the move alone.
 *
 * Everything here goes through the real boundary: the frozen plan is built by
 * `buildPaidBenchmarkPlan`, the capability is minted by `issueCaseInferenceCapability`, and the
 * request is handled by `handleCaseInference` with the store's own selection/admit path.
 */

const CONFIG = {
  router: 'efficient',
  accuracyNoiseBand: 0.05,
  classifierModels: ['typesafe/jev-1.13'],
  deciderModels: [{ id: 'vendor/platform' }],
  minAccuracy: 0.7,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  updatedAt: null,
  updatedBy: null,
} as unknown as Parameters<typeof buildPaidBenchmarkPlan>[1]['config'];

const ENGINE = computeEngineIdentity('decider', 'efficient');
const ALIAS = '~vendor/latest';
const OLD_TARGET = 'vendor/old-target';
const NEW_TARGET = 'vendor/new-target';
const CASE_ID = 'impl-feat-ternary-parity';
const SECRET = 'synthetic-case-capability-secret';
const GATEWAY = 'https://gateway.test';
const ROUTER_ID = '11111111-1111-4111-8111-111111111111';
const POOL_REQUEST = '55555555-5555-4555-8555-555555555555';
const AT = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID });

function catalogAt(target: string): typeof fetch {
  return (async () =>
    Response.json({
      data: [
        { id: ALIAS, alias_target: target },
        { id: OLD_TARGET, pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: NEW_TARGET, pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    })) as unknown as typeof fetch;
}

let sqlite: ReturnType<typeof openPaidDatabase>['sqlite'];
let db: D1Database;
let bindings: CaseInferenceBindings;

function planInput(cases: ReturnType<typeof deciderCasesForRouter>) {
  return {
    context: {
      ownerType: 'user' as const,
      ownerId: 'user-1',
      baseRouter: 'efficient' as const,
      entries: [{ kind: 'gateway' as const, model: ALIAS }],
      clientEvalEntryKeys: [],
    },
    engineIdentity: ENGINE,
    projectId: PROJECT_ID,
    config: CONFIG,
    cases,
  };
}

/** The paid plan frozen for the pool while the alias still resolved to the old target. */
async function frozenPlan(cases: ReturnType<typeof deciderCasesForRouter>) {
  const outcome = await buildPaidBenchmarkPlan(
    { db, env: { KILO_WEB_API_BASE_URL: 'https://app.test' }, fetchImpl: catalogAt(OLD_TARGET) },
    planInput(cases)
  );
  if (outcome.status !== 'ready') throw new Error(`expected a ready plan, got ${outcome.status}`);
  return outcome.plan;
}

/** Everything the paid flow writes for one confirmed request. */
function seedConfirmedRequest(planJson: string) {
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_requests
        (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
          quote_id, estimate_microdollars, maximum_microdollars, charged_microdollars,
          plan_cases, staged_cases, actor_user_id, context, created_at, updated_at, activated_at)
      VALUES (?, 'user', 'user-1', 'efficient', ?, 'pool-v1', ?, 'active', 'quote-1', 20000, 20000,
        0, 6, 6, 'user-1', '{}', ?, ?, ?)`
    )
    .run(POOL_REQUEST, ROUTER_ID, ENGINE, AT, AT, AT);
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_quotes
        (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, context,
          plan, estimate_microdollars, maximum_microdollars, plan_cases, expires_at, created_at,
          updated_at)
      VALUES ('quote-1', 'user', 'user-1', 'efficient', ?, 'pool-v1', ?, '{}', ?, 20000, 20000, 6,
        '2026-01-02T00:00:00.000Z', ?, ?)`
    )
    .run(ROUTER_ID, ENGINE, planJson, AT, AT);
}

beforeEach(() => {
  const opened = openPaidDatabase();
  sqlite = opened.sqlite;
  db = opened.db;
  bindings = {
    BENCH_DB: db,
    KILO_WEB_API_BASE_URL: GATEWAY,
    INTERNAL_API_SECRET_PROD: { get: async () => SECRET },
  } as unknown as CaseInferenceBindings;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paid case target revoked mid-run (active boundary)', () => {
  it('refuses a new-target runner request under the old capability, before any permit', async () => {
    const cases = deciderCasesForRouter('efficient', 3);
    const plan = await frozenPlan(cases);
    // The frozen quote pinned the concrete target the owner authorized.
    expect(plan.aliases).toEqual([{ model: ALIAS, target: OLD_TARGET }]);
    expect(plan.pairs.map(pair => pair.model)).toEqual([OLD_TARGET]);
    seedConfirmedRequest(JSON.stringify(plan));

    // The paid case is admitted and running against the frozen old target, as the paid flow
    // leaves it (the executor's chunk claimed the exact generation).
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs
          (engine_identity, model, variant, rep, case_id, status, generation, executor_run_id,
            executor_token, platform_covered, result_usable, created_at, updated_at, started_at)
        VALUES (?, ?, '', 0, ?, 'running', 1, 'run-1', 'token-1', 0, 0, ?, ?, ?)`
      )
      .run(ENGINE, OLD_TARGET, CASE_ID, AT, AT, AT);
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, status, started_at, engine_identity, repetitions, benchmark_user_id,
            benchmark_org_id, min_accuracy, switch_cost_factor, max_concurrency)
        VALUES ('run-1', 'efficient', 'decider', 'running', ?, ?, 3, 'bench-user', NULL, 0.7, 1,
          80)`
      )
      .run(AT, ENGINE);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases
          (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
            charged_microdollars, reason, updated_at)
        VALUES (?, ?, ?, '', 0, ?, 'running', 0, 0, NULL, ?)`
      )
      .run(POOL_REQUEST, ENGINE, OLD_TARGET, CASE_ID, AT);
    // Its native usage is committed for that concrete target.
    sqlite
      .prepare(
        `INSERT INTO paid_attempt_usage
          (usage_id, model_request_id, request_id, engine_identity, model, variant, rep, case_id,
            generation, owner_type, owner_id, microdollars, platform_covered, created_at)
        VALUES ('usage-old', 'model-request-old', ?, ?, ?, '', 0, ?, 1, 'user', 'user-1', 1234, 0,
          ?)`
      )
      .run(POOL_REQUEST, ENGINE, OLD_TARGET, CASE_ID, AT);

    // The owner now points the alias at a different concrete target.
    const movedPlan = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://app.test' }, fetchImpl: catalogAt(NEW_TARGET) },
      planInput(cases)
    );
    if (movedPlan.status !== 'ready') throw new Error('expected a ready re-quote');
    expect(movedPlan.plan.aliases).toEqual([{ model: ALIAS, target: NEW_TARGET }]);

    // A runner asks to infer the NEW target under the OLD capability (the invocation still
    // names the frozen old target and its generation).
    const invocation: BenchmarkCaseInvocation = {
      engineIdentity: ENGINE,
      runId: 'run-1',
      model: OLD_TARGET,
      variant: '',
      caseId: CASE_ID,
      repetition: 0,
      generation: 1,
      startedAt: Date.now(),
    };
    const issued = await issueCaseInferenceCapability(SECRET, invocation);
    const upstream: string[] = [];
    const deps = await createCaseInferenceDeps(bindings, (async (url: string) => {
      upstream.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    // A body naming the moved target is refused on the signed-model check alone.
    const wrongModel = new Request(
      `https://bench.test${BENCHMARK_CASE_INFERENCE_PATH}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: issued.authorization,
          [BENCHMARK_CASE_HEADER]: issued.invocationHeader,
          [BENCHMARK_MODEL_REQUEST_ID_HEADER]: crypto.randomUUID(),
        },
        body: JSON.stringify({ model: NEW_TARGET, messages: [] }),
      }
    );
    const refused = await handleCaseInference(deps, {
      api: 'chat/completions',
      request: wrongModel,
      db,
    });
    expect(refused.status).toBe(400);
    expect(await refused.clone().json()).toMatchObject({ error: { code: 'model_mismatch' } });
    // Nothing reached the gateway, no permit was written for the new target.
    expect(upstream).toHaveLength(0);
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS n FROM paid_model_requests WHERE model = ?')
          .get(NEW_TARGET) as { n: number }
      ).n
    ).toBe(0);
    expect(
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM benchmark_case_payers WHERE status IN ('eligible','accepted')"
          )
          .get() as { n: number }
      ).n
    ).toBe(0);

    // The in-flight old-target generation is untouched and still attributable.
    const run = await readPaidCaseRun(db, {
      engineIdentity: ENGINE,
      model: OLD_TARGET,
      variant: '',
      rep: 0,
      caseId: CASE_ID,
    });
    expect(run).toMatchObject({ status: 'running', generation: 1, executor_run_id: 'run-1' });
    expect(
      sqlite
        .prepare('SELECT model, microdollars FROM paid_attempt_usage WHERE usage_id = ?')
        .get('usage-old')
    ).toEqual({ model: OLD_TARGET, microdollars: 1234 });

    // The move alone started nothing: still exactly one paid request, the old one.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS n FROM paid_benchmark_requests').get() as { n: number }).n
    ).toBe(1);
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS n FROM paid_benchmark_request_cases WHERE model = ?')
          .get(NEW_TARGET) as { n: number }
      ).n
    ).toBe(0);
  });

  it('refuses an unchanged old-target request when its generation is no longer live', async () => {
    const cases = deciderCasesForRouter('efficient', 3);
    const plan = await frozenPlan(cases);
    seedConfirmedRequest(JSON.stringify(plan));
    // The case run was settled before this request: the generation is over.
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs
          (engine_identity, model, variant, rep, case_id, status, generation, executor_run_id,
            executor_token, platform_covered, result_usable, created_at, updated_at, started_at)
        VALUES (?, ?, '', 0, ?, 'settled', 1, 'run-1', 'token-1', 0, 1, ?, ?, ?)`
      )
      .run(ENGINE, OLD_TARGET, CASE_ID, AT, AT, AT);
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, status, started_at, engine_identity, repetitions, benchmark_user_id,
            benchmark_org_id, min_accuracy, switch_cost_factor, max_concurrency)
        VALUES ('run-1', 'efficient', 'decider', 'running', ?, ?, 3, 'bench-user', NULL, 0.7, 1,
          80)`
      )
      .run(AT, ENGINE);

    const invocation: BenchmarkCaseInvocation = {
      engineIdentity: ENGINE,
      runId: 'run-1',
      model: OLD_TARGET,
      variant: '',
      caseId: CASE_ID,
      repetition: 0,
      generation: 1,
      startedAt: Date.now(),
    };
    const issued = await issueCaseInferenceCapability(SECRET, invocation);
    const upstream: string[] = [];
    const deps = await createCaseInferenceDeps(bindings, (async (url: string) => {
      upstream.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    const request = new Request(
      `https://bench.test${BENCHMARK_CASE_INFERENCE_PATH}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: issued.authorization,
          [BENCHMARK_CASE_HEADER]: issued.invocationHeader,
          [BENCHMARK_MODEL_REQUEST_ID_HEADER]: crypto.randomUUID(),
        },
        body: JSON.stringify({ model: OLD_TARGET, messages: [] }),
      }
    );
    const response = await handleCaseInference(deps, {
      api: 'chat/completions',
      request,
      db,
    });
    // The case is no longer running, so no permit and no provider call.
    expect(response.status).toBe(409);
    expect(await response.clone().json()).toMatchObject({ error: { code: 'case_not_live' } });
    expect(upstream).toHaveLength(0);
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS n FROM paid_model_requests').get() as { n: number }).n
    ).toBe(0);
  });
});

describe('alias moved: routing falls back with a warning', () => {
  it('serves the live alias target with a fallback warning and charges nothing for the move', async () => {
    // A ready measurement exists for the pinned old target (what the paid case bought); the alias
    // now resolves to the new target, which has no measurement at all.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id, requested_at,
            updated_at, completed_at, platform_requested, user_requested)
        VALUES ('efficient', ?, '', ?, 3, 'ready', 'run-old', ?, ?, ?, 0, 1)`
      )
      .run(OLD_TARGET, ENGINE, AT, AT, AT);
    sqlite
      .prepare(
        `INSERT INTO model_summaries
          (run_id, model, variant, route_key, accuracy, avg_cost_usd, avg_latency_ms,
            p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
        VALUES ('run-old', ?, '', 'implementation/code_generation', 0.9, 0.001, 800, 800, 20, 0,
          900, 0)`
      )
      .run(OLD_TARGET);

    const contextWithPin = {
      ownerType: 'user' as const,
      ownerId: 'user-1',
      baseRouter: 'efficient' as const,
      entries: [
        {
          kind: 'gateway' as const,
          model: ALIAS,
          servingPin: { model: OLD_TARGET, pinnedAt: AT },
        },
      ],
      clientEvalEntryKeys: [],
    };
    const source = {
      catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' },
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: ALIAS, alias_target: NEW_TARGET },
            { id: NEW_TARGET, pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as unknown as typeof fetch,
      now: new Date('2026-01-05T00:00:00.000Z'),
    };

    // The pool reports the fallback and asks for a fresh paid benchmark; it is not silently ready.
    const statuses = await lookupCustomRouterStatuses(db, CONFIG as never, contextWithPin, source);
    expect(statuses.entries).toEqual([
      {
        key: `gateway:${ALIAS}`,
        variants: [
          {
            variant: null,
            status: 'missing',
            failureReason: null,
            linked: false,
            servingFallback: true,
            availability: 'alias_rebenchmark_needed',
          },
        ],
      },
    ]);
    // The dead pin is dropped from the served map and routing never pays for the move.
    const table = await assembleCustomRouterTable(db, CONFIG as never, contextWithPin, source);
    expect(table.servingPins?.[`gateway:${ALIAS}`]).toBeUndefined();
    for (const table of ['benchmark_case_runs', 'paid_attempt_usage', 'paid_benchmark_requests'])
      expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(
        0
      );
  });
});
