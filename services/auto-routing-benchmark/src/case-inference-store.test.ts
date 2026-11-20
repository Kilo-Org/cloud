import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_CASE_INFERENCE_PATH,
  BENCHMARK_MODEL_REQUEST_ID_HEADER,
  BENCHMARK_PLATFORM_PROJECT_ID,
  benchmarkProjectId,
  type BenchmarkCaseInvocation,
} from '@kilocode/auto-routing-contracts';
import { Hono } from 'hono';
import { openPaidDatabase } from '../test/paid-benchmark-d1';
import type { HonoEnv } from './hono-env';
import { BENCHMARK_CASE_HEADER, issueCaseInferenceCapability } from './case-inference-capability';
import {
  createCaseInferenceDeps,
  handleCaseAdmit,
  handleCaseInference,
  registerCaseInferenceRoutes,
  type CaseInferenceBindings,
  type CaseInferencePayer,
} from './case-inference';
import { reconcilePaidPayerReceipts } from './paid-benchmark';

const SECRET = 'synthetic-case-inference-secret';
const GATEWAY = 'https://gateway.test';
const ORG_ID = '99999999-9999-4999-8999-999999999999';
const ROUTER_ID = '11111111-1111-4111-8111-111111111111';
const POOL_REQUEST = '55555555-5555-4555-8555-555555555555';
const AT = '2026-01-01T00:00:00.000Z';

const INVOCATION: BenchmarkCaseInvocation = {
  engineIdentity: 'engine-test',
  runId: 'run-1',
  model: 'vendor/alpha',
  variant: 'high',
  caseId: 'case-a',
  repetition: 0,
  generation: 1,
  startedAt: Date.now(),
};

type Bindings = CaseInferenceBindings;

let sqlite: ReturnType<typeof openPaidDatabase>['sqlite'];
let db: D1Database;
let bindings: Bindings;

function planJson(projectId: string): string {
  return JSON.stringify({
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
        missing: 'AQ==',
        covered: 'AA==',
        cost: [20000],
      },
    ],
    counts: { reused: 2, covered: 0, shared: 0, exclusive: 1 },
    estimateMicrodollars: 20000,
    maximumMicrodollars: 20000,
    aliases: [],
    projectId,
  });
}

function seedRun(input: { platformCovered?: boolean; benchmarkOrgId?: string | null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_case_runs
        (engine_identity, model, variant, rep, case_id, status, generation, executor_run_id,
          executor_token, platform_covered, result_usable, created_at, updated_at, started_at)
      VALUES ('engine-test', 'vendor/alpha', 'high', 0, 'case-a', 'running', 1, 'run-1',
        'token-1', ?, 0, ?, ?, ?)`
    )
    .run(input.platformCovered ? 1 : 0, AT, AT, AT);
  sqlite
    .prepare(
      `INSERT INTO benchmark_runs
        (id, router, kind, status, started_at, engine_identity, repetitions, benchmark_user_id,
          benchmark_org_id, min_accuracy, switch_cost_factor, max_concurrency)
      VALUES ('run-1', 'efficient', 'decider', 'running', ?, 'engine-test', 3, 'bench-user', ?,
        0.7, 1, 80)`
    )
    .run(AT, input.benchmarkOrgId === undefined ? ORG_ID : input.benchmarkOrgId);
}

const ORG_MEMBER = 'org-member-1';

function seedPool(
  input: {
    requestId?: string;
    ownerId?: string;
    scope?: 'user' | 'org';
    slug?: string;
    /** One live pool per router is a schema invariant, so a second candidate needs its own. */
    router?: 'efficient' | 'frontier';
    routerId?: string;
    /** The human member whose allowance funds the pool call (never the benchmark bot). */
    actorUserId?: string;
  } = {}
) {
  const scope = input.scope ?? 'user';
  const ownerId = input.ownerId ?? 'user-1';
  const requestId = input.requestId ?? POOL_REQUEST;
  const router = input.router ?? 'efficient';
  const routerId = input.routerId ?? ROUTER_ID;
  const actorUserId =
    input.actorUserId === undefined ? (scope === 'org' ? ORG_MEMBER : ownerId) : input.actorUserId;
  const projectId = benchmarkProjectId({ scope, slug: input.slug ?? 'pool-one', routerId });
  // One quote per request: a second pool in the same test must not collide on the quote id.
  const quoteId = `${requestId}-quote`;
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_quotes
        (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, context,
          plan, estimate_microdollars, maximum_microdollars, plan_cases, expires_at,
          created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pool-v1', 'engine-test', '{}', ?, 20000, 20000, 3, ?, ?, ?)`
    )
    .run(
      quoteId,
      scope === 'org' ? 'organization' : 'user',
      ownerId,
      router,
      routerId,
      planJson(projectId),
      '2026-01-02T00:00:00.000Z',
      AT,
      AT
    );
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_requests
        (id, owner_type, owner_id, router, router_id, pool_version, engine_identity, status,
          quote_id, estimate_microdollars, maximum_microdollars, plan_cases, staged_cases,
          actor_user_id, context, created_at, updated_at, activated_at)
      VALUES (?, ?, ?, ?, ?, 'pool-v1', 'engine-test', 'active', ?, 20000, 20000, 3, 3,
        ?, '{}', ?, ?, ?)`
    )
    .run(
      requestId,
      scope === 'org' ? 'organization' : 'user',
      ownerId,
      router,
      routerId,
      quoteId,
      actorUserId,
      AT,
      AT,
      AT
    );
  sqlite
    .prepare(
      `INSERT INTO paid_benchmark_request_cases
        (request_id, engine_identity, model, variant, rep, case_id, status, covered_by_kilo,
          charged_microdollars, reason, updated_at)
      VALUES (?, 'engine-test', 'vendor/alpha', 'high', 0, 'case-a', 'queued', 0, 0, NULL, ?)`
    )
    .run(requestId, AT);
}

function assignmentHeader(payer: CaseInferencePayer): Record<string, unknown> {
  const raw = payer.headers['x-kilo-benchmark-assignment'];
  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>;
}

/** A capability-signed case request for the shared invocation, reused by both suites. */
async function caseRequest(modelRequestId: string): Promise<Request> {
  const issued = await issueCaseInferenceCapability(SECRET, INVOCATION);
  return new Request(`https://bench.test${BENCHMARK_CASE_INFERENCE_PATH}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: issued.authorization,
      [BENCHMARK_CASE_HEADER]: issued.invocationHeader,
      [BENCHMARK_MODEL_REQUEST_ID_HEADER]: modelRequestId,
    },
    body: JSON.stringify({ model: 'vendor/alpha', messages: [] }),
  });
}

beforeEach(() => {
  const opened = openPaidDatabase();
  sqlite = opened.sqlite;
  db = opened.db;
  bindings = {
    BENCH_DB: db,
    KILO_WEB_API_BASE_URL: GATEWAY,
    INTERNAL_API_SECRET_PROD: {
      get: async () => SECRET,
    },
  } as unknown as Bindings;
  seedRun();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('case inference payer resolution', () => {
  it('signs a personal payer from the frozen pool project and selects without admitting', async () => {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed payer');
    expect(payer.projectId).toBe(
      benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID })
    );
    expect(payer.platformOrganizationId).toBeNull();
    expect(payer.executorUserId).toBe('bench-user');
    const assignment = assignmentHeader(payer);
    // The project and actor come from the store's own select join over the chosen request's
    // quote and `actor_user_id`; this fixture only writes the quote plan and the request row.
    expect(payer.projectId).toBe(
      benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID })
    );
    expect(assignment).toMatchObject({
      requestId: POOL_REQUEST,
      payer: { type: 'user', id: 'user-1' },
      actorUserId: 'user-1',
      executorUserId: 'bench-user',
      platformOrganizationId: null,
      projectId: payer.projectId,
    });
    // Signing must not consume the assignment: only the gateway's callback admits it.
    const row = sqlite
      .prepare(
        'SELECT state, usage_id, project_id, platform_organization_id FROM paid_model_requests'
      )
      .get() as {
      state: string;
      usage_id: string;
      project_id: string;
      platform_organization_id: string | null;
    };
    expect(row.state).toBe('selecting');
    expect(row.usage_id).toBe(payer.usageId);
    expect(row.project_id).toBe(payer.projectId);
    expect(row.platform_organization_id).toBeNull();
  });

  it('signs an organization payer with the human funding member as actor, not the bot', async () => {
    seedPool({ scope: 'org', ownerId: ORG_ID, actorUserId: ORG_MEMBER });
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed org payer');
    const assignment = assignmentHeader(payer) as {
      actorUserId: string;
      executorUserId: string;
      payer: { type: string; id: string };
      projectId: string;
    };
    // Three distinct facts: the funding member acts, the bot executes, the org pays.
    expect(assignment.actorUserId).toBe(ORG_MEMBER);
    expect(assignment.executorUserId).toBe('bench-user');
    expect(assignment.actorUserId).not.toBe(assignment.executorUserId);
    expect(assignment.payer).toEqual({ type: 'organization', id: ORG_ID });
    expect(assignment.projectId).toBe(
      benchmarkProjectId({ scope: 'org', slug: 'pool-one', routerId: ROUTER_ID })
    );
    // The stored row carries the run's executor, not the actor.
    const stored = sqlite
      .prepare('SELECT executor_user_id, project_id FROM paid_model_requests')
      .get() as { executor_user_id: string; project_id: string };
    expect(stored.executor_user_id).toBe('bench-user');
    expect(stored.project_id).toBe(payer.projectId);
  });

  it('never signs an organization payer whose request has no actor', async () => {
    seedPool({ scope: 'org', actorUserId: '' });
    const resolved = await createCaseInferenceDeps(bindings);
    const result = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    expect(result).toBeNull();
  });

  it('signs a standalone platform case from the run snapshot with no pool request', async () => {
    sqlite.prepare('UPDATE benchmark_case_runs SET platform_covered = 1').run();
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'responses',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed platform payer');
    expect(payer.requestId).toBeNull();
    expect(payer.platformOrganizationId).toBe(ORG_ID);
    expect(payer.projectId).toBe(BENCHMARK_PLATFORM_PROJECT_ID);
    const assignment = assignmentHeader(payer);
    expect(assignment).toMatchObject({
      requestId: null,
      payer: null,
      projectId: BENCHMARK_PLATFORM_PROJECT_ID,
      platformOrganizationId: ORG_ID,
      actorUserId: 'bench-user',
      executorUserId: 'bench-user',
    });
  });

  it('admits a stamped pool permit only for the actor and executor it was signed for', async () => {
    seedPool({ scope: 'org', actorUserId: ORG_MEMBER });
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed org payer');
    const body = { phase: 'admit', assignment: assignmentHeader(payer), usageId: payer.usageId };

    // Re-signing the same attempt with the bot as the actor must be refused.
    const wrongActor = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
      ...body,
      assignment: { ...body.assignment, actorUserId: 'bench-user' },
    });
    expect(await wrongActor.json()).toEqual({
      decision: 'refuse',
      reason: 'attempt_superseded',
      retryable: false,
    });
    // A wrong executor is refused the same way.
    const wrongExecutor = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
      ...body,
      assignment: { ...body.assignment, executorUserId: ORG_MEMBER },
    });
    expect(await wrongExecutor.json()).toEqual({
      decision: 'refuse',
      reason: 'attempt_superseded',
      retryable: false,
    });
    // The exact signed attempt still admits.
    const ok = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, body);
    expect(await ok.json()).toEqual({ decision: 'admit' });
  });

  it('refuses a platform case whose run snapshot names no organization', async () => {
    sqlite.exec('DELETE FROM benchmark_runs');
    sqlite.prepare('UPDATE benchmark_case_runs SET platform_covered = 1').run();
    const resolved = await createCaseInferenceDeps(bindings);
    const result = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'responses',
      modelRequestId: crypto.randomUUID(),
    });
    expect(result).toBeNull();
  });
});

describe('one signed permit per logical call', () => {
  /**
   * The whole positive path through the real store: select → sign → admit. Every payer kind
   * ends in exactly one `admit` for one model request, and a duplicate delivery of that same
   * assignment is refused without changing the ledger.
   */
  async function assertSinglePermit(label: string, modelRequestId: string) {
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId,
    });
    if (!payer || 'refused' in payer) throw new Error(`${label}: expected a signed payer`);
    const body = {
      phase: 'admit' as const,
      assignment: assignmentHeader(payer),
      usageId: payer.usageId,
    };
    expect(await (await handleCaseAdmit(bindings, `Bearer ${SECRET}`, body)).json()).toEqual({
      decision: 'admit',
    });
    // The same logical call delivered twice: one permit total, nothing changed.
    const duplicate = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, body);
    expect(await duplicate.json()).toEqual({
      decision: 'refuse',
      reason: 'duplicate_attempt',
      retryable: false,
    });
    const row = sqlite
      .prepare('SELECT state, assignment_id, usage_id FROM paid_model_requests WHERE id = ?')
      .get(modelRequestId) as { state: string; assignment_id: string; usage_id: string };
    expect(row).toEqual({
      state: 'admitted',
      assignment_id: payer.assignmentId,
      usage_id: payer.usageId,
    });
    const accepted = sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM paid_model_request_attempts WHERE model_request_id = ? AND status = 'accepted'"
      )
      .get(modelRequestId) as { c: number };
    expect(accepted.c).toBe(1);
    return payer;
  }

  it('admits a personal permit exactly once', async () => {
    seedPool();
    const payer = await assertSinglePermit('personal', crypto.randomUUID());
    expect(payer.requestId).toBe(POOL_REQUEST);
    // The eligibility row is the account that will be charged, created by the admit itself.
    expect(
      sqlite
        .prepare(
          "SELECT owner_type, owner_id, status FROM benchmark_case_payers WHERE status = 'accepted'"
        )
        .get()
    ).toEqual({ owner_type: 'user', owner_id: 'user-1', status: 'accepted' });
  });

  it('admits an organization permit exactly once for the funding member', async () => {
    seedPool({ scope: 'org', ownerId: ORG_ID, actorUserId: ORG_MEMBER });
    const payer = await assertSinglePermit('organization', crypto.randomUUID());
    // Three distinct facts on the signed envelope: the funding member acts, the bot
    // executes, the organization pays.
    expect(assignmentHeader(payer)).toMatchObject({
      payer: { type: 'organization', id: ORG_ID },
      actorUserId: ORG_MEMBER,
      executorUserId: 'bench-user',
    });
  });

  it('admits a standalone platform permit exactly once with no pool request', async () => {
    sqlite.prepare('UPDATE benchmark_case_runs SET platform_covered = 1').run();
    const payer = await assertSinglePermit('platform', crypto.randomUUID());
    expect(payer.requestId).toBeNull();
    expect(payer.platformOrganizationId).toBe(ORG_ID);
    expect(payer.projectId).toBe(BENCHMARK_PLATFORM_PROJECT_ID);
    // The platform pays: no pool eligibility row is created for it.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM benchmark_case_payers').get() as { c: number }).c
    ).toBe(0);
  });

  it('refuses a second permit for the same case while an earlier one is still unspent', async () => {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const first = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!first || 'refused' in first) throw new Error('expected a signed payer');
    const admitted = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
      phase: 'admit',
      assignment: assignmentHeader(first),
      usageId: first.usageId,
    });
    expect(await admitted.json()).toEqual({ decision: 'admit' });

    // A second logical call of the same case: selection may sign a candidate, but the store's
    // admit is the fence — one unspent permit per account — so a second provider call can
    // never be authorized while the first native receipt is outstanding.
    const second = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!second || 'refused' in second) throw new Error('expected a second selection attempt');
    const refused = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
      phase: 'admit',
      assignment: assignmentHeader(second),
      usageId: second.usageId,
    });
    expect(await refused.json()).toEqual({
      decision: 'refuse',
      reason: 'outstanding_receipt',
      retryable: true,
    });
    // Exactly one permit exists for the case.
    expect(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS c FROM paid_model_requests WHERE state = 'admitted'")
          .get() as { c: number }
      ).c
    ).toBe(1);
  });
});

describe('case admission callback', () => {
  async function signedPayer() {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed payer');
    return payer;
  }

  function admitBody(payer: CaseInferencePayer) {
    return { phase: 'admit', assignment: assignmentHeader(payer), usageId: payer.usageId };
  }

  it('admits exactly once and refuses a duplicate delivery', async () => {
    const payer = await signedPayer();
    const first = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, admitBody(payer));
    expect(await first.json()).toEqual({ decision: 'admit' });
    const duplicate = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, admitBody(payer));
    expect(await duplicate.json()).toEqual({
      decision: 'refuse',
      reason: 'duplicate_attempt',
      retryable: false,
    });
  });

  it('refuses an assignment whose signed identity is not the selected row', async () => {
    const payer = await signedPayer();
    const body = admitBody(payer);
    const tampered = { ...body, assignment: { ...body.assignment, usageId: crypto.randomUUID() } };
    const refused = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, tampered);
    expect(await refused.json()).toEqual({
      decision: 'refuse',
      reason: 'attempt_superseded',
      retryable: false,
    });
    // The untouched assignment still admits: the tampered call changed nothing.
    const ok = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, body);
    expect(await ok.json()).toEqual({ decision: 'admit' });
  });

  it('refuses an unauthenticated callback', async () => {
    const payer = await signedPayer();
    const refused = await handleCaseAdmit(bindings, 'Bearer wrong', admitBody(payer));
    expect(refused.status).toBe(401);
  });
});

describe('case inference end to end through the store (A/B, refusal rotation)', () => {
  function gatewayReply(kind: 'refused' | 'admitted', reason = 'payment_refused'): Response {
    if (kind === 'refused')
      return new Response(JSON.stringify({ error: { code: 'benchmark_payer_refused', reason } }), {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'x-kilo-benchmark-admission': 'refused',
        },
      });
    return new Response('data: ok\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-kilo-benchmark-admission': 'admitted' },
    });
  }

  it('refuses the first payer and dispatches the next one from the same store row', async () => {
    seedPool();
    // A second paying pool makes two candidates for the same case run. One live pool per
    // router is the schema invariant, so the second pool belongs to the other router.
    seedPool({
      requestId: '55555555-5555-4555-8555-555555555556',
      ownerId: 'user-2',
      slug: 'pool-two',
      router: 'frontier',
      routerId: '22222222-2222-4222-8222-222222222222',
    });
    const replies = [gatewayReply('refused'), gatewayReply('admitted')];
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const raw = headers['x-kilo-benchmark-assignment'];
      const assignment = JSON.parse(
        Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      ) as { payer: { id: string } };
      requested.push(assignment.payer.id);
      const next = replies.shift();
      if (!next) throw new Error('unexpected extra upstream call');
      return next;
    });

    const resolved = await createCaseInferenceDeps(bindings);
    const modelRequestId = crypto.randomUUID();
    const response = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(modelRequestId), db }
    );
    expect(response.status).toBe(200);
    // Both candidates were tried in turn, never the same assignment twice.
    expect(requested).toHaveLength(2);
    expect(new Set(requested).size).toBe(2);
    const attempt = sqlite
      .prepare('SELECT status, reason FROM paid_model_request_attempts ORDER BY ordinal')
      .all() as { status: string; reason: string | null }[];
    expect(attempt.map(row => row.status)).toEqual(['refused', 'selected']);
    // The refused account is detached for this generation, so the next case request skips it.
    const detached = sqlite
      .prepare("SELECT owner_id FROM benchmark_case_payers WHERE status = 'detached'")
      .all() as { owner_id: string }[];
    expect(detached).toHaveLength(1);
  });

  it('stops with its own no_payer verdict when the only payer refuses after an earlier call billed', async () => {
    // A previous logical call of this case already billed; this later call is refused. The
    // earlier charge stands, and the refusal becomes a canonical Worker stop rather than the
    // gateway's body, so the runner pauses instead of grading a partial transcript.
    seedPool();
    sqlite
      .prepare(
        `INSERT INTO paid_model_requests
          (id, engine_identity, model, variant, rep, case_id, generation, pool_request_id, state,
            assignment_id, owner_type, owner_id, platform_covered, usage_id, project_id, api,
            executor_user_id, created_at, updated_at)
        VALUES ('11111111-1111-4111-8111-aaaaaaaaaaaa', 'engine-test', 'vendor/alpha', 'high', 0,
          'case-a', 1, ?, 'accepted', '22222222-2222-4222-8222-bbbbbbbbbbbb', 'user', 'user-1', 0,
          '33333333-3333-4333-8333-cccccccccccc', ?, 'chat/completions', 'bench-user', ?, ?)`
      )
      .run(
        POOL_REQUEST,
        benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID }),
        AT,
        AT
      );
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'benchmark_payer_refused', reason: 'payment_refused' } }),
          {
            status: 402,
            headers: {
              'content-type': 'application/json',
              'x-kilo-benchmark-admission': 'refused',
            },
          }
        )
    );
    const resolved = await createCaseInferenceDeps(bindings);
    const response = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );
    // One candidate existed and it refused: our verdict, not a replay of the gateway body.
    expect(response.status).toBe(402);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('no_payer');
    expect(await response.json()).toMatchObject({ error: { code: 'no_payer' } });
    // The earlier call is untouched: it still holds its own usage and was not reopened.
    expect(
      sqlite
        .prepare(
          "SELECT state, usage_id FROM paid_model_requests WHERE id = '11111111-1111-4111-8111-aaaaaaaaaaaa'"
        )
        .get()
    ).toEqual({ state: 'accepted', usage_id: '33333333-3333-4333-8333-cccccccccccc' });
  });

  it('stops a permanently failed pair without selecting or detaching a payer', async () => {
    seedPool();
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (model, variant, engine_identity, repetitions, status, failure_reason, requested_at,
            updated_at)
        VALUES ('vendor/alpha', 'high', 'engine-test', 3, 'unavailable',
          'Model or variant is unavailable in the executable benchmark catalog.', ?, ?)`
      )
      .run(AT, AT);
    const resolved = await createCaseInferenceDeps(bindings);
    const upstreamCalls: string[] = [];
    const response = await handleCaseInference(
      {
        ...resolved,
        fetchImpl: (async () => {
          upstreamCalls.push('call');
          throw new Error('no provider call may happen');
        }) as unknown as typeof fetch,
      },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('model_permanently_failed');
    expect(upstreamCalls).toHaveLength(0);
    // No selection was written and no account was blamed for a terminal model state.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM paid_model_requests').get() as { c: number }).c
    ).toBe(0);
    expect(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS c FROM benchmark_case_payers WHERE status = 'detached'")
          .get() as { c: number }
      ).c
    ).toBe(0);
  });

  it('keeps an admitted call terminal on a raw provider 402', async () => {
    seedPool();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { code: 'provider_payment_failed' } }), {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'x-kilo-benchmark-admission': 'admitted',
          },
        })
    );
    const resolved = await createCaseInferenceDeps(bindings);
    let upstreamCalls = 0;
    const response = await handleCaseInference(
      {
        ...resolved,
        fetchImpl: (async () => {
          upstreamCalls += 1;
          return fetch('https://gateway.test');
        }) as unknown as typeof fetch,
      },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );
    expect(response.status).toBe(402);
    expect(upstreamCalls).toBe(1);
    expect(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS c FROM benchmark_case_payers WHERE status = 'detached'")
          .get() as { c: number }
      ).c
    ).toBe(0);
  });
});

describe('one payer, two consecutive model requests, no cron', () => {
  /** The recorded native usage the gateway's primary already has for an earlier call. */
  function recordedReceipt(payer: CaseInferencePayer, microdollars: number) {
    return {
      usageId: payer.usageId,
      status: 'recorded' as const,
      microdollars,
      payerType: payer.ownerType,
      payerId: payer.ownerId,
      projectId: payer.projectId,
      requestedModel: 'vendor/alpha',
      model: 'vendor/alpha',
      createdAt: AT,
    };
  }

  /** Answers the receipt read; any other request is a provider call, which must not happen. */
  function stubReceipts(recorded: ReturnType<typeof recordedReceipt>[]) {
    const order: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (!href.includes('/api/internal/usage/receipts')) {
        order.push('provider');
        throw new Error(`unexpected provider call: ${href}`);
      }
      if (typeof init?.body !== 'string') throw new Error('receipt body was not a string');
      const asked = JSON.parse(init.body) as { usageIds: string[] };
      order.push(`receipts:${asked.usageIds.join(',')}`);
      const byId = new Map(recorded.map(receipt => [receipt.usageId, receipt]));
      return new Response(
        JSON.stringify({
          receipts: asked.usageIds.flatMap(id => {
            const receipt = byId.get(id);
            return receipt ? [receipt] : [];
          }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    return order;
  }

  it('reconciles the payer before the gateway reads credit, so the next call can be admitted', async () => {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const firstModelRequest = crypto.randomUUID();
    const first = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: firstModelRequest,
    });
    if (!first || 'refused' in first) throw new Error('expected the first permit');
    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(first),
          usageId: first.usageId,
        })
      ).json()
    ).toEqual({ decision: 'admit' });

    // The native usage committed in PostgreSQL; this Worker has not booked it yet.
    const order = stubReceipts([recordedReceipt(first, 2_000)]);
    let forwards = 0;
    const second = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!second || 'refused' in second) throw new Error('expected the second selection');
    const secondBody = {
      phase: 'admit' as const,
      assignment: assignmentHeader(second),
      usageId: second.usageId,
    };
    const response = await handleCaseInference(
      {
        ...resolved,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          // The handler's own upstream is the gateway: assert the receipt read already ran.
          if (!String(url).includes('/api/internal/usage/receipts')) {
            forwards += 1;
            return new Response('data: ok\n\n', {
              status: 200,
              headers: {
                'content-type': 'text/event-stream',
                'x-kilo-benchmark-admission': 'admitted',
              },
            });
          }
          return fetch(url, init);
        }) as unknown as typeof fetch,
      },
      {
        api: 'chat/completions',
        request: await caseRequest(crypto.randomUUID()),
        db,
      }
    );
    await response.text();
    // The reconcile ran exactly once, for the earlier usage, before the gateway was called.
    expect(order).toEqual([`receipts:${first.usageId}`]);
    expect(forwards).toBe(1);
    // The earlier permit is booked and closed; the gateway saw a payer with nothing unspent.
    expect(
      sqlite.prepare('SELECT state FROM paid_model_requests WHERE id = ?').get(firstModelRequest)
    ).toEqual({ state: 'completed' });
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS c FROM paid_attempt_usage WHERE usage_id = ?')
          .get(first.usageId) as { c: number }
      ).c
    ).toBe(1);
    // Only after that booking can the second logical request be admitted.
    expect(await (await handleCaseAdmit(bindings, `Bearer ${SECRET}`, secondBody)).json()).toEqual({
      decision: 'admit',
    });
  });

  it('never admits a second call on a stale read when a prior debit lands after the first validation', async () => {
    // Main's race: the gateway validates credit, then an earlier debit commits. Reconciling
    // and granting inside the admit callback would authorize a provider call the payer cannot
    // fund. Ordering the reconcile before every credit read removes the stale read instead.
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const firstModelRequest = crypto.randomUUID();
    const first = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: firstModelRequest,
    });
    if (!first || 'refused' in first) throw new Error('expected the first permit');
    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(first),
          usageId: first.usageId,
        })
      ).json()
    ).toEqual({ decision: 'admit' });

    // The debit commits upstream only now, i.e. after the first call's admission validation.
    const order = stubReceipts([recordedReceipt(first, 2_000)]);
    const second = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!second || 'refused' in second) throw new Error('expected the second selection');
    const secondBody = {
      phase: 'admit' as const,
      assignment: assignmentHeader(second),
      usageId: second.usageId,
    };
    // The store still sees the earlier permit as unbooked, so a callback that trusted its own
    // earlier read would grant. It must refuse with a typed, retryable receipt answer…
    const staleAttempt = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, secondBody);
    expect(await staleAttempt.json()).toEqual({
      decision: 'refuse',
      reason: 'outstanding_receipt',
      retryable: true,
    });
    // …and the row stays `selecting`, so no provider call was authorized and the original
    // admitted usage id is untouched.
    expect(
      sqlite
        .prepare('SELECT state FROM paid_model_requests WHERE id = ?')
        .get(second.modelRequestId)
    ).toEqual({ state: 'selecting' });
    expect(
      sqlite
        .prepare('SELECT state, usage_id FROM paid_model_requests WHERE id = ?')
        .get(firstModelRequest)
    ).toEqual({ state: 'admitted', usage_id: first.usageId });
    // No provider call happened on either refused path.
    expect(order).toEqual([]);

    // The retry must go through a fresh gateway credit read, so the reconcile has to happen
    // before it. Prove the ordering directly: the exact payer is reconciled, and no provider
    // call is authorized until the gateway answers again.
    await resolved.reconcilePayer!(second);
    expect(order).toEqual([`receipts:${first.usageId}`]);
    // The earlier permit is now booked and closed, so a fresh call would read a balance that
    // already reflects the debit. The Worker never grants from its own view: the row below is
    // still `selecting`, i.e. no permit was handed out on the stale read.
    expect(
      sqlite
        .prepare('SELECT state FROM paid_model_requests WHERE id = ?')
        .get(second.modelRequestId)
    ).toEqual({ state: 'selecting' });
    // The prior call's identity and usage are untouched: nothing was reassigned or replayed.
    expect(
      sqlite
        .prepare('SELECT state, usage_id FROM paid_model_requests WHERE id = ?')
        .get(firstModelRequest)
    ).toEqual({ state: 'completed', usage_id: first.usageId });
    // And the prior debit was booked exactly once — never a second charge for it.
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS c FROM paid_attempt_usage WHERE usage_id = ?')
          .get(first.usageId) as { c: number }
      ).c
    ).toBe(1);
  });
});

describe('case inference route drain under a real execution context', () => {
  it('wires c.executionCtx.waitUntil so a cancelled runner still drains the provider stream', async () => {
    seedPool();
    const background: Promise<unknown>[] = [];
    let pulled = 0;
    let finished = false;
    const providerBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulled += 1;
        if (pulled <= 3) {
          controller.enqueue(new TextEncoder().encode(`data: chunk-${pulled}\n\n`));
          return;
        }
        finished = true;
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(providerBody, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-kilo-benchmark-admission': 'admitted',
          },
        })
    );

    const issued = await issueCaseInferenceCapability(SECRET, INVOCATION);
    const routeRequest = new Request(
      `https://bench.test${BENCHMARK_CASE_INFERENCE_PATH}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: issued.authorization,
          [BENCHMARK_CASE_HEADER]: issued.invocationHeader,
          [BENCHMARK_MODEL_REQUEST_ID_HEADER]: crypto.randomUUID(),
        },
        body: JSON.stringify({ model: 'vendor/alpha', messages: [] }),
      }
    );
    const app = new Hono<HonoEnv>();
    registerCaseInferenceRoutes(app);
    // The real execution context, not an injected waitUntil: this is what production uses.
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await app.request(
      routeRequest,
      undefined,
      bindings as unknown as Env,
      executionCtx
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(finished).toBe(true);
    expect(pulled).toBeGreaterThan(3);
  });
});

describe('outstanding receipt: one payer chains two logical calls', () => {
  const RECEIPTS_PATH = '/api/internal/usage/receipts';

  /**
   * A stand-in for the real gateway. It consults the real admit callback for every forward,
   * exactly as production does, so the store's own gates decide each answer instead of a
   * canned reply. Only the native receipt read is synthetic.
   */
  function simulateGateway(options: {
    /** `read` is 1-based, so a test can make the receipt appear on a later actual read. */
    receipt: (read: number) => Record<string, unknown>;
    onRefusal?: (reason: string) => void;
  }) {
    const forwarded: string[] = [];
    let receiptReads = 0;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes(RECEIPTS_PATH)) {
        if (typeof init?.body !== 'string') throw new Error('receipt body was not a string');
        const asked = JSON.parse(init.body) as { usageIds: string[] };
        receiptReads += 1;
        const receipt = options.receipt(receiptReads);
        return Response.json({
          receipts: asked.usageIds.map(usageId => ({ ...receipt, usageId })),
        });
      }
      const headers = init?.headers as Record<string, string>;
      const assignment = JSON.parse(
        Buffer.from(
          headers['x-kilo-benchmark-assignment'].replace(/-/g, '+').replace(/_/g, '/'),
          'base64'
        ).toString('utf8')
      ) as { modelRequestId: string; usageId: string };
      forwarded.push(assignment.modelRequestId);
      const admit = await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
        phase: 'admit',
        assignment,
        usageId: assignment.usageId,
      });
      const decision = (await admit.json()) as
        | { decision: 'admit' }
        | { decision: 'refuse'; reason: string; retryable: boolean };
      if (decision.decision === 'admit')
        return new Response('data: ok\n\n', {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-kilo-benchmark-admission': 'admitted',
          },
        });
      options.onRefusal?.(decision.reason);
      return new Response(
        JSON.stringify({
          error: {
            code: 'benchmark_payer_refused',
            reason: decision.reason,
            retryable: decision.retryable,
          },
        }),
        {
          status: decision.retryable ? 409 : 402,
          headers: {
            'content-type': 'application/json',
            'x-kilo-benchmark-admission': 'refused',
          },
        }
      );
    });
    return forwarded;
  }

  /** The receipt for whichever permit is currently admitted, in the shape the reader expects. */
  function pendingOrRecorded(recorded: boolean): Record<string, unknown> {
    const row = sqlite
      .prepare(
        `SELECT usage_id, owner_type, owner_id, project_id FROM paid_model_requests
        WHERE state IN ('admitted', 'completed') ORDER BY created_at, id LIMIT 1`
      )
      .get() as {
      usage_id: string;
      owner_type: string;
      owner_id: string;
      project_id: string;
    } | null;
    if (row === null) throw new Error('no permit to receipt');
    return {
      usageId: row.usage_id,
      status: recorded ? 'recorded' : 'pending',
      microdollars: recorded ? 2_000 : null,
      payerType: row.owner_type,
      payerId: row.owner_id,
      projectId: row.project_id,
      requestedModel: 'vendor/alpha',
      model: 'vendor/alpha',
      createdAt: AT,
    };
  }

  function permitCounts() {
    const one = <T>(sql: string, ...args: string[]): T => sqlite.prepare(sql).get(...args) as T;
    return {
      usage: one<{ c: number }>('SELECT COUNT(*) AS c FROM paid_attempt_usage').c,
      admitted: one<{ c: number }>(
        "SELECT COUNT(*) AS c FROM paid_model_requests WHERE state = 'admitted'"
      ).c,
      detached: one<{ c: number }>(
        "SELECT COUNT(*) AS c FROM benchmark_case_payers WHERE status = 'detached'"
      ).c,
    };
  }

  /**
   * Insert an already-admitted permit directly, so a test can place one outside the case under
   * test — the guard is the pool account's row set, not a per-case one.
   */
  function seedAdmittedPermit(
    input: {
      caseId?: string;
      ownerId?: string;
      platform?: boolean;
    } = {}
  ): void {
    const platform = input.platform === true;
    sqlite
      .prepare(
        `INSERT INTO paid_model_requests (
          id, engine_identity, model, variant, rep, case_id, generation, pool_request_id, state,
          assignment_id, owner_type, owner_id, platform_covered, platform_organization_id,
          usage_id, project_id, api, executor_user_id, created_at, updated_at
        ) VALUES (?, 'engine-test', 'vendor/alpha', 'high', 0, ?, 1, ?, 'admitted', ?, ?, ?, ?, ?, ?,
          ?, 'chat/completions', 'bench-user', ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.caseId ?? 'case-a',
        platform ? null : POOL_REQUEST,
        crypto.randomUUID(),
        platform ? null : 'user',
        platform ? null : (input.ownerId ?? 'user-1'),
        platform ? 1 : 0,
        platform ? ORG_ID : null,
        crypto.randomUUID(),
        platform
          ? BENCHMARK_PLATFORM_PROJECT_ID
          : benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID }),
        AT,
        AT
      );
  }

  it('blocks on the same payer outstanding permit from a different slot', async () => {
    // The authoritative guard is the pool account's own row set, not this case's: an unspent
    // permit from any slot would still let the gateway fund two calls against one balance.
    seedPool();
    seedAdmittedPermit({ caseId: 'case-from-another-slot' });
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed payer');

    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(payer),
          usageId: payer.usageId,
        })
      ).json()
    ).toEqual({ decision: 'refuse', reason: 'outstanding_receipt', retryable: true });
  });

  it('never blocks on a platform-covered permit, so Kilo multi-call work is untouched', async () => {
    // Platform coverage bypasses the pool-account guard, so an unbooked platform permit must
    // not make a platform call wait — that is automatic Kilo-paid work.
    sqlite.prepare('UPDATE benchmark_case_runs SET platform_covered = 1').run();
    seedAdmittedPermit({ platform: true });
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed platform payer');
    expect(payer.platformOrganizationId).toBe(ORG_ID);

    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(payer),
          usageId: payer.usageId,
        })
      ).json()
    ).toEqual({ decision: 'admit' });
  });

  it('never blocks a distinct payer on someone else permit', async () => {
    // An outstanding permit belongs to user-1; the pool under test is funded by user-2.
    seedPool({ ownerId: 'user-2' });
    seedAdmittedPermit({ ownerId: 'user-1' });
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed payer');
    expect(payer.ownerId).toBe('user-2');

    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(payer),
          usageId: payer.usageId,
        })
      ).json()
    ).toEqual({ decision: 'admit' });
  });

  it('aborts the native receipt read when the caller aborts', async () => {
    // The read is bounded by the caller's abort, so a hung native fetch cannot outlive the
    // request. The fake never resolves on its own: only the abort can settle this test, so it
    // cannot pass by timing luck and it needs no fixed sleep.
    seedPool();
    seedAdmittedPermit();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let seen: AbortSignal | undefined;
    const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      const settled = Promise.withResolvers<Response>();
      const fail = () => settled.reject(new Error('aborted'));
      if (init?.signal?.aborted === true) fail();
      else init?.signal?.addEventListener('abort', fail, { once: true });
      started.resolve();
      return settled.promise;
    }) as unknown as typeof fetch;

    const pending = reconcilePaidPayerReceipts(bindings, {
      ownerType: 'user',
      ownerId: 'user-1',
      fetchImpl: hangingFetch,
      signal: controller.signal,
      deadline: Date.now() + 60_000,
    });
    await started.promise;
    controller.abort();
    const summary = await pending;

    // The abort reached the actual native request, and nothing was booked from a read that
    // never completed.
    expect(seen?.aborted).toBe(true);
    expect(summary).toEqual({ recorded: 0, pending: 0, mismatched: 0 });
  });

  it('answers outstanding_receipt only when a prior unbooked permit really blocks', async () => {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const first = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!first || 'refused' in first) throw new Error('expected the first permit');
    // Admit the first call so it holds an unbooked permit for this payer.
    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(first),
          usageId: first.usageId,
        })
      ).json()
    ).toEqual({ decision: 'admit' });

    const second = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!second || 'refused' in second) throw new Error('expected the second selection');
    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(second),
          usageId: second.usageId,
        })
      ).json()
    ).toEqual({ decision: 'refuse', reason: 'outstanding_receipt', retryable: true });
  });

  it('answers admission_unavailable, not outstanding_receipt, for an unrelated block', async () => {
    // Same code path, no prior permit: the pool stopped being active, so nothing about a
    // receipt explains the refusal and the caller must not reconcile for it.
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const payer = await resolved.resolvePayer!({
      invocation: INVOCATION,
      api: 'chat/completions',
      modelRequestId: crypto.randomUUID(),
    });
    if (!payer || 'refused' in payer) throw new Error('expected a signed payer');
    sqlite.prepare("UPDATE paid_benchmark_requests SET status = 'paused'").run();

    expect(
      await (
        await handleCaseAdmit(bindings, `Bearer ${SECRET}`, {
          phase: 'admit',
          assignment: assignmentHeader(payer),
          usageId: payer.usageId,
        })
      ).json()
    ).toEqual({ decision: 'refuse', reason: 'admission_unavailable', retryable: true });
  });

  it('waits for the earlier receipt, then forwards the same logical call once', async () => {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    // The native usage is absent on the first actual read and available on the second: the
    // gating this test exists for. Nothing flips it on a refusal — only a real re-read can.
    const forwarded = simulateGateway({
      receipt: read => pendingOrRecorded(read > 1),
    });

    const firstCall = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );
    expect(firstCall.headers.get('x-kilo-benchmark-admission')).toBe('admitted');
    await firstCall.text();
    // Admitted but unbooked: exactly the state that would block the next call.
    expect(permitCounts()).toEqual({ usage: 0, admitted: 1, detached: 0 });

    const secondModelRequest = crypto.randomUUID();
    const secondCall = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(secondModelRequest), db }
    );

    // The second call is admitted after a single forward: the receipt was booked while
    // waiting, so the gateway never saw a stale refusal and nothing was replayed.
    expect(secondCall.headers.get('x-kilo-benchmark-admission')).toBe('admitted');
    expect(secondCall.headers.get('x-kilo-benchmark-stop')).toBeNull();
    await secondCall.text();
    expect(forwarded).toHaveLength(2);
    expect(forwarded.filter(id => id === secondModelRequest)).toHaveLength(1);

    // The earlier receipt is booked exactly once and closed; the new call is the only live
    // permit; nobody was detached for a lagging receipt.
    expect(permitCounts()).toEqual({ usage: 1, admitted: 1, detached: 0 });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS c FROM paid_model_requests WHERE state = 'completed'")
        .get()
    ).toEqual({ c: 1 });
  }, 30_000);

  it('never forwards while the prior receipt is unbooked, and keeps it pending', async () => {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const forwarded = simulateGateway({ receipt: () => pendingOrRecorded(false) });

    const firstCall = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );
    await firstCall.text();
    const forwardsAfterFirst = forwarded.length;

    const secondCall = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );

    // Zero forwards for the blocked call: waiting never opens a provider call, and there is
    // no replay to fall back on.
    expect(forwarded).toHaveLength(forwardsAfterFirst);
    expect(secondCall.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    expect(await secondCall.json()).toMatchObject({ error: { code: 'receipt_unconfirmed' } });
    // The old call stays pending and un-detached; nothing was graded or charged twice.
    expect(permitCounts()).toEqual({ usage: 0, admitted: 1, detached: 0 });
  }, 60_000);

  it('never retries when the refusal is an ordinary admission_unavailable', async () => {
    // A lost or unclassifiable reply proves nothing about the payer, so it must not trigger
    // the receipt retry: exactly one forward, then a stop.
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    let forwards = 0;
    vi.stubGlobal('fetch', async () => {
      // Count every gateway forward so a retry would be visible.
      forwards += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 'benchmark_payer_refused',
            reason: 'admission_unavailable',
            retryable: true,
          },
        }),
        {
          status: 409,
          headers: {
            'content-type': 'application/json',
            'x-kilo-benchmark-admission': 'refused',
          },
        }
      );
    });

    const response = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );

    // Exactly one attempt: no receipt retry for an unprovable refusal.
    expect(forwards).toBe(1);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    expect(permitCounts()).toEqual({ usage: 0, admitted: 0, detached: 0 });
  }, 30_000);

  it('keeps the pause latch authoritative instead of retrying through it', async () => {
    seedPool();
    const resolved = await createCaseInferenceDeps(bindings);
    const forwarded = simulateGateway({ receipt: () => pendingOrRecorded(false) });
    const firstCall = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );
    await firstCall.text();
    const forwardsBefore = forwarded.length;

    // The case is paused: the retry must not be a way around the latch.
    sqlite.prepare("UPDATE benchmark_case_runs SET status = 'paused'").run();

    const response = await handleCaseInference(
      { ...resolved, fetchImpl: fetch },
      { api: 'chat/completions', request: await caseRequest(crypto.randomUUID()), db }
    );

    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('not_live');
    expect(forwarded).toHaveLength(forwardsBefore);
  }, 30_000);
});
