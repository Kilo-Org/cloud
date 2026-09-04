import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { ENKRYPT_REVIEWED_CASES } from '@/tests/fixtures/enkrypt-scores';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';
import { modelStats } from '@kilocode/db/schema';
import type { ModelStatsBenchmarks } from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { ENKRYPT_REQUIRED_MODEL_IDS, matchEnkryptScores } from './enkrypt-identity';
import { syncOpenRouterModels } from './sync-openrouter';

const additionalId = 'openai/gpt-5.1';
const preferredId = 'fixture/catalog-preferred';
const ordinaryId = 'fixture/catalog-existing';
const unselectedId = 'fixture/catalog-unselected';
const testModelIds = [additionalId, preferredId, ordinaryId, unselectedId];
const reviewedCase = ENKRYPT_REVIEWED_CASES.find(({ modelId }) => modelId === additionalId);
if (!reviewedCase) throw new Error('Missing synthetic reviewed fixture');
const score = reviewedCase.score;
const benchmarks: ModelStatsBenchmarks = {
  artificialAnalysis: { codingIndex: 42, liveCodeBench: 35 },
  kiloBench: { overallScore: 0.5, evals: {} },
  enkrypt: { ...score, ingestedAt: '2026-01-01T00:00:00.000Z', evaluatedAt: null },
};

function catalogModel(id = additionalId): OpenRouterModel {
  return {
    id,
    name: 'Synthetic catalog model',
    created: 0,
    description: 'Synthetic catalog description',
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      tokenizer: 'synthetic',
    },
    top_provider: {
      is_moderated: false,
      context_length: 32768,
      max_completion_tokens: 4096,
    },
    pricing: { prompt: '0.000002', completion: '0.000004' },
    context_length: 32768,
    per_request_limits: null,
  };
}

async function readModel(openrouterId = additionalId) {
  const [model] = await db
    .select()
    .from(modelStats)
    .where(eq(modelStats.openrouterId, openrouterId));
  if (!model) throw new Error('Expected catalog model');
  return model;
}

describe('syncOpenRouterModels with PostgreSQL', () => {
  let mockFetch: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
  });

  afterEach(async () => {
    expect(mockFetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await db.delete(modelStats).where(inArray(modelStats.openrouterId, testModelIds));
  });

  it('creates an additional-only row from supplied metadata, eligible for Enkrypt but not recommended', async () => {
    const model = catalogModel();
    const catalog = [model, catalogModel(unselectedId)];

    expect(await syncOpenRouterModels(catalog, [], [additionalId])).toEqual({
      newModels: [additionalId],
      updatedModels: [],
      totalProcessed: 1,
    });
    const stored = await readModel();
    expect(stored).toMatchObject({
      id: expect.any(String),
      openrouterId: additionalId,
      slug: 'openai-gpt-5-1',
      modelCreator: 'openai',
      creatorSlug: 'openai',
      name: model.name,
      description: model.description,
      priceInput: '2.000000',
      priceOutput: '4.000000',
      contextLength: 32768,
      maxOutputTokens: 4096,
      inputModalities: ['text', 'image'],
      isActive: true,
      isStealth: false,
      isRecommended: false,
      isFeatured: false,
      benchmarks: null,
      aaSlug: null,
      codingIndex: null,
      speedTokensPerSec: null,
      chartData: null,
      openrouterData: model,
    });
    const eligible = await db
      .select()
      .from(modelStats)
      .where(
        and(
          eq(modelStats.id, stored.id),
          eq(modelStats.isActive, true),
          eq(modelStats.isStealth, false)
        )
      );
    expect(eligible).toHaveLength(1);
    expect(matchEnkryptScores([score], eligible)).toMatchObject({
      matches: [{ model: stored, score }],
      ambiguousCount: 0,
      unmatchedRecords: [],
      missingRequiredModelIds: [...ENKRYPT_REQUIRED_MODEL_IDS],
    });
    expect(
      await db.select().from(modelStats).where(eq(modelStats.openrouterId, unselectedId))
    ).toEqual([]);

    expect(await syncOpenRouterModels(catalog, [], [additionalId])).toEqual({
      newModels: [],
      updatedModels: [additionalId],
      totalProcessed: 1,
    });
    const repeated = await db
      .select()
      .from(modelStats)
      .where(eq(modelStats.openrouterId, additionalId));
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({
      id: stored.id,
      isActive: true,
      isStealth: false,
      isRecommended: false,
      benchmarks: null,
    });
  });

  it('deduplicates additional targets and repeated supplied catalog records on both runs', async () => {
    const model = catalogModel();
    const catalog = [model, model];
    const additionalIds = [additionalId, additionalId];

    expect(await syncOpenRouterModels(catalog, [], additionalIds)).toEqual({
      newModels: [additionalId],
      updatedModels: [],
      totalProcessed: 1,
    });
    expect(await syncOpenRouterModels(catalog, [], additionalIds)).toEqual({
      newModels: [],
      updatedModels: [additionalId],
      totalProcessed: 1,
    });
    expect((await readModel()).isRecommended).toBe(false);
  });

  it.each([false, true])(
    'processes an overlapping preferred target once (existing: %s)',
    async existing => {
      if (existing) {
        const model = await insertTestModelStats({
          openrouterId: additionalId,
          isActive: false,
          benchmarks,
        });
        await db
          .update(modelStats)
          .set({ isStealth: true, isRecommended: false })
          .where(eq(modelStats.id, model.id));
      }
      const model = catalogModel();
      const result = await syncOpenRouterModels(
        [model, model],
        [additionalId, additionalId],
        [additionalId, additionalId]
      );

      expect(result).toEqual({
        newModels: existing ? [] : [additionalId],
        updatedModels: existing ? [additionalId] : [],
        totalProcessed: 1,
      });
      expect(await readModel()).toMatchObject({
        isActive: true,
        isStealth: existing,
        isRecommended: true,
        benchmarks: existing ? benchmarks : null,
        openrouterData: model,
      });
    }
  );

  it('clears recommendation after preferred removal and keeps it cleared when additional enrollment is disabled', async () => {
    const existing = await insertTestModelStats({
      openrouterId: additionalId,
      isActive: false,
      benchmarks,
    });
    await db
      .update(modelStats)
      .set({ isStealth: true, isRecommended: false })
      .where(eq(modelStats.id, existing.id));
    const model = catalogModel();
    const expectedResult = {
      newModels: [],
      updatedModels: [additionalId],
      totalProcessed: 1,
    };

    expect(await syncOpenRouterModels([model], [additionalId], [additionalId])).toEqual(
      expectedResult
    );
    expect(await readModel()).toMatchObject({
      id: existing.id,
      isActive: true,
      isStealth: true,
      isRecommended: true,
      benchmarks,
    });

    await db.update(modelStats).set({ isActive: false }).where(eq(modelStats.id, existing.id));
    const updated = { ...model, name: 'Removed from preferred' };
    expect(await syncOpenRouterModels([updated], [], [additionalId])).toEqual(expectedResult);
    expect(await readModel()).toMatchObject({
      id: existing.id,
      isActive: false,
      isStealth: true,
      isRecommended: false,
      benchmarks,
      openrouterData: updated,
    });

    const disabled = { ...updated, name: 'Additional enrollment disabled' };
    expect(await syncOpenRouterModels([disabled], [])).toEqual(expectedResult);
    expect(await readModel()).toMatchObject({
      id: existing.id,
      isActive: false,
      isStealth: true,
      isRecommended: false,
      benchmarks,
      openrouterData: disabled,
    });
  });

  it('waits for remaining catalog writes before reporting a partial failure', async () => {
    await insertTestModelStats({ openrouterId: preferredId });
    await insertTestModelStats({ openrouterId: ordinaryId });
    const events: string[] = [];
    const error = new Error('Synthetic write failure');
    const pendingStarted = Promise.withResolvers<void>();
    const pendingWrite = Promise.withResolvers<void>();
    const write = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(async () => {
        pendingStarted.resolve();
        await pendingWrite.promise;
        events.push('write');
      });
    jest.spyOn(db, 'update').mockReturnValue({
      set: () => ({ where: write }),
    } as unknown as ReturnType<typeof db.update>);

    const completed = syncOpenRouterModels(
      [catalogModel(preferredId), catalogModel(ordinaryId)],
      [preferredId, ordinaryId]
    ).catch(cause => {
      events.push('failed');
      return cause;
    });
    await pendingStarted.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(write).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);

    pendingWrite.resolve();
    expect(await completed).toBe(error);
    expect(events).toEqual(['write', 'failed']);
  });

  it('never inserts an additional target without actual supplied catalog metadata', async () => {
    expect(await syncOpenRouterModels([catalogModel(unselectedId)], [], [additionalId])).toEqual({
      newModels: [],
      updatedModels: [],
      totalProcessed: 0,
    });
    expect(
      await db.select().from(modelStats).where(inArray(modelStats.openrouterId, testModelIds))
    ).toEqual([]);
  });

  it.each([
    { isActive: false, isStealth: true, isRecommended: true },
    { isActive: false, isStealth: false, isRecommended: false },
    { isActive: true, isStealth: true, isRecommended: false },
    { isActive: true, isStealth: false, isRecommended: true },
    { isActive: null, isStealth: false, isRecommended: true },
  ])('preserves additional-only operator flags %p but clears recommendation', async flags => {
    const existing = await insertTestModelStats({
      openrouterId: additionalId,
      isActive: flags.isActive,
      name: 'Old synthetic name',
      benchmarks,
      aaSlug: 'synthetic-aa-slug',
      codingIndex: '42.00',
      speedTokensPerSec: '25.00',
    });
    await db.update(modelStats).set(flags).where(eq(modelStats.id, existing.id));
    const model = catalogModel();
    const updated = { ...model, name: 'Updated synthetic name', context_length: 65536 };

    for (const supplied of [model, updated]) {
      expect(await syncOpenRouterModels([supplied], [], [additionalId])).toEqual({
        newModels: [],
        updatedModels: [additionalId],
        totalProcessed: 1,
      });
      const stored = await readModel();
      expect(stored.benchmarks).toStrictEqual(benchmarks);
      expect(stored.openrouterData).toStrictEqual(supplied);
      expect(stored).toMatchObject({
        id: existing.id,
        ...flags,
        isRecommended: false,
        name: supplied.name,
        description: supplied.description,
        slug: 'openai-gpt-5-1',
        modelCreator: 'openai',
        creatorSlug: 'openai',
        priceInput: '2.000000',
        priceOutput: '4.000000',
        contextLength: supplied.context_length,
        maxOutputTokens: 4096,
        inputModalities: ['text', 'image'],
        aaSlug: existing.aaSlug,
        codingIndex: existing.codingIndex,
        speedTokensPerSec: existing.speedTokensPerSec,
        benchmarks,
        openrouterData: supplied,
      });
    }
  });

  it('leaves unavailable existing additional rows entirely unchanged', async () => {
    const existing = await insertTestModelStats({ openrouterId: additionalId, benchmarks });
    await db
      .update(modelStats)
      .set({ isActive: false, isStealth: true, isRecommended: true })
      .where(eq(modelStats.id, existing.id));
    const before = await readModel();

    expect(await syncOpenRouterModels([], [], [additionalId])).toEqual({
      newModels: [],
      updatedModels: [],
      totalProcessed: 0,
    });
    expect(await readModel()).toStrictEqual(before);
  });

  it.each([false, true])(
    'preserves prior preferred and unrelated model behavior (additional enrollment: %s)',
    async enroll => {
      const preferred = await insertTestModelStats({
        openrouterId: preferredId,
        isActive: false,
        benchmarks,
      });
      const ordinary = await insertTestModelStats({
        openrouterId: ordinaryId,
        isActive: false,
        benchmarks,
      });
      await db
        .update(modelStats)
        .set({ isStealth: true, isRecommended: true })
        .where(inArray(modelStats.id, [preferred.id, ordinary.id]));
      const catalog = [catalogModel(preferredId), catalogModel(ordinaryId), catalogModel()];
      const result = enroll
        ? await syncOpenRouterModels(catalog, [preferredId], [additionalId])
        : await syncOpenRouterModels(catalog, [preferredId]);

      expect(result).toEqual({
        newModels: enroll ? [additionalId] : [],
        updatedModels: [preferredId, ordinaryId],
        totalProcessed: enroll ? 3 : 2,
      });
      expect(await readModel(preferredId)).toMatchObject({
        id: preferred.id,
        isActive: true,
        isStealth: true,
        isRecommended: true,
        benchmarks,
        openrouterData: catalog[0],
      });
      expect(await readModel(ordinaryId)).toMatchObject({
        id: ordinary.id,
        isActive: false,
        isStealth: true,
        isRecommended: false,
        benchmarks,
        openrouterData: catalog[1],
      });
      expect(
        await db.select().from(modelStats).where(eq(modelStats.openrouterId, additionalId))
      ).toHaveLength(enroll ? 1 : 0);
    }
  );
});
