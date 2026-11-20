/**
 * Admin console reads over the paid-request tables against real SQLite: the shapes the
 * console renders (requester, spend, per-case counts, payer split) and the pause control
 * must match what the store actually wrote.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import type { PaidBillingEnv } from './paid-billing';
import {
  admitPaidModelRequestStatements,
  selectPaidModelRequestPayerStatements,
  type PaidCaseKey,
} from './paid-case-store';
import {
  listPaidBenchmarkAdminRequests,
  pausePaidBenchmarkAdminRequest,
  readPaidBenchmarkAdminProgress,
  readPaidBenchmarkAdminRequest,
} from './paid-benchmark-admin';

const ENGINE = 'engine-admin-test';
const REQUEST = '11111111-1111-4111-8111-111111111111';
const QUOTE = '33333333-3333-4333-8333-333333333333';
const ROUTER_ID = '22222222-2222-4222-8222-222222222222';

let sqlite: DatabaseSync;
let db: D1Database;

function insertRequest(
  overrides: Partial<{
    id: string;
    ownerType: 'user' | 'organization';
    ownerId: string;
    status: 'preparing' | 'active' | 'paused' | 'completed' | 'failed';
    charged: number;
    pauseReason: 'no_funds' | 'owner' | null;
    router: string;
    routerId: string;
    updatedAt: string;
  }> = {}
) {
  const id = overrides.id ?? REQUEST;
  const at = overrides.updatedAt ?? '2026-11-20T12:00:00.000Z';
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_requests (
        id, owner_type, owner_id, organization_id, router, router_id, pool_version,
        engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
        charged_microdollars, pause_reason, actor_user_id, context, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, 'pool-1', ?, ?, ?, 1000000, 1200000, ?, ?,
        'actor-1', '{"ownerType":"user","ownerId":"u1","baseRouter":"efficient","entries":[],"clientEvalEntryKeys":[]}',
        ?, ?)`
    )
    .run(
      id,
      overrides.ownerType ?? 'user',
      overrides.ownerId ?? 'u1',
      overrides.router ?? 'efficient',
      overrides.routerId ?? ROUTER_ID,
      ENGINE,
      overrides.status ?? 'active',
      QUOTE,
      overrides.charged ?? 0,
      overrides.pauseReason ?? null,
      at,
      at
    );
}

function insertCase(
  requestId: string,
  caseId: string,
  status: string,
  options: { covered?: number; charged?: number } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_request_cases (
        request_id, engine_identity, model, variant, rep, case_id, status,
        covered_by_kilo, charged_microdollars, reason, updated_at
      ) VALUES (?, ?, 'openai/gpt-test', '', 0, ?, ?, ?, ?, NULL, '2026-11-20T12:00:00.000Z')`
    )
    .run(requestId, ENGINE, caseId, status, options.covered ?? 0, options.charged ?? 0);
}

/** One native model request: the one-time assignment of one case run to one account. */
function insertModelRequest(
  modelRequestId: string,
  caseId: string,
  options: {
    ownerType?: 'user' | 'organization';
    ownerId?: string;
    platformCovered?: boolean;
    state?: 'selecting' | 'admitted' | 'refused' | 'completed';
    /** The pool request that pays this call; defaults to the fixture's main request. */
    requestId?: string;
  } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO paid_model_requests (
        id, engine_identity, model, variant, rep, case_id, generation, pool_request_id,
        state, assignment_id, owner_type, owner_id, platform_covered, reason, created_at,
        updated_at
      ) VALUES (?, ?, 'openai/gpt-test', '', 0, ?, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(
      modelRequestId,
      ENGINE,
      caseId,
      options.platformCovered ? null : (options.requestId ?? REQUEST),
      options.state ?? 'completed',
      options.ownerId ? `assignment-${modelRequestId}` : null,
      options.platformCovered ? null : (options.ownerType ?? 'user'),
      options.platformCovered ? null : (options.ownerId ?? 'u1'),
      options.platformCovered ? 1 : 0,
      '2026-11-20T12:00:00.000Z',
      '2026-11-20T12:00:00.000Z'
    );
}

/** A refused candidate: the auditable detach reason another account was tried. */
function insertRefusedAttempt(
  modelRequestId: string,
  assignmentId: string,
  options: { ownerId?: string; ownerType?: 'user' | 'organization'; reason?: string } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO paid_model_request_attempts (
        model_request_id, assignment_id, owner_type, owner_id, pool_request_id, status,
        reason, ordinal, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'refused', ?, 0, ?, ?)`
    )
    .run(
      modelRequestId,
      assignmentId,
      options.ownerType ?? 'user',
      options.ownerId ?? 'u9',
      REQUEST,
      options.reason ?? 'insufficient_balance',
      '2026-11-20T12:00:00.000Z',
      '2026-11-20T12:00:00.000Z'
    );
}

/** One accepted native usage receipt, the row native billing wrote for a model request. */
function insertUsage(
  usageId: string,
  modelRequestId: string,
  caseId: string,
  options: {
    microdollars: number;
    platformCovered?: boolean;
    ownerType?: 'user' | 'organization';
    ownerId?: string;
    requestId?: string;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO paid_attempt_usage (
        usage_id, model_request_id, request_id, engine_identity, model, variant, rep,
        case_id, generation, owner_type, owner_id, microdollars, platform_covered, created_at
      ) VALUES (?, ?, ?, ?, 'openai/gpt-test', '', 0, ?, 1, ?, ?, ?, ?, '2026-11-20T12:00:00.000Z')`
    )
    .run(
      usageId,
      modelRequestId,
      options.requestId ?? REQUEST,
      ENGINE,
      caseId,
      options.ownerType ?? 'user',
      options.ownerId ?? 'u1',
      options.microdollars,
      options.platformCovered ? 1 : 0
    );
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  db = sqliteD1(sqlite);
});

describe('admin request reads', () => {
  it('reports billed model requests, spend and the payer split from usage receipts', async () => {
    insertRequest();
    insertCase(REQUEST, 'case-1', 'done');
    insertCase(REQUEST, 'case-2', 'reused');
    insertCase(REQUEST, 'case-3', 'running', { covered: 1 });
    // Two model requests billed to the owner, one accepted by a second concurrent payer,
    // one Kilo covered after it joined, and one carried by a payer that later lost funds.
    insertModelRequest('model-request-1', 'case-1', { ownerId: 'u1' });
    insertModelRequest('model-request-2', 'case-3', { ownerId: 'u1' });
    insertModelRequest('model-request-3', 'case-1', { ownerId: 'u2' });
    insertModelRequest('model-request-4', 'case-3', { platformCovered: true, state: 'completed' });
    insertModelRequest('model-request-5', 'case-2', { ownerId: 'u9' });
    // A later candidate on the same model request was refused for no funds: the reason an
    // admin sees next to the spend u9 already carried on that request.
    insertRefusedAttempt('model-request-5', 'assignment-refused-1', {
      ownerId: 'u9',
      reason: 'insufficient_balance',
    });
    insertUsage('usage-1', 'model-request-1', 'case-1', { microdollars: 400 });
    insertUsage('usage-2', 'model-request-2', 'case-3', { microdollars: 100 });
    insertUsage('usage-3', 'model-request-3', 'case-1', {
      microdollars: 600,
      ownerId: 'u2',
    });
    insertUsage('usage-4', 'model-request-4', 'case-3', {
      microdollars: 250,
      platformCovered: true,
    });
    insertUsage('usage-5', 'model-request-5', 'case-2', { microdollars: 50, ownerId: 'u9' });

    const listed = await listPaidBenchmarkAdminRequests(db, { router: 'efficient' });
    expect(listed.requests).toHaveLength(1);
    const [request] = listed.requests;
    expect(request.requester).toEqual({
      kind: 'user',
      ownerId: 'u1',
      actorUserId: 'actor-1',
      ownerLabel: null,
    });
    expect(request.counts).toEqual({
      queued: 0,
      running: 1,
      reused: 1,
      done: 1,
      failed: 0,
      paused: 0,
    });
    expect(request.maximumMicrodollars).toBe(1_200_000);
    expect(request.poolName).toBeNull();
    // Spend counts every non-platform receipt of the request; Kilo's cover is reported apart.
    expect(request.billedModelRequests).toBe(4);
    expect(request.chargedMicrodollars).toBe(1_150);
    expect(request.kiloCoveredModelRequests).toBe(1);
    expect(request.kiloCoveredMicrodollars).toBe(250);
    expect(request.pauseReason).toBeNull();
    // Payer rows name billed requests, not cases, and a detached payer keeps its reason.
    expect(request.payers).toEqual(
      expect.arrayContaining([
        {
          kind: 'user',
          ownerId: 'u1',
          billedModelRequests: 2,
          chargedMicrodollars: 500,
          detachReason: null,
          ownerLabel: null,
        },
        {
          kind: 'user',
          ownerId: 'u2',
          billedModelRequests: 1,
          chargedMicrodollars: 600,
          detachReason: null,
          ownerLabel: null,
        },
        {
          kind: 'user',
          ownerId: 'u9',
          billedModelRequests: 1,
          chargedMicrodollars: 50,
          detachReason: 'insufficient_balance',
          ownerLabel: null,
        },
        { kind: 'platform', kiloCoveredModelRequests: 1, kiloCoveredMicrodollars: 250 },
      ])
    );
    expect(request.payers).toHaveLength(4);
  });

  it('keeps pre-join owner charges when Kilo covers the rest of the case', async () => {
    // A request paused because a payer lost funds: the owner keeps every charge billed
    // before Kilo joined, and only the covered receipt is reported as Kilo's.
    insertRequest({ status: 'paused', pauseReason: 'no_funds' });
    insertCase(REQUEST, 'case-1', 'paused', { covered: 1 });
    insertModelRequest('model-request-1', 'case-1', { ownerId: 'u1' });
    insertModelRequest('model-request-2', 'case-1', { platformCovered: true, state: 'completed' });
    insertUsage('usage-1', 'model-request-1', 'case-1', { microdollars: 900 });
    insertUsage('usage-2', 'model-request-2', 'case-1', {
      microdollars: 300,
      platformCovered: true,
    });

    const listed = await listPaidBenchmarkAdminRequests(db, { router: 'efficient' });
    const [request] = listed.requests;
    expect(request.status).toBe('paused');
    expect(request.pauseReason).toBe('no_funds');
    // The pre-join charge stays with its owner; the covered receipt does not erase it.
    expect(request.chargedMicrodollars).toBe(900);
    expect(request.billedModelRequests).toBe(1);
    expect(request.kiloCoveredModelRequests).toBe(1);
    expect(request.kiloCoveredMicrodollars).toBe(300);
    expect(request.payers).toEqual(
      expect.arrayContaining([
        {
          kind: 'user',
          ownerId: 'u1',
          billedModelRequests: 1,
          chargedMicrodollars: 900,
          detachReason: null,
          ownerLabel: null,
        },
        { kind: 'platform', kiloCoveredModelRequests: 1, kiloCoveredMicrodollars: 300 },
      ])
    );
  });

  it('scopes a shared case to each payer without duplicating or hiding Kilo coverage', async () => {
    // One case shared by a personal request (A) and a second personal request (B), plus a
    // platform-covered call on it. Each admin row must show only its own payer's spend.
    insertRequest();
    insertRequest({ id: 'request-b', ownerId: 'u2', routerId: 'router-2' });
    insertCase(REQUEST, 'case-shared', 'done');
    insertCase('request-b', 'case-shared', 'done');
    // A owns the pool call; B owns a separate call of its own on the same shared case.
    insertModelRequest('model-request-a', 'case-shared', { ownerId: 'u1' });
    insertModelRequest('model-request-b', 'case-shared', {
      ownerId: 'u2',
      requestId: 'request-b',
    });
    insertUsage('usage-a', 'model-request-a', 'case-shared', {
      microdollars: 400,
      ownerId: 'u1',
    });
    insertUsage('usage-b', 'model-request-b', 'case-shared', {
      microdollars: 70,
      ownerId: 'u2',
      requestId: 'request-b',
    });
    // Kilo covered one call of the shared case: neither owner is charged for it, and both
    // requests still see that the case was covered.
    insertModelRequest('model-request-cov', 'case-shared', {
      platformCovered: true,
      state: 'completed',
      requestId: 'request-b',
    });
    insertUsage('usage-cov', 'model-request-cov', 'case-shared', {
      microdollars: 250,
      platformCovered: true,
      // A covered call belongs to no pool request.
      requestId: '',
    });

    const listed = await listPaidBenchmarkAdminRequests(db, { router: 'efficient' });
    const a = listed.requests.find(entry => entry.id === REQUEST);
    const b = listed.requests.find(entry => entry.id === 'request-b');
    if (!a || !b) throw new Error('expected both requests');

    // Alpha sees its own 400 only; Bravo's 70 is not duplicated onto it, and neither is
    // the shared case's spend multiplied by the number of staged requests.
    expect(a.chargedMicrodollars).toBe(400);
    expect(a.billedModelRequests).toBe(1);
    // Only A's own model request is a payer of A; B's request is not in A's list.
    expect(a.payers.filter(payer => payer.kind === 'user')).toHaveLength(1);
    expect(a.payers[0]).toMatchObject({ ownerId: 'u1', chargedMicrodollars: 400 });
    // Alpha's own call was the paid one, so it shows no Kilo coverage.
    expect(a.kiloCoveredMicrodollars).toBe(0);

    expect(b.chargedMicrodollars).toBe(70);
    expect(b.billedModelRequests).toBe(1);
    expect(b.payers.filter(payer => payer.kind === 'user')).toHaveLength(1);
    expect(b.payers[0]).toMatchObject({ ownerId: 'u2', chargedMicrodollars: 70 });
    // A covered call has no paying pool request, so it is not attributed to either owner's
    // payer rows: neither request gains a platform payer row of its own.
    expect(a.payers.map(payer => payer.kind)).not.toContain('platform');
    expect(b.payers.map(payer => payer.kind)).not.toContain('platform');
  });

  it('maps an organization owner to the shared org kind', async () => {
    insertRequest({ ownerType: 'organization', ownerId: 'org-7' });
    const listed = await listPaidBenchmarkAdminRequests(db, { router: 'efficient' });
    expect(listed.requests[0].requester).toMatchObject({ kind: 'org', ownerId: 'org-7' });
  });

  it('filters by router and status and pages newest first by keyset', async () => {
    // One live request per saved pool is a unique constraint, so each row of the page is a
    // different pool; the paging reader keys on updated_at, not on pool identity.
    insertRequest({
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      routerId: 'aaaaaaaa-0000-4000-8000-000000000001',
      updatedAt: '2026-11-20T10:00:00.000Z',
    });
    insertRequest({
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      routerId: 'bbbbbbbb-0000-4000-8000-000000000002',
      updatedAt: '2026-11-20T11:00:00.000Z',
    });
    insertRequest({
      id: 'cccccccc-3333-4333-8333-333333333333',
      routerId: 'cccccccc-0000-4000-8000-000000000003',
      updatedAt: '2026-11-20T12:00:00.000Z',
      status: 'paused',
    });
    insertRequest({
      id: 'dddddddd-4444-4444-8444-444444444444',
      routerId: 'dddddddd-0000-4000-8000-000000000004',
      updatedAt: '2026-11-20T13:00:00.000Z',
      router: 'frontier',
    });

    const first = await listPaidBenchmarkAdminRequests(db, { router: 'efficient', limit: 2 });
    expect(first.requests.map(request => request.id)).toEqual([
      'cccccccc-3333-4333-8333-333333333333',
      'bbbbbbbb-2222-4222-8222-222222222222',
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPaidBenchmarkAdminRequests(db, {
      router: 'efficient',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.requests.map(request => request.id)).toEqual([
      'aaaaaaaa-1111-4111-8111-111111111111',
    ]);
    expect(second.nextCursor).toBeNull();

    const paused = await listPaidBenchmarkAdminRequests(db, {
      router: 'efficient',
      statuses: ['paused'],
    });
    expect(paused.requests.map(request => request.id)).toEqual([
      'cccccccc-3333-4333-8333-333333333333',
    ]);
  });

  it('rejects a cursor that is not this reader’s keyset', async () => {
    await expect(
      listPaidBenchmarkAdminRequests(db, { router: 'efficient', cursor: 'not-a-cursor' })
    ).rejects.toThrow(/cursor/);
  });
});

describe('admin progress', () => {
  it('serves the request row with one page of case detail', async () => {
    insertRequest();
    insertCase(REQUEST, 'case-1', 'done');
    insertCase(REQUEST, 'case-2', 'failed');

    insertModelRequest('model-request-1', 'case-1', { ownerId: 'u1' });
    insertUsage('usage-1', 'model-request-1', 'case-1', { microdollars: 700 });

    const progress = await readPaidBenchmarkAdminProgress(db, { requestId: REQUEST, limit: 1 });
    expect(progress.status).toBe('active');
    expect(progress.request?.id).toBe(REQUEST);
    expect(progress.cases).toHaveLength(1);
    expect(progress.cases[0]).toMatchObject({
      caseId: 'case-1',
      billedModelRequests: 1,
      chargedMicrodollars: 700,
    });
    expect(progress.nextCursor).not.toBeNull();

    const next = await readPaidBenchmarkAdminProgress(db, {
      requestId: REQUEST,
      limit: 1,
      cursor: progress.nextCursor ?? undefined,
    });
    expect(next.cases).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
  });

  it('returns the empty state for an unknown request', async () => {
    const progress = await readPaidBenchmarkAdminProgress(db, {
      requestId: '99999999-9999-4999-8999-999999999999',
    });
    expect(progress).toEqual({ status: 'empty', request: null, cases: [], nextCursor: null });
  });
});

/** A worker env whose only external call is the billing ledger, answered by the stub. */
function adminEnv() {
  return {
    env: {
      BENCH_DB: db,
      KILO_WEB_API_BASE_URL: 'https://web.test',
      INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
    } as unknown as PaidBillingEnv,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          applied: [],
          poolUnchanged: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch,
  };
}

const MODEL_REQUEST = '66666666-6666-4666-8666-666666666666';
const ASSIGNMENT = '77777777-7777-4777-8777-777777777777';
const USAGE = '88888888-8888-4888-8888-888888888888';
const PROJECT = '99999999-9999-4999-8999-999999999999';
const NEXT_MODEL_REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEXT_ASSIGNMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NEXT_USAGE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function caseKey(): PaidCaseKey {
  return {
    engineIdentity: ENGINE,
    model: 'openai/gpt-test',
    variant: '',
    rep: 0,
    caseId: 'case-1',
  };
}

/**
 * The state the store exists in when a native call is being admitted: the request is
 * active, its approved quote carries the signed project, its case is staged and the case
 * run is running under an executor. Selection and admission run through the real
 * statements, so the pause test observes genuine in-flight work rather than a fixture.
 */
async function seedAdmittingCase() {
  insertRequest();
  insertCase(REQUEST, 'case-1', 'queued');
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_quotes (
        id, owner_type, owner_id, organization_id, router, router_id, pool_version,
        engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
        plan_cases, expires_at, started_request_id, created_at, updated_at
      ) VALUES (?, 'user', 'u1', NULL, 'efficient', ?, 'pool-1', ?, '{}', ?, 1000000,
        1200000, 1, '2026-11-20T13:00:00.000Z', ?, ?, ?)`
    )
    .run(
      QUOTE,
      ROUTER_ID,
      ENGINE,
      JSON.stringify({ projectId: PROJECT }),
      REQUEST,
      '2026-11-20T12:00:00.000Z',
      '2026-11-20T12:00:00.000Z'
    );
  sqlite
    .prepare(
      `INSERT INTO benchmark_case_runs (
        engine_identity, model, variant, rep, case_id, status, generation, executor_run_id,
        executor_token, platform_covered, result_usable, created_at, updated_at, started_at
      ) VALUES (?, 'openai/gpt-test', '', 0, 'case-1', 'running', 1, 'exec-1', 'token-1',
        0, 0, ?, ?, ?)`
    )
    .run(
      ENGINE,
      '2026-11-20T12:00:00.000Z',
      '2026-11-20T12:00:00.000Z',
      '2026-11-20T12:00:00.000Z'
    );
  await db.batch(
    selectPaidModelRequestPayerStatements(db, {
      key: caseKey(),
      generation: 1,
      modelRequestId: MODEL_REQUEST,
      assignmentId: ASSIGNMENT,
      api: 'messages',
      executorUserId: 'benchmark-bot',
      usageId: USAGE,
    })
  );
  await db.batch(
    admitPaidModelRequestStatements(db, {
      key: caseKey(),
      generation: 1,
      modelRequestId: MODEL_REQUEST,
      assignmentId: ASSIGNMENT,
    })
  );
}

describe('admin pause', () => {
  it('pauses an active request: an admitted call stays attributed until its receipt', async () => {
    await seedAdmittingCase();
    const admitted = sqlite
      .prepare('SELECT state, owner_id FROM paid_model_requests WHERE id = ?')
      .get(MODEL_REQUEST) as { state: string; owner_id: string | null };
    expect(admitted).toEqual({ state: 'admitted', owner_id: 'u1' });
    const { env, fetchImpl } = adminEnv();

    const outcome = await pausePaidBenchmarkAdminRequest(env, REQUEST, { fetchImpl });

    expect(outcome).toBe('paused');
    const row = sqlite
      .prepare('SELECT status, paused_at, pause_reason FROM paid_benchmark_requests WHERE id = ?')
      .get(REQUEST) as { status: string; paused_at: string | null; pause_reason: string | null };
    expect(row.status).toBe('paused');
    expect(row.paused_at).not.toBeNull();
    expect(row.pause_reason).toBe('owner');
    // The in-flight call already reached the provider: it must stay attributable to the
    // account that admitted it until its native receipt lands, not be rewritten here.
    const stillAdmitted = sqlite
      .prepare('SELECT state, owner_id FROM paid_model_requests WHERE id = ?')
      .get(MODEL_REQUEST) as { state: string; owner_id: string | null };
    expect(stillAdmitted).toEqual({ state: 'admitted', owner_id: 'u1' });
  });

  it('fences a new admission after the pause and keeps the charge that landed', async () => {
    await seedAdmittingCase();
    const { env, fetchImpl } = adminEnv();
    await pausePaidBenchmarkAdminRequest(env, REQUEST, { fetchImpl });

    // A caller that selects again after the pause finds no active request: the real
    // selection statements answer refused/no_funded_payer rather than assigning a new
    // payer, which is the observable future fence.
    await db.batch(
      selectPaidModelRequestPayerStatements(db, {
        key: caseKey(),
        generation: 1,
        modelRequestId: NEXT_MODEL_REQUEST,
        assignmentId: NEXT_ASSIGNMENT,
        api: 'messages',
        executorUserId: 'benchmark-bot',
        usageId: NEXT_USAGE,
      })
    );
    const refused = sqlite
      .prepare('SELECT state, reason, owner_id FROM paid_model_requests WHERE id = ?')
      .get(NEXT_MODEL_REQUEST) as {
      state: string;
      reason: string | null;
      owner_id: string | null;
    };
    expect(refused).toEqual({ state: 'refused', reason: 'no_funded_payer', owner_id: null });

    // The admitted call's receipt arrives after the pause; it is still this request's
    // spend, so the console reports it instead of dropping it.
    insertUsage('usage-1', MODEL_REQUEST, 'case-1', { microdollars: 700 });
    const afterPause = await readPaidBenchmarkAdminRequest(db, REQUEST);
    expect(afterPause?.chargedMicrodollars).toBe(700);
    expect(afterPause?.billedModelRequests).toBe(1);
  });

  it('is idempotent and refuses to pause a closed request', async () => {
    const { env, fetchImpl } = adminEnv();
    insertRequest();
    insertCase(REQUEST, 'case-1', 'queued');
    insertModelRequest('model-request-1', 'case-1', { ownerId: 'u1' });
    await pausePaidBenchmarkAdminRequest(env, REQUEST, { fetchImpl });

    expect(await pausePaidBenchmarkAdminRequest(env, REQUEST, { fetchImpl })).toBe(
      'already_paused'
    );
    insertRequest({
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      routerId: 'aaaaaaaa-0000-4000-8000-000000000001',
      status: 'completed',
    });
    expect(
      await pausePaidBenchmarkAdminRequest(env, 'aaaaaaaa-1111-4111-8111-111111111111', {
        fetchImpl,
      })
    ).toBe('not_active');
    expect(
      await pausePaidBenchmarkAdminRequest(env, '99999999-9999-4999-8999-999999999999', {
        fetchImpl,
      })
    ).toBe('not_found');
  });
});
