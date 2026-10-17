import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  CUSTOM_ROUTER_EVAL_RESULT_PATH,
  CustomRouterErrorResponseSchema,
  customRouterEntryRef,
  type BenchmarkConfig,
  type ClientCustomRouterEntry,
  type InternalClientEvalResultRequest,
} from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import * as z from 'zod';
import { runDeciderCaseViaCli } from './cli-runner';
import {
  ClientEvalError,
  clientEvalCase,
  gradeClientEvalResult,
  planClientEval,
  type ClientEvalDeps,
} from './client-eval';
import {
  listOwnerClientProfiles,
  refreshClientProfileRollup,
  rollUpClientCases,
} from './client-profiles';
import { saveBenchmarkConfig } from './config';
import { DECIDER_CASES, type DeciderCase } from './datasets/decider-cases';
import type { DeciderJudge } from './grading';
import { app } from './index';
import { computeEngineIdentity } from './run';

const CONFIG: BenchmarkConfig = {
  router: 'efficient',
  accuracyNoiseBand: 0.05,
  frontierMinAccuracyDelta: 0,
  classifierModels: ['typesafe/jev-1.13'],
  deciderModels: [{ id: 'vendor/platform' }],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  lowConfidenceThreshold: null,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  classifierRepetitions: 1,
  deciderRepetitions: 2,
  classifierMaxP95LatencyMs: 1000,
  updatedAt: null,
  updatedBy: null,
};

const ENGINE = computeEngineIdentity('decider', 'efficient');
const ORG_ID = '7d1f0a6e-2c4b-4f7a-9a51-3b8e2f6c9d10';

const localModel: ClientCustomRouterEntry = {
  kind: 'client',
  provider: 'ollama',
  model: 'qwen3:32b',
  variants: ['low', 'high'],
  capabilities: {
    contextLength: 32_768,
    inputModalities: ['text'],
    toolCall: true,
    reasoning: true,
  },
  pricing: null,
};
const localKey = 'client:ollama/qwen3:32b';
const context = {
  routerId: '00000000-0000-4000-8000-000000000001',
  ownerType: 'org' as const,
  ownerId: ORG_ID,
  baseRouter: 'efficient' as const,
  entries: [localModel],
  clientEvalEntryKeys: [localKey],
};

const exactCase = DECIDER_CASES.find(c => c.check.kind === 'exact');
const judgedCase = DECIDER_CASES.find(c => c.check.kind === 'judged');
if (!exactCase || exactCase.check.kind !== 'exact' || !judgedCase) {
  throw new Error('dataset needs exact and judged cases');
}
const exactAnswer = exactCase.check.value;

function upload(
  partial: Partial<InternalClientEvalResultRequest> = {}
): InternalClientEvalResultRequest {
  return {
    ...context,
    engineIdentity: ENGINE,
    entry: customRouterEntryRef(localModel),
    variant: 'low',
    caseId: exactCase!.id,
    rep: 0,
    output: exactAnswer,
    costUsd: 0,
    durationMs: 1200,
    exitCode: 0,
    timedOut: false,
    billing: { userId: 'user-1', organizationId: ORG_ID },
    ...partial,
  };
}

describe('client eval (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let judge: Mock<DeciderJudge>;
  let writeUsage: Mock<ClientEvalDeps['writeUsage']>;
  let deps: ClientEvalDeps;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    judge = vi.fn<DeciderJudge>(async () => ({ probability: 0.75, costUsd: 0.0021 }));
    writeUsage = vi.fn<ClientEvalDeps['writeUsage']>(async usage => ({
      kind: 'recorded',
      result: { usageId: usage.core.id } as never,
    }));
    deps = {
      source: { catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' } },
      createJudge: async () => judge,
      writeUsage,
      now: () => new Date('2026-10-16T12:00:00.000Z'),
    };
  });

  it('plans every variant, case and repetition until uploaded, then only what is missing', async () => {
    const fresh = await planClientEval(db, CONFIG, context, deps.source);
    expect(fresh).toMatchObject({
      baseRouter: 'efficient',
      engineIdentity: ENGINE,
      repetitions: 2,
    });
    expect(fresh.items).toHaveLength(2 * 2 * DECIDER_CASES.length);

    await gradeClientEvalResult(db, CONFIG, upload(), deps);
    await gradeClientEvalResult(db, CONFIG, upload({ rep: 1 }), deps);
    await gradeClientEvalResult(db, CONFIG, upload({ variant: 'high' }), deps);

    const resumed = await planClientEval(db, CONFIG, context, deps.source);
    expect(resumed.items).toHaveLength(fresh.items.length - 3);
    const planned = new Set(resumed.items.map(i => JSON.stringify([i.variant, i.caseId, i.rep])));
    expect(planned.has(JSON.stringify(['low', exactCase.id, 0]))).toBe(false);
    expect(planned.has(JSON.stringify(['low', exactCase.id, 1]))).toBe(false);
    expect(planned.has(JSON.stringify(['high', exactCase.id, 0]))).toBe(false);
    expect(planned.has(JSON.stringify(['high', exactCase.id, 1]))).toBe(true);
    expect(resumed.staleEntries).toEqual([]);
  });

  it('re-plans an older-engine measurement in full and reports it stale', async () => {
    await gradeClientEvalResult(db, CONFIG, upload(), deps);
    sqlite.exec(`UPDATE client_profiles SET engine_identity = 'efficient:v0:old'`);

    const plan = await planClientEval(db, CONFIG, context, deps.source);
    expect(plan.items).toHaveLength(2 * 2 * DECIDER_CASES.length);
    expect(plan.staleEntries).toEqual([
      { entry: { kind: 'client', provider: 'ollama', model: 'qwen3:32b' }, variant: 'low' },
    ]);
  });

  it('keeps client measurements scoped to their owner', async () => {
    await gradeClientEvalResult(db, CONFIG, upload(), deps);
    const other = await planClientEval(db, CONFIG, { ...context, ownerId: 'org-2' }, deps.source);
    expect(other.items).toHaveLength(2 * 2 * DECIDER_CASES.length);
  });

  it('grades mechanically, rolls up the profile, and returns the stored score on retry', async () => {
    expect(await gradeClientEvalResult(db, CONFIG, upload(), deps)).toEqual({ score: 1 });
    expect(
      await gradeClientEvalResult(
        db,
        CONFIG,
        upload({ rep: 1, output: 'wrong answer', durationMs: 3000, costUsd: 0.002 }),
        deps
      )
    ).toEqual({ score: 0 });
    expect(
      await gradeClientEvalResult(db, CONFIG, upload({ output: 'wrong answer' }), deps)
    ).toEqual({ score: 1 });

    const [profile] = await listOwnerClientProfiles(db, context, 'efficient');
    expect(profile).toMatchObject({
      status: 'ready',
      results: 2,
      accuracy: 0.5,
      avg_cost_usd: 0.001,
      engine_identity: ENGINE,
      repetitions: 2,
    });
    expect(profile?.route_summaries).toEqual([
      expect.objectContaining({
        model: localKey,
        variant: 'low',
        routeKey: `${exactCase.taskType}/${exactCase.subtaskType}`,
        accuracy: 0.5,
        cases: 2,
      }),
    ]);
    expect(judge).not.toHaveBeenCalled();
    expect(writeUsage).not.toHaveBeenCalled();
  });

  it('scores a failed run zero without grading', async () => {
    expect(
      await gradeClientEvalResult(
        db,
        CONFIG,
        upload({ caseId: judgedCase.id, exitCode: 1, output: 'partial' }),
        deps
      )
    ).toEqual({ score: 0 });
    expect(judge).not.toHaveBeenCalled();
    const [profile] = await listOwnerClientProfiles(db, context, 'efficient');
    expect(profile).toMatchObject({ status: 'pending', errors: 1 });
  });

  it('bills judged grading to the paying owner as auto-routing/grader', async () => {
    expect(
      await gradeClientEvalResult(db, CONFIG, upload({ caseId: judgedCase.id }), deps)
    ).toEqual({ score: 0.75 });
    expect(writeUsage).toHaveBeenCalledOnce();
    const [usage] = writeUsage.mock.calls[0]!;
    expect(usage.core).toMatchObject({
      kilo_user_id: 'user-1',
      organization_id: ORG_ID,
      model: 'auto-routing/grader',
      cost: 2100,
    });
    expect(usage.metadata.user_prompt_prefix).toBeNull();
  });

  it('stores nothing when grader usage cannot be recorded', async () => {
    writeUsage.mockResolvedValueOnce({ kind: 'unavailable', reason: 'http_error' } as never);
    await expect(
      gradeClientEvalResult(db, CONFIG, upload({ caseId: judgedCase.id }), deps)
    ).rejects.toMatchObject({ code: 'internal_error' });
    const [profile] = await listOwnerClientProfiles(db, context, 'efficient');
    expect(profile?.results).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM client_case_results').get()).toEqual({ n: 0 });

    expect(
      await gradeClientEvalResult(db, CONFIG, upload({ caseId: judgedCase.id }), deps)
    ).toEqual({ score: 0.75 });
    const usageIds = writeUsage.mock.calls.map(([usage]) => usage.core.id);
    expect(new Set(usageIds).size).toBe(1);
  });

  it('rejects uploads for an older engine, unknown variants, and out-of-range repetitions', async () => {
    await expect(
      gradeClientEvalResult(db, CONFIG, upload({ engineIdentity: 'efficient:v0:old' }), deps)
    ).rejects.toMatchObject({ code: 'stale_engine_identity' });
    await expect(
      gradeClientEvalResult(db, CONFIG, upload({ variant: 'max' }), deps)
    ).rejects.toBeInstanceOf(ClientEvalError);
    await expect(gradeClientEvalResult(db, CONFIG, upload({ rep: 2 }), deps)).rejects.toMatchObject(
      { code: 'invalid_request' }
    );
    expect(await listOwnerClientProfiles(db, context, 'efficient')).toEqual([]);
  });

  it('maps a stale engine upload to the contract error over HTTP', async () => {
    await saveBenchmarkConfig(db, CONFIG, 'test');
    const response = await app.request(
      `https://bench.example.com${CUSTOM_ROUTER_EVAL_RESULT_PATH}`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer bench-token', 'content-type': 'application/json' },
        body: JSON.stringify(upload({ engineIdentity: 'efficient:v0:old' })),
      },
      {
        BENCH_DB: db,
        INTERNAL_API_SECRET_PROD: { get: async () => 'bench-token' },
        KILO_WEB_API_BASE_URL: 'https://app.test',
      } as unknown as Env
    );
    expect(response.status).toBe(409);
    expect(CustomRouterErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'stale_engine_identity'
    );
  });

  it('rejects eval calls without the internal secret', async () => {
    const response = await app.request(
      'https://bench.example.com/v1/eval/plan',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      { INTERNAL_API_SECRET_PROD: { get: async () => 'bench-token' } } as unknown as Env
    );
    expect(response.status).toBe(401);
  });

  it('re-plans a case that did not run and lets a new upload replace it', async () => {
    expect(
      await gradeClientEvalResult(db, CONFIG, upload({ exitCode: 1, output: 'down' }), deps)
    ).toEqual({ score: 0 });
    const plan = await planClientEval(db, CONFIG, context, deps.source);
    expect(plan.items).toContainEqual(
      expect.objectContaining({ variant: 'low', caseId: exactCase.id, rep: 0 })
    );

    expect(await gradeClientEvalResult(db, CONFIG, upload(), deps)).toEqual({ score: 1 });
    const [profile] = await listOwnerClientProfiles(db, context, 'efficient');
    expect(profile).toMatchObject({ status: 'ready', results: 1, errors: 0, accuracy: 1 });
  });

  it('refreshes the profile rollup when a stored case is uploaded again', async () => {
    await gradeClientEvalResult(db, CONFIG, upload(), deps);
    sqlite.exec(`UPDATE client_profiles SET results = 0, accuracy = NULL, status = 'pending'`);
    expect(await gradeClientEvalResult(db, CONFIG, upload(), deps)).toEqual({ score: 1 });
    const [profile] = await listOwnerClientProfiles(db, context, 'efficient');
    expect(profile).toMatchObject({ status: 'ready', results: 1, accuracy: 1 });
  });

  it('grades the full output but stores a bounded copy', async () => {
    const output = `${'é'.repeat(300_000)}\n${exactAnswer}`;
    expect(await gradeClientEvalResult(db, CONFIG, upload({ output }), deps)).toEqual({ score: 1 });
    expect(sqlite.prepare('SELECT length(output) AS n FROM client_case_results').get()).toEqual({
      n: 200_000,
    });
  });

  it('stores nothing when building the usage record fails before the write', async () => {
    await expect(
      gradeClientEvalResult(
        db,
        CONFIG,
        upload({
          caseId: judgedCase.id,
          billing: { userId: 'user-1', organizationId: 'not-a-uuid' },
        }),
        deps
      )
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(writeUsage).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM client_case_results').get()).toEqual({ n: 0 });
  });

  it('lowers the rollup when a replacing upload is removed after billing fails', async () => {
    const judged = { caseId: judgedCase.id };
    await gradeClientEvalResult(db, CONFIG, upload({ ...judged, exitCode: 1 }), deps);
    expect((await listOwnerClientProfiles(db, context, 'efficient'))[0]?.results).toBe(1);
    writeUsage.mockRejectedValueOnce(new Error('network'));
    await expect(gradeClientEvalResult(db, CONFIG, upload(judged), deps)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM client_case_results').get()).toEqual({ n: 0 });
    expect((await listOwnerClientProfiles(db, context, 'efficient'))[0]).toMatchObject({
      results: 0,
      accuracy: null,
      status: 'pending',
    });
  });

  it('drops a stale rollup when a concurrent upload replaces a case in the same millisecond', async () => {
    await gradeClientEvalResult(db, CONFIG, upload({ exitCode: 1, output: 'down' }), deps);
    const [profile] = await listOwnerClientProfiles(db, context, 'efficient');
    if (!profile) throw new Error('profile missing');
    const uploads = sqlite
      .prepare('SELECT uploaded_at FROM client_case_results ORDER BY case_id')
      .all();
    let raced = false;
    const racing = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            if (!raced && /^update "client_profiles"/i.test(query)) {
              raced = true;
              // A replacement that keeps the same wall clock, so only the upload
              // revision can tell the view apart from the stored uploads.
              sqlite.exec(`
                UPDATE client_case_results SET exit_code = 0, score = 1, revision = revision + 1;
                UPDATE client_profiles SET status = 'ready', updated_at = 'fresh';
              `);
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const planned = 2 * 2 * DECIDER_CASES.length;

    await refreshClientProfileRollup(racing, profile, planned, '2099-01-02T00:00:00.000Z');
    expect(raced).toBe(true);
    expect(
      sqlite.prepare('SELECT uploaded_at FROM client_case_results ORDER BY case_id').all()
    ).toEqual(uploads);
    expect(sqlite.prepare('SELECT status, results, updated_at FROM client_profiles').get()).toEqual(
      { status: 'ready', results: 1, updated_at: 'fresh' }
    );

    await refreshClientProfileRollup(db, profile, planned, '2099-01-03T00:00:00.000Z');
    expect(
      sqlite.prepare('SELECT status, accuracy, updated_at FROM client_profiles').get()
    ).toEqual({ status: 'ready', accuracy: 1, updated_at: '2099-01-03T00:00:00.000Z' });
  });

  it('bills each payer under its own usage id', async () => {
    const judged = { caseId: judgedCase.id };
    writeUsage.mockResolvedValueOnce({ kind: 'unavailable', reason: 'not_recorded' });
    await expect(gradeClientEvalResult(db, CONFIG, upload(judged), deps)).rejects.toMatchObject({
      code: 'internal_error',
    });
    await gradeClientEvalResult(
      db,
      CONFIG,
      upload({ ...judged, billing: { userId: 'user-2', organizationId: ORG_ID } }),
      deps
    );
    const [first, second] = writeUsage.mock.calls.map(([usage]) => usage.core);
    expect(second).toMatchObject({ kilo_user_id: 'user-2' });
    expect(second?.id).not.toBe(first?.id);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM client_case_results').get()).toEqual({ n: 1 });
  });
});

describe('clientEvalCase', () => {
  async function platformPrompt(benchCase: DeciderCase): Promise<string> {
    let sent = '';
    const env = {
      BENCH_RUNNER: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            sent = z.object({ prompt: z.string() }).parse(await request.json()).prompt;
            return Response.json({ exitCode: 0, durationMs: 1, stdoutLines: [], stderrTail: '' });
          },
        }),
      },
    } as unknown as Env;
    await runDeciderCaseViaCli(env, {
      instanceName: 'benchmark-slot:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'token',
      kiloApiUrl: 'https://api.test',
    });
    return sent;
  }

  it.each([
    ['an ordinary', exactCase, false],
    ['a long-context', DECIDER_CASES.find(c => c.longContext), true],
  ])(
    'serves the exact platform container prompt for %s case',
    async (_kind, benchCase, longContext) => {
      if (!benchCase) throw new Error('dataset needs the case');
      const served = clientEvalCase({ ...context, caseId: benchCase.id });
      expect(served).toEqual({
        caseId: benchCase.id,
        baseRouter: 'efficient',
        prompt: await platformPrompt(benchCase),
        timeoutMs: 180_000,
      });
      expect(served.prompt).toContain(benchCase.userPrompt);
      expect(served.prompt.includes('BEGIN WORKSPACE SNAPSHOT')).toBe(longContext);
    }
  );

  it('rejects case ids outside the base router dataset', () => {
    expect(() =>
      clientEvalCase({ ...context, baseRouter: 'frontier', caseId: exactCase.id })
    ).toThrow(ClientEvalError);
  });
});

describe('rollUpClientCases', () => {
  const profile = {
    id: 'p',
    owner_type: 'user' as const,
    owner_id: 'u',
    router: 'efficient' as const,
    entry_kind: 'client' as const,
    provider: 'lmstudio',
    model: 'm',
    variant: '',
    engine_identity: ENGINE,
    repetitions: 1,
    status: 'pending' as const,
    failure_reason: null,
    results: 0,
    accuracy: null,
    errors: 0,
    timeouts: 0,
    avg_cost_usd: null,
    p50_latency_ms: null,
    p95_latency_ms: null,
    route_summaries: [],
    created_at: '',
    updated_at: '',
  };
  const failedCase = (caseId: string) => ({
    profile_id: 'p',
    case_id: caseId,
    rep: 0,
    route_key: 'implementation/feature_development',
    cost_usd: 0,
    duration_ms: 180_000,
    exit_code: null,
    timed_out: true,
    score: 0,
    grader_cost_usd: 0,
    uploaded_at: '',
    revision: 1,
  });

  it('fails a profile only once every planned case failed', () => {
    expect(rollUpClientCases(profile, [failedCase('a')], 2)).toMatchObject({
      status: 'pending',
      timeouts: 1,
    });
    expect(rollUpClientCases(profile, [failedCase('a'), failedCase('b')], 2)).toMatchObject({
      status: 'failed',
      results: 2,
    });
    expect(
      rollUpClientCases(
        profile,
        [failedCase('a'), { ...failedCase('b'), timed_out: false, exit_code: 0 }],
        2
      )
    ).toMatchObject({ status: 'ready' });
  });
});
