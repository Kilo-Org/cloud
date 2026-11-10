import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { direct_byok_model_lists } from '@kilocode/db/schema';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { cachedDirectByokModelList } from './model-list';
import { FAILURE_BACKOFF_MS as failureBackoffMs } from '@kilocode/web-shared/lib/cached-fetch';
import type { DirectByokModel } from './types';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { select: jest.fn() },
  readDb: { select: jest.fn() },
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: { get: jest.fn() } }));

const mockLimit = jest.fn<Promise<{ models: unknown }[]>, [limit: number]>();
const mockWhere = jest.fn<{ limit: typeof mockLimit }, [condition: SQL]>();
const mockFrom = jest.fn<{ where: typeof mockWhere }, [table: typeof direct_byok_model_lists]>();
const { readDb: mockReadDb } = jest.requireMock<{
  readDb: {
    select: jest.Mock<
      { from: typeof mockFrom },
      [fields: { models: typeof direct_byok_model_lists.models }]
    >;
  };
}>('@kilocode/web-shared/lib/drizzle');
const mockReplicaSelect = mockReadDb.select;
const ttl = 600_000;

function model(id: string, overrides: Partial<DirectByokModel> = {}): DirectByokModel {
  return { id, name: id, context_length: 4096, max_completion_tokens: 1024, ...overrides };
}

const failures = [
  { name: 'malformed JSONB', failure: [model('valid'), { id: 'invalid' }] },
  { name: 'null JSONB', failure: null },
  { name: 'replica read error', failure: new Error('replica unavailable') },
];
let now: number;
let getModels: ReturnType<typeof cachedDirectByokModelList>;

function failNextRead(failure: unknown) {
  if (failure instanceof Error) {
    mockLimit.mockRejectedValueOnce(failure);
  } else {
    mockLimit.mockResolvedValueOnce([{ models: failure }]);
  }
}

function expectProviderReads(...providerIds: string[]) {
  expect(mockReplicaSelect.mock.calls).toEqual(
    providerIds.map(() => [{ models: direct_byok_model_lists.models }])
  );
  expect(mockFrom.mock.calls).toEqual(providerIds.map(() => [direct_byok_model_lists]));
  expect(mockLimit.mock.calls).toEqual(providerIds.map(() => [1]));
  expect(mockWhere.mock.calls.map(([condition]) => new PgDialect().sqlToQuery(condition))).toEqual(
    providerIds.map(providerId =>
      expect.objectContaining({
        sql: '"direct_byok_model_lists"."provider_id" = $1',
        params: [providerId],
      })
    )
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockLimit.mockResolvedValue([]);
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockReplicaSelect.mockReturnValue({ from: mockFrom });
  getModels = cachedDirectByokModelList('chutes-byok');
});

afterEach(() => {
  jest.restoreAllMocks();
  expect(db.select).not.toHaveBeenCalled();
  expect(redisClient.get).not.toHaveBeenCalled();
});

describe('cachedDirectByokModelList', () => {
  test.each([
    { name: 'missing row', rows: [] },
    { name: 'empty list', rows: [{ models: [] }] },
  ])('returns no models for a $name using only the replica', async ({ rows }) => {
    mockLimit.mockResolvedValueOnce(rows);

    const result = await getModels();

    expect(result).toStrictEqual([]);
    now += ttl - 1;
    await expect(getModels()).resolves.toBe(result);
    expectProviderReads('chutes-byok');
  });

  test('returns only synced models with their metadata and order unchanged', async () => {
    const synced = [
      model('beta', {
        name: 'Synced beta',
        context_length: 9999,
        max_completion_tokens: 8888,
        flags: ['vision', 'reasoning'],
        reasoning_options: [{ type: 'effort', values: ['low'] }],
        catalog_model_id: 'vendor/beta',
      }),
      model('alpha', { reasoning_options: [], catalog_model_id: 'vendor/alpha' }),
    ];
    const originalSynced = structuredClone(synced);
    mockLimit.mockResolvedValueOnce([{ models: synced }]);

    await expect(getModels()).resolves.toStrictEqual(synced);
    expect(synced).toEqual(originalSynced);
    expectProviderReads('chutes-byok');
  });

  test.each(failures)(
    'falls back on cold $name and refreshes after the backoff',
    async ({ failure }) => {
      failNextRead(failure);

      const fallback = await getModels();
      expect(fallback).toStrictEqual([]);
      expectProviderReads('chutes-byok');

      now += failureBackoffMs - 1;
      await expect(getModels()).resolves.toBe(fallback);
      expectProviderReads('chutes-byok');

      now += 1;

      mockLimit.mockResolvedValueOnce([{ models: [model('recovered')] }]);
      const recovered = await getModels();
      expect(recovered).toStrictEqual([model('recovered')]);
      await expect(getModels()).resolves.toBe(recovered);
      expectProviderReads('chutes-byok', 'chutes-byok');
    }
  );

  test.each(failures)(
    'retains last-good on warm $name and refreshes after the backoff',
    async ({ failure }) => {
      mockLimit.mockResolvedValueOnce([{ models: [model('last-good')] }]);
      const lastGood = await getModels();
      expect(lastGood.map(entry => entry.id)).toEqual(['last-good']);

      now += ttl - 1;
      await expect(getModels()).resolves.toBe(lastGood);
      expectProviderReads('chutes-byok');

      now += 1;
      failNextRead(failure);
      await expect(getModels()).resolves.toBe(lastGood);
      expectProviderReads('chutes-byok', 'chutes-byok');

      now += failureBackoffMs - 1;
      await expect(getModels()).resolves.toBe(lastGood);
      expectProviderReads('chutes-byok', 'chutes-byok');

      now += 1;

      mockLimit.mockResolvedValueOnce([{ models: [model('recovered')] }]);
      const recovered = await getModels();
      expect(recovered.map(entry => entry.id)).toEqual(['recovered']);
      expect(recovered).not.toBe(lastGood);
      expectProviderReads('chutes-byok', 'chutes-byok', 'chutes-byok');

      now += ttl - 1;
      await expect(getModels()).resolves.toBe(recovered);
      expectProviderReads('chutes-byok', 'chutes-byok', 'chutes-byok');
      now += 1;
      mockLimit.mockResolvedValueOnce([{ models: [model('refreshed')] }]);
      expect((await getModels()).map(entry => entry.id)).toEqual(['refreshed']);
      expectProviderReads('chutes-byok', 'chutes-byok', 'chutes-byok', 'chutes-byok');
    }
  );

  test('isolates provider predicates, cached models, expiry and stale fallback', async () => {
    const getSynthetic = cachedDirectByokModelList('synthetic');
    mockLimit.mockResolvedValueOnce([{ models: [model('shared', { name: 'Chutes model' })] }]);
    const chutes = await getModels();
    expect(chutes.map(entry => entry.name)).toEqual(['Chutes model']);

    now += 100;
    mockLimit.mockResolvedValueOnce([{ models: [model('shared', { name: 'Synthetic model' })] }]);
    const synthetic = await getSynthetic();
    expect(synthetic.map(entry => entry.name)).toEqual(['Synthetic model']);
    await expect(getModels()).resolves.toBe(chutes);
    expectProviderReads('chutes-byok', 'synthetic');

    now += ttl - 100;
    mockLimit.mockRejectedValueOnce(new Error('chutes read failed'));
    await expect(getModels()).resolves.toBe(chutes);
    await expect(getSynthetic()).resolves.toBe(synthetic);
    expectProviderReads('chutes-byok', 'synthetic', 'chutes-byok');

    now += failureBackoffMs - 1;
    mockLimit.mockResolvedValueOnce([{ models: [model('shared', { name: 'Synthetic model' })] }]);
    const syntheticRefreshed = await getSynthetic();
    expect(syntheticRefreshed.map(entry => entry.name)).toEqual(['Synthetic model']);
    await expect(getModels()).resolves.toBe(chutes);
    expectProviderReads('chutes-byok', 'synthetic', 'chutes-byok', 'synthetic');

    now += 1;

    mockLimit.mockResolvedValueOnce([{ models: [model('recovered')] }]);
    expect((await getModels()).map(entry => entry.id)).toEqual(['recovered']);
    await expect(getSynthetic()).resolves.toBe(syntheticRefreshed);
    expectProviderReads('chutes-byok', 'synthetic', 'chutes-byok', 'synthetic', 'chutes-byok');
  });
});
