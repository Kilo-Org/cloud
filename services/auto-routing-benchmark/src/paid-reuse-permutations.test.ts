/**
 * Adversarial reuse permutations for user-paid benchmarks, on the real migrations.
 *
 * Every assertion is made through the production store/run/db functions — the plan builder,
 * the case fence, the reuse copier, the settlement and cancellation statements — so a second
 * implementation of any transition cannot satisfy them. What is measured is always the same
 * two observable facts: how many provider permits (admitted model requests) the system hands
 * out, and the exact set of slots the plan still says are missing.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BenchmarkConfig,
  CustomRouterBenchmarkContext,
} from '@kilocode/auto-routing-contracts';
import { benchmarkProjectId } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { buildPaidBenchmarkPlan, planSlotCount } from './paid-benchmark-plan';
import type { MeasuredCase } from './measurement-revision';
import { ACTIVE_MEASUREMENT_REVISION } from './measurement-revision';
import {
  acceptPaidAttemptUsageStatements,
  admitPaidModelRequestStatements,
  claimPaidCaseStatements,
  enqueuePaidCaseStatements,
  paidCaseClaimOutcome,
  paidCaseEnqueueOutcome,
  paidModelRequestAdmission,
  readPaidCaseRun,
  readPaidModelRequest,
  selectPaidModelRequestPayerStatements,
  type PaidCaseKey,
  type PaidCaseRunRow,
} from './paid-case-store';
import { completePaidCaseStatements } from './db';

const ENGINE = 'engine-reuse';
const MODEL = 'vendor/alpha';
const CASE = 'case-a';
const ROUTER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID });
const ASSIGNMENT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASSIGNMENT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USAGE_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USAGE_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MODEL_REQUEST_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MODEL_REQUEST_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const CONFIG = {
  router: 'efficient',
  deciderModels: [],
  minAccuracy: 0.7,
  accuracyNoiseBand: 0.05,
  classifierRepetitions: 1,
  classifierMaxP95LatencyMs: null,
  switchHorizonTurns: 3,
  switchCostFactor: 1,
  bestAccuracySwitchThreshold: 0,
  lowConfidenceThreshold: 0,
  benchmarkUserId: 'bench-user',
  benchmarkOrgId: 'bench-org',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
  productionTokenProfile: null,
} as unknown as BenchmarkConfig;

function fixtureCase(id: string): MeasuredCase {
  return {
    id,
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: 'Answer with the exact output.',
    userPrompt: 'const n = 1; console.log(n);',
    check: { kind: 'exact', value: '1' },
  } as unknown as MeasuredCase;
}

const CASES = [fixtureCase(CASE)];

function context(): CustomRouterBenchmarkContext {
  return {
    ownerType: 'user',
    ownerId: 'user-1',
    baseRouter: 'efficient',
    entries: [{ kind: 'gateway', model: MODEL }],
    clientEvalEntryKeys: [],
  };
}

function fetchCatalog(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        data: [{ id: MODEL, pricing: { prompt: 1e-6, completion: 2e-6 } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch;
}

type BatchResult = { results: Record<string, unknown>[]; meta: { changes: number } };

function lastRow<T>(results: unknown[]): T | null {
  const last = results[results.length - 1] as BatchResult;
  return (last.results[0] as T | undefined) ?? null;
}

describe('paid reuse permutations (production migrations)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let now: number;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    now = Date.parse('2026-11-20T12:00:00.000Z');
    sqlite
      .prepare('INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)')
      .run('2026-01-01T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO benchmark_config
          (router, min_accuracy, switch_cost_factor, max_concurrency, benchmark_user_id,
            benchmark_org_id, updated_at)
        VALUES ('efficient', 0.7, 1, 80, 'bot-internal-1', 'bench-org', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO config_classifier_models (router, model) VALUES ('efficient', 'vendor/classifier')"
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO config_decider_models (router, model, variant, reasoning_effort)
        VALUES ('efficient', ?, NULL, NULL)`
      )
      .run(MODEL);
  });

  function key(overrides: Partial<PaidCaseKey> = {}): PaidCaseKey {
    return {
      engineIdentity: ENGINE,
      model: MODEL,
      variant: '',
      rep: 0,
      caseId: CASE,
      ...overrides,
    };
  }

  function seedRun(runId: string, status = 'running', repetitions = 1, startedMs = now - 60_000) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, kind, router, status, started_at, min_accuracy, switch_cost_factor,
            max_concurrency, engine_identity, repetitions, purpose, measurement_revision,
            admission_marker)
        VALUES (?, 'decider', 'efficient', ?, ?, 0.7, 1, 80, ?, ?, 'user', ?, ?)`
      )
      .run(
        runId,
        status,
        new Date(startedMs).toISOString(),
        ENGINE,
        repetitions,
        ACTIVE_MEASUREMENT_REVISION,
        'admitted:test'
      );
  }

  function seedChunk(input: {
    chunkId: string;
    runId: string;
    token: string;
    slot: number;
    caseId?: string;
  }) {
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks
          (id, run_id, model, variant, providers, rep, chunk, case_ids, status, token, slot,
            lease_until, available_at, attempts)
        VALUES (?, ?, ?, '', '[]', 0, 0, ?, 'active', ?, ?, ?, 0, 0)`
      )
      .run(
        input.chunkId,
        input.runId,
        MODEL,
        JSON.stringify([input.caseId ?? CASE]),
        input.token,
        input.slot,
        now + 600_000
      );
  }

  /** A confirmed, active request row; the case rows it stages are foreign-keyed to it. */
  function seedRequest(requestId: string) {
    // The pool path reads the selected request's own signed project from its quote plan; a
    // request without one cannot be stamped and its selection is refused.
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO paid_benchmark_quotes
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
            plan_cases, expires_at, created_at, updated_at)
        VALUES (?, 'user', ?, NULL, 'efficient', ?, 'pool-v1', ?, '{}', ?, 100, 100, 1,
          '2027-01-01T00:00:00.000Z', ?, ?)`
      )
      .run(
        `quote-${requestId}`,
        `owner-${requestId}`,
        `router-${requestId}`,
        ENGINE,
        JSON.stringify({ projectId: PROJECT_ID }),
        new Date(now).toISOString(),
        new Date(now).toISOString()
      );
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO paid_benchmark_requests
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
            charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
            context, created_at, updated_at, activated_at)
        VALUES (?, 'user', ?, NULL, 'efficient', ?, 'pool-v1', ?, 'active', ?, 100, 100, 0, 1, 0,
          NULL, 'actor-1', '{}', ?, ?, ?)`
      )
      .run(
        requestId,
        `owner-${requestId}`,
        `router-${requestId}`,
        ENGINE,
        `quote-${requestId}`,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        new Date(now).toISOString()
      );
  }

  /** Stage `requestId` onto the shared case fence (queued) without claiming it. */
  async function stage(requestId: string, caseKey = key()) {
    seedRequest(requestId);
    await db.batch(enqueuePaidCaseStatements(db, { key: caseKey, requestId, now }));
  }

  /** One executor claims the case. Returns the fence outcome, never a server-side guess. */
  async function claim(runId: string, token: string, caseKey = key()) {
    const executor = { runId, token };
    const results = await db.batch(claimPaidCaseStatements(db, { key: caseKey, executor, now }));
    return {
      outcome: paidCaseClaimOutcome(lastRow<PaidCaseRunRow>(results), executor).outcome,
      row: lastRow<PaidCaseRunRow>(results),
    };
  }

  /**
   * One provider permit: select a payer then admit it. `changed` is the transition's own
   * change count, so a duplicate delivery is never counted as a second permit.
   */
  async function permit(input: {
    runId: string;
    generation: number;
    modelRequestId: string;
    assignmentId: string;
    usageId: string;
    caseKey?: PaidCaseKey;
  }): Promise<boolean> {
    const caseKey = input.caseKey ?? key();
    await db.batch(
      selectPaidModelRequestPayerStatements(db, {
        key: caseKey,
        generation: input.generation,
        modelRequestId: input.modelRequestId,
        assignmentId: input.assignmentId,
        api: 'chat/completions',
        executorUserId: 'actor-1',
        usageId: input.usageId,
        now,
      })
    );
    const results = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: caseKey,
        generation: input.generation,
        modelRequestId: input.modelRequestId,
        assignmentId: input.assignmentId,
        now,
      })
    );
    return paidModelRequestAdmission(results as never).changed;
  }

  // The store's own reader, so the row every assertion sees has the exact shape production
  // uses — no hand-written projection that can drift from it.
  function caseRun(caseKey = key()) {
    return readPaidCaseRun(db, caseKey);
  }

  /**
   * The generation a claimant must act on: claiming increments it, so it is read from the
   * fence, never assumed. Production passes the claimed row's generation to the gateway.
   */
  function generationOf(claimed: { generation: number } | null | undefined): number {
    if (!claimed) throw new Error('expected a claimed fence row');
    return claimed.generation;
  }

  /** The fence row, failing the test rather than dereferencing nothing. */
  async function fence(caseKey = key()) {
    const row = await caseRun(caseKey);
    if (row === null) throw new Error('expected a benchmark_case_runs row');
    return row;
  }

  type CountRow = { n: number };

  /** A count from the raw fixture; `node:sqlite` rows are not the D1 contract. */
  function countRows(sql: string): number {
    const row = sqlite.prepare(sql).get();
    if (row === undefined) return 0;
    const counted = row as CountRow;
    return Number(counted.n);
  }

  function permits(): number {
    return countRows("SELECT COUNT(*) AS n FROM paid_model_requests WHERE state = 'admitted'");
  }

  /**
   * Native receipts. `paid_attempt_usage` is the only financial writer for a case, so every
   * fault assertion reads it: a crash must never add, lose or duplicate one.
   */
  function receipts(): number {
    return countRows('SELECT COUNT(*) AS n FROM paid_attempt_usage');
  }

  /**
   * Permits ever granted, from the durable attempt trail rather than the live request
   * state: a receipt moves the row to `completed`, so `permits()` falls back to 0 while
   * this count — the proof that exactly one provider call was authorized — stays correct.
   */
  function acceptedPermits(): number {
    return countRows(
      "SELECT COUNT(*) AS n FROM paid_model_request_attempts WHERE status = 'accepted'"
    );
  }

  function seedResult(input: {
    runId: string;
    rep: number;
    costUsd?: number;
    promptRevision?: number;
    exitCode?: number;
  }) {
    sqlite
      .prepare(
        `INSERT INTO case_results
          (run_id, model, variant, case_id, score, latency_ms, cost_usd, rep, timed_out,
            exit_code, prompt_revision)
        VALUES (?, ?, '', ?, 1, 10, ?, ?, 0, ?, ?)`
      )
      .run(
        input.runId,
        MODEL,
        CASE,
        input.costUsd ?? 0.001,
        input.rep,
        input.exitCode ?? 0,
        input.promptRevision ?? ACTIVE_MEASUREMENT_REVISION
      );
  }

  /** The exact slot set the plan still says must be measured. */
  async function missingSlots() {
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog(), now },
      {
        context: context(),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    if (outcome.status === 'empty') return { status: 'empty' as const, missing: [] as number[] };
    if (outcome.status !== 'ready') return { status: outcome.status, missing: [] as number[] };
    const plan = outcome.plan;
    const missing: number[] = [];
    for (let index = 0; index < planSlotCount(plan); index += 1) {
      const pairIndex = Math.floor(index / (plan.caseIds.length * plan.repetitions));
      const within = index - pairIndex * (plan.caseIds.length * plan.repetitions);
      const caseIndex = Math.floor(within / plan.repetitions);
      const rep = within % plan.repetitions;
      const bytes = Buffer.from(plan.pairs[pairIndex].missing, 'base64');
      const bit = caseIndex * plan.repetitions + rep;
      if (bytes[Math.floor(bit / 8)] & (1 << (bit % 8))) missing.push(index);
    }
    return { status: 'ready' as const, missing };
  }

  // --- ordering permutations: two confirmed pools, one exact case ---------------------

  it('serializes the two claimants in both orders and permits exactly one provider call', async () => {
    for (const firstIsA of [true, false]) {
      // Fresh fence and requests per ordering so the second ordering does not observe the
      // first's settled fence, requests or admission ledger.
      sqlite.exec('DELETE FROM benchmark_case_runs');
      sqlite.exec('DELETE FROM benchmark_runs');
      sqlite.exec('DELETE FROM scheduler_chunks');
      sqlite.exec('DELETE FROM paid_benchmark_request_cases');
      sqlite.exec('DELETE FROM paid_model_requests');

      await stage('request-a');
      await stage('request-b');
      seedRun('run-a');
      seedRun('run-b');
      seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });
      seedChunk({ chunkId: 'chunk-b', runId: 'run-b', token: 'token-b', slot: 1 });

      const first = firstIsA
        ? { runId: 'run-a', token: 'token-a' }
        : { runId: 'run-b', token: 'token-b' };
      const second = firstIsA
        ? { runId: 'run-b', token: 'token-b' }
        : { runId: 'run-a', token: 'token-a' };

      const firstClaim = await claim(first.runId, first.token);
      expect(firstClaim.outcome).toBe('started');
      // The first claimant's admission is the only permit this case may ever issue.
      expect(
        await permit({
          runId: first.runId,
          generation: generationOf(firstClaim.row),
          modelRequestId: MODEL_REQUEST_1,
          assignmentId: ASSIGNMENT_1,
          usageId: USAGE_1,
        })
      ).toBe(true);

      // The second claimant does not infer: it attaches to the live generation.
      const secondClaim = await claim(second.runId, second.token);
      expect(secondClaim.outcome).toBe('attached');
      expect(secondClaim.row?.executor_run_id).toBe(first.runId);

      // Whichever the order, exactly one permit exists and one queued row survives.
      expect(permits()).toBe(1);
      expect((await fence()).status).toBe('running');
      expect(countRows('SELECT COUNT(*) AS n FROM benchmark_case_runs')).toBe(1);
    }
  });

  // --- 1 repetition prior reused by a 3 repetition run --------------------------------

  it('reuses one prior repetition into a three-repetition plan and leaves exactly two missing', async () => {
    seedRun('prior', 'completed', 1, now - 120_000);
    seedResult({ runId: 'prior', rep: 0 });

    // Nothing else stored: repetitions 1 and 2 have no draw at all.
    expect(await missingSlots()).toEqual({ status: 'ready', missing: [1, 2] });
    // Plan slot index 0 is rep 0 (one case, three repetitions) and it is reused, not quoted.
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog(), now },
      {
        context: context(),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    if (outcome.status !== 'ready') throw new Error(`expected a ready plan, got ${outcome.status}`);
    expect(outcome.plan.caseIds).toEqual([CASE]);
    expect(outcome.plan.repetitions).toBe(3);
    expect(outcome.plan.counts.reused).toBe(1);
    expect(outcome.plan.counts.exclusive).toBe(2);
  });

  // --- result arrives before the second claimant has permission -----------------------

  it('reuses the result that landed before the second claimant was allowed to infer', async () => {
    await stage('request-a');
    seedRun('run-a');
    seedRun('run-b');
    seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });
    seedChunk({ chunkId: 'chunk-b', runId: 'run-b', token: 'token-b', slot: 1 });

    const firstClaim = await claim('run-a', 'token-a');
    expect(firstClaim.outcome).toBe('started');
    // The owner's provider call is admitted and then settles with a usable result.
    expect(
      await permit({
        runId: 'run-a',
        generation: generationOf(firstClaim.row),
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
      })
    ).toBe(true);
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: {
          runId: 'run-a',
          token: 'token-a',
          generation: generationOf(firstClaim.row),
        },
        resultUsable: true,
        settlementId: 'settle-1',
        now,
      })
    );

    // The second claimant never gets a permit — it reads the settled result instead.
    const secondClaim = await claim('run-b', 'token-b');
    expect(secondClaim.outcome).toBe('reused');
    expect(permits()).toBe(1);

    // The plan only draws from *finished* runs, so the owner's run must complete before its
    // result counts as stored reuse. One draw fills its own repetition slot only: the
    // efficient router takes three repetitions, so 1 and 2 remain genuinely missing.
    seedResult({ runId: 'run-a', rep: 0 });
    sqlite
      .prepare(
        "UPDATE benchmark_runs SET status = 'completed', completed_at = ? WHERE id = 'run-a'"
      )
      .run(new Date(now).toISOString());
    expect(await missingSlots()).toEqual({ status: 'ready', missing: [1, 2] });
  });

  // --- loser attaches vs reuses -------------------------------------------------------

  it('attaches to a live owner, fences an unusable settlement, then reuses a late usable one', async () => {
    await stage('request-a');

    // Live owner: the loser attaches.
    seedRun('run-live');
    seedRun('run-loser');
    seedChunk({ chunkId: 'chunk-live', runId: 'run-live', token: 'token-live', slot: 0 });
    seedChunk({ chunkId: 'chunk-loser', runId: 'run-loser', token: 'token-loser', slot: 1 });
    const liveClaim = await claim('run-live', 'token-live');
    expect(liveClaim.outcome).toBe('started');
    expect((await claim('run-loser', 'token-loser')).outcome).toBe('attached');
    const generation = generationOf(liveClaim.row);

    // The owner settles with an unusable result: it measured nothing, so it is never
    // advertised as reuse. The loser is fenced and still holds no permit.
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-live', token: 'token-live', generation },
        resultUsable: false,
        settlementId: 'settle-unusable',
        now,
      })
    );
    expect((await fence()).result_usable).toBe(0);
    const afterUnusable = await claim('run-loser', 'token-loser');
    // Exact outcome, not a negative assertion: an unusable settlement fences the claimant.
    expect(afterUnusable).toEqual({
      outcome: 'fenced',
      row: expect.objectContaining({ status: 'settled', result_usable: 0 }),
    });
    expect(permits()).toBe(0);

    // The same generation's output arrives late and does grade: it becomes usable in place,
    // and only then is the same claimant handed the result as a reuse — still no permit.
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-live', token: 'token-live', generation },
        resultUsable: true,
        settlementId: 'settle-recovered',
        now,
      })
    );
    expect((await fence()).result_usable).toBe(1);
    const afterUsable = await claim('run-loser', 'token-loser');
    expect(afterUsable).toEqual({
      outcome: 'reused',
      row: expect.objectContaining({ status: 'settled', result_usable: 1 }),
    });
    expect(permits()).toBe(0);
  });

  it('closes an enqueue for an unusable settlement and only reuses a usable one', async () => {
    // The enqueue outcome is the same rule as the claim: `closed` for a settled generation
    // that measured nothing, `reused` only once the result is usable.
    await stage('request-a');
    seedRun('run-live');
    seedChunk({ chunkId: 'chunk-live', runId: 'run-live', token: 'token-live', slot: 0 });
    const liveClaim = await claim('run-live', 'token-live');
    expect(liveClaim.outcome).toBe('started');
    const generation = generationOf(liveClaim.row);

    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-live', token: 'token-live', generation },
        resultUsable: false,
        settlementId: 'settle-unusable',
        now,
      })
    );
    await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId: 'request-a', now }));
    expect(paidCaseEnqueueOutcome(await caseRun())).toBe('closed');

    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-live', token: 'token-live', generation },
        resultUsable: true,
        settlementId: 'settle-recovered',
        now,
      })
    );
    await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId: 'request-a', now }));
    expect(paidCaseEnqueueOutcome(await caseRun())).toBe('reused');
    expect(permits()).toBe(0);
  });

  // --- late prior generation after pause/cancel/reclaim -------------------------------

  it('never reopens a cancelled generation that still has a pending cancellation', async () => {
    await stage('request-a');
    seedRun('run-a');
    seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });
    expect((await claim('run-a', 'token-a')).outcome).toBe('started');

    // Cancel the generation and leave its cancellation intent undelivered.
    // The intent belongs to the generation that is actually in flight, not to an assumed 1.
    const inFlight = (await fence()).generation;
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_cancellations
          (engine_identity, model, variant, rep, case_id, generation, executor_run_id,
            executor_token, status, attempts, available_at, created_at, updated_at)
        VALUES (?, ?, '', 0, ?, ?, 'run-a', 'token-a', 'pending', 0, ?, ?, ?)`
      )
      .run(ENGINE, MODEL, CASE, inFlight, now, now, now);
    sqlite
      .prepare(
        `UPDATE benchmark_case_runs SET status = 'cancelled', result_usable = 0
        WHERE engine_identity = ? AND model = ? AND variant = '' AND rep = 0 AND case_id = ?`
      )
      .run(ENGINE, MODEL, CASE);

    // A reclaim is an explicit re-confirmation, but the in-flight attempt is unconfirmed:
    // the row must stay cancelled, and a fresh claim cannot start a second generation.
    await db.batch(
      enqueuePaidCaseStatements(db, { key: key(), requestId: 'request-a', reclaim: true, now })
    );
    expect((await fence()).status).toBe('cancelled');
    expect((await fence()).generation).toBe(inFlight);
    expect((await claim('run-a', 'token-a-2')).outcome).toBe('fenced');

    // A late result from the cancelled generation cannot be laundered into a reuse either,
    // because the row was never reopened and no usable flag was set.
    expect((await fence()).result_usable).toBe(0);
    expect(permits()).toBe(0);
  });

  // --- crash and replay ---------------------------------------------------------------

  it('replays a crashed claim without opening a second provider permit', async () => {
    await stage('request-a');
    seedRun('run-a');
    seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });

    // The first delivery claims, gets its permit, then dies before settling.
    const initial = await claim('run-a', 'token-a');
    expect(initial.outcome).toBe('started');
    expect(
      await permit({
        runId: 'run-a',
        generation: generationOf(initial.row),
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
      })
    ).toBe(true);

    // The redelivered message re-claims with the same executor identity. The fence only
    // increments a `queued` row, so a replay of a running fence stays in the same
    // generation: this is the owner continuing, never a second physical attempt.
    const replay = await claim('run-a', 'token-a');
    expect(replay.outcome).toBe('started');
    expect(replay.row?.generation).toBe(initial.row?.generation);

    // A duplicate permit delivery for the same model request changes nothing.
    expect(
      await permit({
        runId: 'run-a',
        generation: generationOf(initial.row),
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
      })
    ).toBe(false);
    // A second, different model request is refused while the first is admitted: only one
    // outstanding call per account per case.
    expect(
      await permit({
        runId: 'run-a',
        generation: generationOf(initial.row),
        modelRequestId: MODEL_REQUEST_2,
        assignmentId: ASSIGNMENT_2,
        usageId: USAGE_2,
      })
    ).toBe(false);
    expect(permits()).toBe(1);
  });

  it('keeps a durable result usable across a crash in the same generation', async () => {
    await stage('request-a');
    seedRun('run-a');
    seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });
    const claimed = await claim('run-a', 'token-a');
    expect(claimed.outcome).toBe('started');

    // The output landed but the settlement reply was lost: the late-result path marks the
    // already-terminal generation usable instead of charging a new attempt.
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: {
          runId: 'run-a',
          token: 'token-a',
          generation: generationOf(claimed.row),
        },
        resultUsable: false,
        settlementId: 'settle-lost',
        now,
      })
    );
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: {
          runId: 'run-a',
          token: 'token-a',
          generation: generationOf(claimed.row),
        },
        resultUsable: true,
        settlementId: 'settle-recovered',
        now,
      })
    );

    expect((await fence()).result_usable).toBe(1);
    // The recovered result is a reuse for everyone else, not a new paid attempt.
    seedRun('run-b');
    seedChunk({ chunkId: 'chunk-b', runId: 'run-b', token: 'token-b', slot: 1 });
    expect((await claim('run-b', 'token-b')).outcome).toBe('reused');
    expect(permits()).toBe(0);
  });

  // --- faults at the exact boundaries a crash can land on ------------------------------

  it('opens no provider work when the stage batch fails after its attempted writes', async () => {
    seedRun('run-a');
    seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });
    seedRequest('request-a');

    // The stage batch writes the fence row first and the displayed request case last. Fail
    // that last write so the batch rolls back: a partial stage must leave nothing behind,
    // because a fence row without its funding row is exactly the state that would let a
    // claim open paid work nobody authorized.
    sqlite.exec(`
      CREATE TRIGGER fail_staged_case BEFORE INSERT ON paid_benchmark_request_cases
      BEGIN SELECT RAISE(ABORT, 'D1 fault while staging'); END;
    `);
    await expect(
      db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId: 'request-a', now }))
    ).rejects.toThrow(/D1 fault while staging/);
    sqlite.exec('DROP TRIGGER fail_staged_case');

    // The stage rolled back completely: no fence row, no displayed case, so nothing the
    // scheduler could later dispatch from.
    expect(await caseRun()).toBeNull();
    expect(countRows('SELECT COUNT(*) AS n FROM paid_benchmark_request_cases')).toBe(0);

    // Defence in depth for a racing delivery that already holds a chunk: admission is the
    // spend gate, so a case with no funded payer row refuses instead of opening work.
    const raced = await claim('run-a', 'token-a');
    expect(
      await permit({
        runId: 'run-a',
        generation: generationOf(raced.row),
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
      })
    ).toBe(false);
    expect(await readPaidModelRequest(db, MODEL_REQUEST_1)).toMatchObject({
      state: 'refused',
      reason: 'no_funded_payer',
      owner_id: null,
    });
    expect(acceptedPermits()).toBe(0);
    expect(receipts()).toBe(0);
  });

  it('rolls back a failed admit transaction and dispatches exactly once on the genuine retry', async () => {
    await stage('request-a');
    seedRun('run-a');
    seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });
    const claimed = await claim('run-a', 'token-a');
    expect(claimed.outcome).toBe('started');
    const generation = generationOf(claimed.row);

    // Selection already committed; the permit transaction is what fails. Fail the payer's
    // acceptance write, the last state change in the batch, so the admit rolls back after
    // the request update was attempted inside the same transaction.
    await db.batch(
      selectPaidModelRequestPayerStatements(db, {
        key: key(),
        generation,
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        api: 'chat/completions',
        executorUserId: 'actor-1',
        usageId: USAGE_1,
        now,
      })
    );
    expect((await readPaidModelRequest(db, MODEL_REQUEST_1))?.state).toBe('selecting');

    sqlite.exec(`
      CREATE TRIGGER fail_payer_acceptance BEFORE UPDATE ON benchmark_case_payers
      WHEN NEW.status = 'accepted'
      BEGIN SELECT RAISE(ABORT, 'D1 fault while admitting'); END;
    `);
    await expect(
      db.batch(
        admitPaidModelRequestStatements(db, {
          key: key(),
          generation,
          modelRequestId: MODEL_REQUEST_1,
          assignmentId: ASSIGNMENT_1,
          now,
        })
      )
    ).rejects.toThrow(/D1 fault while admitting/);
    sqlite.exec('DROP TRIGGER fail_payer_acceptance');

    // Nothing survived: no permit, no eligible payer acceptance, no debit. The request is
    // still selecting, which is what makes the retry a genuine second attempt rather than a
    // duplicate of a committed one.
    expect(permits()).toBe(0);
    expect(receipts()).toBe(0);
    expect(await readPaidModelRequest(db, MODEL_REQUEST_1)).toMatchObject({
      state: 'selecting',
      owner_type: expect.any(String),
    });
    expect(
      countRows("SELECT COUNT(*) AS n FROM benchmark_case_payers WHERE status = 'accepted'")
    ).toBe(0);
    // The fence itself is untouched by the failed permit: the generation is still running,
    // so a retry is the same owner continuing, not a second generation.
    expect((await fence()).status).toBe('running');
    expect((await fence()).generation).toBe(generation);

    // The genuine retry admits exactly once and that one permit is what a receipt settles.
    expect(
      await permit({
        runId: 'run-a',
        generation,
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
      })
    ).toBe(true);
    expect(permits()).toBe(1);
    expect(
      countRows("SELECT COUNT(*) AS n FROM benchmark_case_payers WHERE status = 'accepted'")
    ).toBe(1);

    const admitted = await readPaidModelRequest(db, MODEL_REQUEST_1);
    if (!admitted?.owner_id || !admitted.owner_type) throw new Error('expected an admitted payer');
    await db.batch(
      acceptPaidAttemptUsageStatements(db, {
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
        microdollars: 40,
        expected: {
          owner: { ownerType: admitted.owner_type, ownerId: admitted.owner_id },
          model: MODEL,
          variant: '',
          caseId: CASE,
          generation,
          projectId: PROJECT_ID,
        },
        now,
      })
    );
    expect(receipts()).toBe(1);

    // A replayed delivery of the same permit still changes nothing.
    expect(
      await permit({
        runId: 'run-a',
        generation,
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
      })
    ).toBe(false);
    expect(acceptedPermits()).toBe(1);
    expect(receipts()).toBe(1);
  });

  it('keeps a duplicate delivery after the admit commit harmless when the reply is lost', async () => {
    await stage('request-a');
    seedRun('run-a');
    seedChunk({ chunkId: 'chunk-a', runId: 'run-a', token: 'token-a', slot: 0 });
    const claimed = await claim('run-a', 'token-a');
    expect(claimed.outcome).toBe('started');
    const generation = generationOf(claimed.row);

    // The admit committed but the reply never reached the caller: the gateway retries the
    // same delivery. The permit is already consumed, so the duplicate cannot take another.
    expect(
      await permit({
        runId: 'run-a',
        generation,
        modelRequestId: MODEL_REQUEST_1,
        assignmentId: ASSIGNMENT_1,
        usageId: USAGE_1,
      })
    ).toBe(true);
    expect(permits()).toBe(1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await permit({
          runId: 'run-a',
          generation,
          modelRequestId: MODEL_REQUEST_1,
          assignmentId: ASSIGNMENT_1,
          usageId: USAGE_1,
        })
      ).toBe(false);
    }
    expect(permits()).toBe(1);
    expect(receipts()).toBe(0);
    // The caller re-fetches the committed row instead of re-executing: same assignment,
    // still admitted, and the case fence never advanced.
    expect(await readPaidModelRequest(db, MODEL_REQUEST_1)).toMatchObject({
      state: 'admitted',
      assignment_id: ASSIGNMENT_1,
      generation,
    });
    expect((await fence()).generation).toBe(generation);
    expect((await fence()).status).toBe('running');

    // The native receipt and the late output both land afterwards, each exactly once.
    const payer = await readPaidModelRequest(db, MODEL_REQUEST_1);
    const owner =
      payer?.owner_type && payer.owner_id
        ? { ownerType: payer.owner_type, ownerId: payer.owner_id }
        : null;
    if (owner === null) throw new Error('expected an admitted payer');
    const receipt = () =>
      db.batch(
        acceptPaidAttemptUsageStatements(db, {
          assignmentId: ASSIGNMENT_1,
          usageId: USAGE_1,
          microdollars: 40,
          expected: {
            owner,
            model: MODEL,
            variant: '',
            caseId: CASE,
            generation,
            projectId: PROJECT_ID,
          },
          now,
        })
      );
    await receipt();
    await receipt();
    expect(receipts()).toBe(1);

    const settle = (resultUsable: boolean, settlementId: string) =>
      db.batch(
        completePaidCaseStatements(db, {
          key: key(),
          generation: { runId: 'run-a', token: 'token-a', generation },
          resultUsable,
          settlementId,
          now,
        })
      );
    await settle(true, 'settle-commit');
    await settle(true, 'settle-commit');
    expect(await fence()).toMatchObject({
      status: 'settled',
      result_usable: 1,
      settlement_id: 'settle-commit',
      generation,
    });
    // One measured outcome, one charge, and no second generation to pay for it.
    expect(receipts()).toBe(1);
    expect(acceptedPermits()).toBe(1);
  });
});
