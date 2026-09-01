import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { setTimeout } from 'node:timers/promises';
import { db } from '@/lib/drizzle';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';
import { ENKRYPT_SCORE_EXAMPLES } from '@/tests/fixtures/enkrypt-scores';
import { enkrypt_sync_state, modelStats } from '@kilocode/db/schema';
import type { ModelStats } from '@kilocode/db/schema';
import type { EnkryptFailureCategory, EnkryptSyncCounts } from '@kilocode/db/schema-types';
import { eq, inArray } from 'drizzle-orm';
import { EnkryptSyncError } from './enkrypt-errors';
import { ENKRYPT_REQUIRED_MODEL_IDS, matchEnkryptScores } from './enkrypt-identity';
import type * as EnkryptIdentity from './enkrypt-identity';
import { getEnkryptSyncHealth } from './enkrypt-status';
import { syncEnkryptBenchmarks } from './sync-enkrypt';

let mockApiKey: string | undefined = 'test-key';
let mockEnabled = true;

jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_API_KEY() {
    return mockApiKey;
  },
  get ENKRYPT_SYNC_ENABLED() {
    return mockEnabled;
  },
}));

jest.mock('node:timers/promises', () => ({ setTimeout: jest.fn() }));
jest.mock('./enkrypt-identity', () => {
  const actual = jest.requireActual<typeof EnkryptIdentity>('./enkrypt-identity');
  return { ...actual, matchEnkryptScores: jest.fn(actual.matchEnkryptScores) };
});

const examples = ENKRYPT_SCORE_EXAMPLES.data.scores;
const requiredScores = examples.slice(0, 3);
const oldSuccessAt = '2026-01-01T00:00:00.000Z';
const successCounts: EnkryptSyncCounts = {
  fetchedCount: 7,
  rejectedCount: 0,
  matchedCount: 3,
  unmatchedCount: 4,
  ambiguousCount: 0,
  updatedCount: 3,
};
const mockDelay = jest.mocked(setTimeout);
const mockMatch = jest.mocked(matchEnkryptScores);

function envelope(scores: unknown[]) {
  return { status: 'success', data: { scores } };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectFailure(
  promise: ReturnType<typeof syncEnkryptBenchmarks>,
  category: EnkryptFailureCategory
) {
  const result = await promise.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(EnkryptSyncError);
  if (!(result instanceof EnkryptSyncError)) throw new Error('Expected sanitized failure');
  expect(result.category).toBe(category);
  expect(result.message).toBe('Enkrypt synchronization failed');
  expect(result).not.toHaveProperty('cause');
  expect(result.stack).not.toContain('unsafe-marker');
  expect(JSON.stringify(result)).not.toContain('unsafe-marker');
  if (mockApiKey?.trim()) expect(JSON.stringify(result)).not.toContain(mockApiKey);
  return result;
}

describe('syncEnkryptBenchmarks with PostgreSQL', () => {
  let models: ModelStats[] = [];
  let mockFetch: jest.SpiedFunction<typeof fetch>;

  async function readModels() {
    return db
      .select()
      .from(modelStats)
      .where(
        inArray(
          modelStats.id,
          models.map(model => model.id)
        )
      )
      .orderBy(modelStats.id);
  }

  async function readState() {
    const [state] = await db
      .select()
      .from(enkrypt_sync_state)
      .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    if (!state) throw new Error('Expected singleton state');
    return state;
  }

  async function seedSuccess(baseline = 3) {
    await db.insert(enkrypt_sync_state).values({
      job_name: 'enkrypt',
      last_attempt_at: oldSuccessAt,
      last_completed_at: oldSuccessAt,
      last_success_at: oldSuccessAt,
      last_outcome: 'succeeded',
      last_counts: successCounts,
      last_success_counts: successCounts,
      baseline_matched_count: baseline,
      last_alert_at: oldSuccessAt,
      last_alert_reason: 'coverage',
    });
  }

  beforeEach(async () => {
    mockEnabled = true;
    mockApiKey = 'test-key';
    mockDelay.mockReset().mockResolvedValue(undefined);
    mockMatch
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof EnkryptIdentity>('./enkrypt-identity').matchEnkryptScores
      );
    mockFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(ENKRYPT_SCORE_EXAMPLES));
    await db.delete(enkrypt_sync_state).where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    models = [];
    for (const [index, openrouterId] of ENKRYPT_REQUIRED_MODEL_IDS.entries()) {
      const score = requiredScores[index];
      if (!score) throw new Error('Missing approved example');
      models.push(
        await insertTestModelStats({
          openrouterId,
          benchmarks: {
            artificialAnalysis: { codingIndex: 42 },
            kiloBench: { overallScore: 0.5, evals: {} },
            enkrypt: { ...score, risk_score: 9, ingestedAt: oldSuccessAt, evaluatedAt: null },
          },
        })
      );
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(enkrypt_sync_state).where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
    if (models.length > 0) {
      await db.delete(modelStats).where(
        inArray(
          modelStats.id,
          models.map(model => model.id)
        )
      );
    }
  });

  it('merges only Enkrypt JSONB and atomically stores last success and safe counts', async () => {
    await seedSuccess();
    mockFetch.mockResolvedValueOnce(
      Response.json({
        ...envelope(
          examples.map(score => ({ ...score, apikey: 'unsafe-marker', extra: 'unsafe-marker' }))
        ),
        extra: 'unsafe-marker',
      })
    );
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const transaction = db.transaction.bind(db);
    let inspected = false;
    jest.spyOn(db, 'transaction').mockImplementation(callback =>
      transaction(async tx => {
        const result = await callback(tx);
        const [inside] = await tx.select().from(enkrypt_sync_state);
        expect(inside.last_outcome).toBe('succeeded');
        expect(inside.last_success_counts).toEqual(successCounts);
        const written = await tx
          .select()
          .from(modelStats)
          .where(
            inArray(
              modelStats.id,
              models.map(m => m.id)
            )
          );
        expect(written.every(model => model.benchmarks?.enkrypt?.ingestedAt !== oldSuccessAt)).toBe(
          true
        );
        expect((await readState()).last_success_counts).toEqual(successCounts);
        expect(new Date((await readState()).last_success_at ?? '').toISOString()).toBe(
          oldSuccessAt
        );
        expect(
          (await readModels()).every(
            model => model.benchmarks?.enkrypt?.ingestedAt === oldSuccessAt
          )
        ).toBe(true);
        inspected = true;
        return result;
      })
    );

    const result = await syncEnkryptBenchmarks();
    expect(result).toEqual({
      status: 'succeeded',
      ...successCounts,
      ingestedAt: expect.any(String),
    });
    if (result.status !== 'succeeded') throw new Error('Expected success');
    expect(inspected).toBe(true);
    expect(result).not.toHaveProperty('scores');
    expect(result).not.toHaveProperty('unmatchedModelNames');
    for (const stored of await readModels()) {
      const original = models.find(model => model.id === stored.id);
      const index = ENKRYPT_REQUIRED_MODEL_IDS.indexOf(stored.openrouterId);
      expect(stored.benchmarks).toEqual({
        artificialAnalysis: original?.benchmarks?.artificialAnalysis,
        kiloBench: original?.benchmarks?.kiloBench,
        enkrypt: { ...requiredScores[index], ingestedAt: result.ingestedAt, evaluatedAt: null },
      });
      expect(stored.openrouterData).toEqual(original?.openrouterData);
      expect(JSON.stringify(stored)).not.toContain('unsafe-marker');
    }
    const state = await readState();
    expect(state).toMatchObject({
      last_outcome: 'succeeded',
      last_failure_category: null,
      last_counts: successCounts,
      last_success_counts: successCounts,
      baseline_matched_count: 3,
      last_alert_at: null,
      last_alert_reason: null,
      attempt_id: expect.any(String),
    });
    expect(new Date(state.last_success_at ?? '').toISOString()).toBe(result.ingestedAt);
    expect(new Date(state.last_completed_at ?? '').toISOString()).toBe(result.ingestedAt);
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'healthy',
      reason: null,
      shouldAlert: false,
      counts: successCounts,
    });
    expect(mockFetch).toHaveBeenCalledWith('https://api.enkryptai.com/leaderboard/v2/scores', {
      method: 'GET',
      headers: { apikey: 'test-key' },
      signal: expect.any(AbortSignal),
      redirect: 'error',
      cache: 'no-store',
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('initializes null JSONB and keeps ingestion separate from unknown evaluation time', async () => {
    await db
      .update(modelStats)
      .set({ benchmarks: null })
      .where(
        inArray(
          modelStats.id,
          models.map(m => m.id)
        )
      );
    const result = await syncEnkryptBenchmarks();
    expect(result).toMatchObject({ status: 'succeeded', updatedCount: 3 });
    for (const model of await readModels()) {
      expect(Object.keys(model.benchmarks ?? {})).toEqual(['enkrypt']);
      expect(model.benchmarks?.enkrypt).toMatchObject({
        risk_score: 0,
        safety_score: null,
        evaluatedAt: null,
      });
      expect(model.benchmarks?.enkrypt).not.toHaveProperty('bias_score');
      expect(model.benchmarks?.enkrypt).not.toHaveProperty('lastUpdated');
    }
    const firstState = await readState();
    await syncEnkryptBenchmarks();
    const nextState = await readState();
    expect(nextState.attempt_id).not.toBe(firstState.attempt_id);
    expect(Date.parse(nextState.last_success_at ?? '')).toBeGreaterThanOrEqual(
      Date.parse(firstState.last_success_at ?? '')
    );
    expect(nextState.baseline_matched_count).toBe(3);
  });

  it('counts per-record rejection without discarding the three valid required records', async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        envelope([
          ...examples,
          null,
          { ...requiredScores[0], risk_score: 'unsafe-marker' },
          { model_name: '', provider: 'unsafe-marker' },
          { model_name: 'unknown-null', provider: 'fixture-provider', source: null },
          { model_name: 'unknown-absent', provider: 'fixture-provider' },
        ])
      )
    );
    const counts = { ...successCounts, fetchedCount: 12, rejectedCount: 3, unmatchedCount: 6 };
    expect(await syncEnkryptBenchmarks()).toMatchObject({ status: 'succeeded', ...counts });
    expect(await readState()).toMatchObject({ last_counts: counts, last_success_counts: counts });
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'healthy',
      counts,
      shouldAlert: false,
    });
  });

  it('does not overwrite a sibling JSONB update made after matching', async () => {
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementation(async callback => {
      await db
        .update(modelStats)
        .set({ benchmarks: { artificialAnalysis: { codingIndex: 99 } } })
        .where(eq(modelStats.id, models[0].id));
      return transaction(callback);
    });
    await syncEnkryptBenchmarks();
    const stored = (await readModels()).find(model => model.id === models[0].id);
    expect(stored?.benchmarks?.artificialAnalysis).toEqual({ codingIndex: 99 });
    expect(stored?.benchmarks?.enkrypt).toBeDefined();
  });

  it.each([undefined, '', '   '])(
    'rejects missing key %# without fetch or database access',
    async key => {
      mockApiKey = key;
      const calls = [
        jest.spyOn(db, 'insert'),
        jest.spyOn(db, 'select'),
        jest.spyOn(db, 'update'),
        jest.spyOn(db, 'transaction'),
      ];
      await expectFailure(syncEnkryptBenchmarks(), 'configuration');
      expect(mockFetch).not.toHaveBeenCalled();
      for (const call of calls) expect(call).not.toHaveBeenCalled();
    }
  );

  it('is disabled without fetch, database access, or configuration validation', async () => {
    mockEnabled = false;
    mockApiKey = undefined;
    const calls = [
      jest.spyOn(db, 'insert'),
      jest.spyOn(db, 'select'),
      jest.spyOn(db, 'update'),
      jest.spyOn(db, 'transaction'),
    ];
    expect(await syncEnkryptBenchmarks()).toEqual({ status: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { status: 301, category: 'upstream', attempts: 1 },
    { status: 400, category: 'upstream', attempts: 1 },
    { status: 401, category: 'authentication', attempts: 1 },
    { status: 403, category: 'authentication', attempts: 1 },
    { status: 429, category: 'rate_limited', attempts: 3 },
    { status: 500, category: 'upstream', attempts: 3 },
    { status: 503, category: 'upstream', attempts: 3 },
  ] satisfies { status: number; category: EnkryptFailureCategory; attempts: number }[])(
    'bounds HTTP $status retries and persists only category $category',
    async ({ status, category, attempts }) => {
      await seedSuccess();
      const before = await readModels();
      const responses: Response[] = [];
      mockFetch.mockImplementation(async () => {
        const response = new Response('unsafe-marker', {
          status,
          statusText: 'unsafe-marker',
          headers: { 'x-test': 'unsafe-marker' },
        });
        jest.spyOn(response, 'json');
        jest.spyOn(response, 'text');
        responses.push(response);
        return response;
      });
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = await expectFailure(syncEnkryptBenchmarks(), category);
      expect(error.httpStatus).toBe(status);
      expect(mockFetch).toHaveBeenCalledTimes(attempts);
      expect(mockDelay).toHaveBeenCalledTimes(attempts - 1);
      if (attempts === 3) {
        expect(mockDelay.mock.calls.map(call => call[0])).toEqual([1_000, 2_000]);
        expect(new Set(mockFetch.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
      }
      for (const response of responses) {
        expect(response.json).not.toHaveBeenCalled();
        expect(response.text).not.toHaveBeenCalled();
        expect(response.bodyUsed).toBe(true);
      }
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      const state = await readState();
      expect(state).toMatchObject({
        last_outcome: 'failed',
        last_failure_category: category,
        last_success_counts: successCounts,
        baseline_matched_count: 3,
      });
      expect(new Date(state.last_success_at ?? '').toISOString()).toBe(oldSuccessAt);
      expect(JSON.stringify(state)).not.toContain('unsafe-marker');
      expect(await readModels()).toEqual(before);
    }
  );

  it('recovers within the bounded retry budget', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }));
    expect(await syncEnkryptBenchmarks()).toMatchObject({ status: 'succeeded', updatedCount: 3 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockDelay.mock.calls.map(call => call[0])).toEqual([1_000, 2_000]);
    expect((await readState()).last_outcome).toBe('succeeded');
  });

  it.each(['network', 'timeout'] as const)(
    'sanitizes %s errors and persists actionable first failure',
    async category => {
      const signal = new AbortController();
      jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal.signal);
      if (category === 'timeout') signal.abort(new Error('unsafe-marker'));
      mockFetch.mockRejectedValue(new Error('unsafe-marker'));
      const before = await readModels();
      await expectFailure(syncEnkryptBenchmarks(), category);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockDelay).not.toHaveBeenCalled();
      expect(await readState()).toMatchObject({
        last_outcome: 'failed',
        last_failure_category: category,
        last_success_at: null,
      });
      expect(await getEnkryptSyncHealth()).toMatchObject({
        status: 'degraded',
        reason: category,
        shouldAlert: true,
      });
      expect(await readModels()).toEqual(before);
    }
  );

  it('classifies a timeout during retry delay without another request', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    mockDelay.mockRejectedValueOnce(new Error('unsafe-marker'));
    const error = await expectFailure(syncEnkryptBenchmarks(), 'timeout');
    expect(error.httpStatus).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((await readState()).last_failure_category).toBe('timeout');
  });

  it.each(['invalid-json', 'invalid-envelope', 'body-network', 'body-timeout'] as const)(
    'sanitizes %s before score writes',
    async kind => {
      const response =
        kind === 'invalid-json'
          ? new Response('unsafe-marker')
          : Response.json({ status: 'unsafe-marker' });
      if (kind === 'body-network' || kind === 'body-timeout') {
        const controller = new AbortController();
        jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
        jest.spyOn(response, 'text').mockImplementation(async () => {
          if (kind === 'body-timeout') controller.abort();
          throw new Error('unsafe-marker');
        });
      }
      mockFetch.mockResolvedValueOnce(response);
      const before = await readModels();
      const transaction = jest.spyOn(db, 'transaction');
      const category =
        kind === 'body-network'
          ? 'network'
          : kind === 'body-timeout'
            ? 'timeout'
            : 'response_validation';
      await expectFailure(syncEnkryptBenchmarks(), category);
      expect(transaction).not.toHaveBeenCalled();
      expect((await readState()).last_failure_category).toBe(category);
      expect(await readModels()).toEqual(before);
    }
  );

  it.each([
    {
      name: 'empty',
      scores: [],
      fetchedCount: 0,
      rejectedCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      ambiguousCount: 0,
    },
    {
      name: 'all rejected',
      scores: [null, { ...requiredScores[0], risk_score: 'unsafe-marker' }],
      fetchedCount: 2,
      rejectedCount: 2,
      matchedCount: 0,
      unmatchedCount: 0,
      ambiguousCount: 0,
    },
    {
      name: 'zero matches',
      scores: examples.slice(3),
      fetchedCount: 4,
      rejectedCount: 0,
      matchedCount: 0,
      unmatchedCount: 4,
      ambiguousCount: 0,
    },
    {
      name: 'missing required',
      scores: requiredScores.slice(0, 2),
      fetchedCount: 2,
      rejectedCount: 0,
      matchedCount: 2,
      unmatchedCount: 0,
      ambiguousCount: 0,
    },
    {
      name: 'ambiguous required',
      scores: [...requiredScores, requiredScores[0]],
      fetchedCount: 4,
      rejectedCount: 0,
      matchedCount: 2,
      unmatchedCount: 0,
      ambiguousCount: 2,
    },
  ])(
    'fails $name coverage before any score writes',
    async ({
      scores,
      fetchedCount,
      rejectedCount,
      matchedCount,
      unmatchedCount,
      ambiguousCount,
    }) => {
      const counts = { fetchedCount, rejectedCount, matchedCount, unmatchedCount, ambiguousCount };
      await seedSuccess();
      const before = await readModels();
      mockFetch.mockResolvedValueOnce(Response.json(envelope(scores)));
      const transaction = jest.spyOn(db, 'transaction');
      const error = await expectFailure(syncEnkryptBenchmarks(), 'coverage');
      expect(error.counts).toEqual({ ...counts, updatedCount: 0 });
      expect(transaction).not.toHaveBeenCalled();
      const state = await readState();
      expect(state).toMatchObject({
        last_outcome: 'failed',
        last_failure_category: 'coverage',
        last_counts: error.counts,
        last_success_counts: successCounts,
        baseline_matched_count: 3,
      });
      expect(new Date(state.last_success_at ?? '').toISOString()).toBe(oldSuccessAt);
      expect(await readModels()).toEqual(before);
    }
  );

  it.each(['inactive', 'stealth', 'missing'] as const)(
    'fails before writes when a required catalog row is %s',
    async kind => {
      const model = models[0];
      if (kind === 'missing') await db.delete(modelStats).where(eq(modelStats.id, model.id));
      else
        await db
          .update(modelStats)
          .set(kind === 'inactive' ? { isActive: false } : { isStealth: true })
          .where(eq(modelStats.id, model.id));
      const before = await readModels();
      const transaction = jest.spyOn(db, 'transaction');
      await expectFailure(syncEnkryptBenchmarks(), 'coverage');
      expect(transaction).not.toHaveBeenCalled();
      expect(await readModels()).toEqual(before);
    }
  );

  it('rejects a greater-than-20-percent baseline drop before writes inside the transaction', async () => {
    await seedSuccess(4);
    const before = await readModels();
    const transaction = db.transaction.bind(db);
    const updates: jest.SpiedFunction<
      Parameters<Parameters<typeof db.transaction>[0]>[0]['update']
    >[] = [];
    jest.spyOn(db, 'transaction').mockImplementation(callback =>
      transaction(async tx => {
        updates.push(jest.spyOn(tx, 'update'));
        return callback(tx);
      })
    );
    await expectFailure(syncEnkryptBenchmarks(), 'coverage');
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveBeenCalled();
    expect(await readState()).toMatchObject({
      baseline_matched_count: 4,
      last_success_counts: successCounts,
      last_counts: { ...successCounts, updatedCount: 0 },
    });
    expect(await readModels()).toEqual(before);
  });

  it('recovers committed success when the transaction acknowledgement fails', async () => {
    await seedSuccess();
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
      await transaction(callback);
      throw new Error('unsafe-marker lost commit acknowledgement');
    });

    const result = await syncEnkryptBenchmarks();
    expect(result).toMatchObject({ status: 'succeeded', ...successCounts });
    if (result.status !== 'succeeded') throw new Error('Expected committed success');
    expect(await readState()).toMatchObject({
      last_outcome: 'succeeded',
      last_failure_category: null,
      last_counts: successCounts,
      last_success_counts: successCounts,
    });
    const stored = await readModels();
    expect(stored).toHaveLength(3);
    for (const model of stored) {
      expect(model.benchmarks?.enkrypt?.ingestedAt).toBe(result.ingestedAt);
      expect(model.benchmarks?.artificialAnalysis).toBeDefined();
    }
    expect(await getEnkryptSyncHealth()).toMatchObject({
      status: 'healthy',
      lastSuccessAt: result.ingestedAt,
      counts: successCounts,
      shouldAlert: false,
    });
  });

  it('rolls back scores and success state together, then durably records the safe failure', async () => {
    await seedSuccess();
    const before = await readModels();
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementation(callback =>
      transaction(async tx => {
        await callback(tx);
        throw new Error('unsafe-marker SQL parameters');
      })
    );
    await expectFailure(syncEnkryptBenchmarks(), 'database');
    const state = await readState();
    expect(state).toMatchObject({
      last_outcome: 'failed',
      last_failure_category: 'database',
      last_success_counts: successCounts,
      last_counts: { ...successCounts, updatedCount: 0 },
    });
    expect(new Date(state.last_success_at ?? '').toISOString()).toBe(oldSuccessAt);
    expect(await readModels()).toEqual(before);
  });

  it('rolls back all writes when a required model changes eligibility after matching', async () => {
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementation(async callback => {
      await db.update(modelStats).set({ isStealth: true }).where(eq(modelStats.id, models[0].id));
      return transaction(callback);
    });
    const before = (await readModels()).map(model => model.benchmarks);
    await expectFailure(syncEnkryptBenchmarks(), 'coverage');
    expect((await readModels()).map(model => model.benchmarks)).toEqual(before);
    expect(await readState()).toMatchObject({
      last_outcome: 'failed',
      last_success_at: null,
      last_counts: { ...successCounts, updatedCount: 0 },
    });
  });

  it('records catalog database failure without retaining the raw error', async () => {
    jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('unsafe-marker SQL parameters');
    });
    await expectFailure(syncEnkryptBenchmarks(), 'database');
    expect(await readState()).toMatchObject({
      last_outcome: 'failed',
      last_failure_category: 'database',
      last_success_at: null,
    });
  });

  it('sanitizes a failure to start the attempt and never fetches', async () => {
    jest.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('unsafe-marker');
    });
    await expectFailure(syncEnkryptBenchmarks(), 'database');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await db.select().from(enkrypt_sync_state)).toEqual([]);
  });

  it('reports database failure if the separate failure-status write fails', async () => {
    await seedSuccess();
    const before = await readModels();
    mockFetch.mockRejectedValue(new Error('unsafe-marker request'));
    jest.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('unsafe-marker SQL');
    });
    await expectFailure(syncEnkryptBenchmarks(), 'database');
    expect(await readState()).toMatchObject({
      last_outcome: 'running',
      last_success_counts: successCounts,
    });
    expect(await readModels()).toEqual(before);
  });

  it('classifies an unexpected matcher error without persisting raw details', async () => {
    mockMatch.mockImplementationOnce(() => {
      throw new Error('unsafe-marker');
    });
    await expectFailure(syncEnkryptBenchmarks(), 'unexpected');
    expect(await readState()).toMatchObject({
      last_outcome: 'failed',
      last_failure_category: 'unexpected',
      last_success_at: null,
    });
  });

  it.each(['success', 'failure'] as const)(
    'does not let an older %s overwrite a newer completed run',
    async olderOutcome => {
      const entered = deferred<void>();
      const response = deferred<Response>();
      mockFetch.mockImplementationOnce(() => {
        entered.resolve();
        return response.promise;
      });
      const older = syncEnkryptBenchmarks();
      await entered.promise;
      const oldAttempt = (await readState()).attempt_id;
      await syncEnkryptBenchmarks();
      const newerState = await readState();
      const newerModels = await readModels();
      expect(newerState.attempt_id).not.toBe(oldAttempt);
      response.resolve(
        olderOutcome === 'success'
          ? Response.json(envelope(examples.map(score => ({ ...score, risk_score: 88 }))))
          : new Response('unsafe-marker', { status: 401 })
      );
      await expectFailure(older, olderOutcome === 'success' ? 'superseded' : 'authentication');
      expect(await readState()).toEqual(newerState);
      expect(await readModels()).toEqual(newerModels);
    }
  );

  it('does not let an older success overwrite a newer failure', async () => {
    const entered = deferred<void>();
    const response = deferred<Response>();
    mockFetch.mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    const older = syncEnkryptBenchmarks();
    await entered.promise;
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expectFailure(syncEnkryptBenchmarks(), 'authentication');
    const newerState = await readState();
    const before = await readModels();
    response.resolve(Response.json(ENKRYPT_SCORE_EXAMPLES));
    await expectFailure(older, 'superseded');
    expect(await readState()).toEqual(newerState);
    expect(await readModels()).toEqual(before);
  });

  it('rejects an attempt older than the persisted timestamp without fetching or changing state', async () => {
    await db.insert(enkrypt_sync_state).values({
      job_name: 'enkrypt',
      last_attempt_at: '9999-01-01T00:00:00.000Z',
      last_outcome: 'running',
    });
    const before = await readState();
    await expectFailure(syncEnkryptBenchmarks(), 'superseded');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });
});
