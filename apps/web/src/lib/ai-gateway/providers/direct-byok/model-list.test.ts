import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { direct_byok_model_lists } from '@kilocode/db/schema';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, readDb } from '@/lib/drizzle';
import { redisClient } from '@/lib/redis';
import { cachedEnhancedDirectByokModelList } from './model-list';
import type { DirectByokModel } from './types';

jest.mock('@/lib/drizzle', () => ({
  db: { select: jest.fn() },
  readDb: { select: jest.fn() },
}));
jest.mock('@/lib/redis', () => ({ redisClient: { get: jest.fn() } }));

const mockReplicaSelect = jest.mocked(readDb.select);
const mockLimit = jest.fn<(limit: number) => Promise<{ models: unknown }[]>>();
const mockWhere = jest.fn<(condition: SQL) => { limit: typeof mockLimit }>();
const mockFrom = jest.fn();
const ttl = 600_000;

function model(id: string, overrides: Partial<DirectByokModel> = {}): DirectByokModel {
  return { id, name: id, context_length: 4096, max_completion_tokens: 1024, ...overrides };
}

const recommended = model('recommended', { flags: ['vision'] });
const recommendedModels: ReadonlyArray<DirectByokModel> = [recommended];
const failures = [
  { name: 'malformed JSONB', failure: [model('valid'), { id: 'invalid' }] },
  { name: 'null JSONB', failure: null },
  { name: 'replica read error', failure: new Error('replica unavailable') },
];
let now: number;
let getModels: ReturnType<typeof cachedEnhancedDirectByokModelList>;

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
  mockReplicaSelect.mockReturnValue({ from: mockFrom } as ReturnType<typeof readDb.select>);
  getModels = cachedEnhancedDirectByokModelList({ providerId: 'codestral', recommendedModels });
});

afterEach(() => {
  jest.restoreAllMocks();
  expect(db.select).not.toHaveBeenCalled();
  expect(redisClient.get).not.toHaveBeenCalled();
});

describe('cachedEnhancedDirectByokModelList', () => {
  test.each([
    { name: 'missing row', rows: [] },
    { name: 'empty list', rows: [{ models: [] }] },
  ])('enhances recommendations for a $name using only the replica', async ({ rows }) => {
    mockLimit.mockResolvedValueOnce(rows);

    const result = await getModels();

    expect(result).toStrictEqual([
      { ...recommended, flags: ['vision', 'recommended'], variants: undefined },
    ]);
    expect(result).not.toBe(recommendedModels);
    expect(recommended.flags).toEqual(['vision']);
    now += ttl - 1;
    await expect(getModels()).resolves.toBe(result);
    expectProviderReads('codestral');
  });

  test('merges ordered metadata, deduplicated flags and variant precedence', async () => {
    const syncedVariants = { high: { reasoning: { effort: 'high' as const } } };
    const beta = model('beta', {
      name: 'Curated beta',
      flags: ['vision', 'vision', 'recommended'],
    });
    const alpha = model('alpha', { variants: { curated: { reasoning: { enabled: false } } } });
    const empty = model('empty', { variants: {} });
    const zeta = model('zeta', { flags: [] });
    const gamma = model('gamma', { flags: ['reasoning', 'reasoning'] });
    const curated = [beta, alpha, empty, model('beta', { name: 'Discarded recommendation' })];
    const synced = [
      zeta,
      model('beta', {
        name: 'Synced beta',
        context_length: 9999,
        max_completion_tokens: 8888,
        flags: ['reasoning'],
        variants: { low: { reasoning: { effort: 'low' } } },
      }),
      model('alpha', { variants: syncedVariants }),
      model('beta', { variants: syncedVariants }),
      model('empty', { variants: syncedVariants }),
      model('zeta', { name: 'Discarded synced duplicate' }),
      gamma,
    ];
    const originalCurated = structuredClone(curated);
    const originalSynced = structuredClone(synced);
    const getMerged = cachedEnhancedDirectByokModelList({
      providerId: 'codestral',
      recommendedModels: curated,
    });
    mockLimit.mockResolvedValueOnce([{ models: synced }]);

    await expect(getMerged()).resolves.toStrictEqual([
      { ...beta, flags: ['vision', 'recommended'], variants: syncedVariants },
      { ...alpha, flags: ['recommended'] },
      { ...empty, flags: ['recommended'] },
      { ...zeta, flags: undefined, variants: undefined },
      { ...gamma, flags: ['reasoning'], variants: undefined },
    ]);
    expect(curated).toStrictEqual(originalCurated);
    expect(synced).toStrictEqual(originalSynced);
    expectProviderReads('codestral');
  });

  test.each(failures)('falls back on cold $name and retries', async ({ failure }) => {
    failNextRead(failure);

    await expect(getModels()).resolves.toBe(recommendedModels);
    expect(recommended.flags).toEqual(['vision']);
    expectProviderReads('codestral');

    mockLimit.mockResolvedValueOnce([{ models: [model('recovered')] }]);
    const recovered = await getModels();
    expect(recovered).toStrictEqual([
      { ...recommended, flags: ['vision', 'recommended'], variants: undefined },
      { ...model('recovered'), flags: undefined, variants: undefined },
    ]);
    await expect(getModels()).resolves.toBe(recovered);
    expectProviderReads('codestral', 'codestral');
  });

  test.each(failures)('retains last-good on warm $name and retries', async ({ failure }) => {
    mockLimit.mockResolvedValueOnce([{ models: [model('last-good')] }]);
    const lastGood = await getModels();
    expect(lastGood.map(entry => entry.id)).toEqual(['recommended', 'last-good']);

    now += ttl - 1;
    await expect(getModels()).resolves.toBe(lastGood);
    expectProviderReads('codestral');

    now += 1;
    failNextRead(failure);
    await expect(getModels()).resolves.toBe(lastGood);
    expectProviderReads('codestral', 'codestral');

    mockLimit.mockResolvedValueOnce([{ models: [model('recovered')] }]);
    const recovered = await getModels();
    expect(recovered.map(entry => entry.id)).toEqual(['recommended', 'recovered']);
    expect(recovered).not.toBe(lastGood);
    expectProviderReads('codestral', 'codestral', 'codestral');

    now += ttl - 1;
    await expect(getModels()).resolves.toBe(recovered);
    expectProviderReads('codestral', 'codestral', 'codestral');
    now += 1;
    mockLimit.mockResolvedValueOnce([{ models: [model('refreshed')] }]);
    expect((await getModels()).map(entry => entry.id)).toEqual(['recommended', 'refreshed']);
    expectProviderReads('codestral', 'codestral', 'codestral', 'codestral');
  });

  test('isolates provider predicates, cached models, expiry and stale fallback', async () => {
    const kimiRecommendation = model('recommended', { name: 'Kimi recommendation' });
    const getKimi = cachedEnhancedDirectByokModelList({
      providerId: 'kimi-coding',
      recommendedModels: [kimiRecommendation],
    });
    mockLimit.mockResolvedValueOnce([{ models: [model('shared', { name: 'Codestral model' })] }]);
    const codestral = await getModels();
    expect(codestral.map(entry => entry.name)).toEqual(['recommended', 'Codestral model']);

    now += 100;
    mockLimit.mockResolvedValueOnce([{ models: [model('shared', { name: 'Kimi model' })] }]);
    const kimi = await getKimi();
    expect(kimi.map(entry => entry.name)).toEqual(['Kimi recommendation', 'Kimi model']);
    await expect(getModels()).resolves.toBe(codestral);
    expectProviderReads('codestral', 'kimi-coding');

    now += ttl - 100;
    mockLimit.mockRejectedValueOnce(new Error('codestral read failed'));
    await expect(getModels()).resolves.toBe(codestral);
    await expect(getKimi()).resolves.toBe(kimi);
    expectProviderReads('codestral', 'kimi-coding', 'codestral');

    mockLimit.mockResolvedValueOnce([{ models: [model('recovered')] }]);
    expect((await getModels()).map(entry => entry.id)).toEqual(['recommended', 'recovered']);
    await expect(getKimi()).resolves.toBe(kimi);
    expectProviderReads('codestral', 'kimi-coding', 'codestral', 'codestral');
  });
});
