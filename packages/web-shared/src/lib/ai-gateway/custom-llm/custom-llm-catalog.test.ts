import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import {
  findCustomLlm,
  getPublicCustomLlmInferenceProviders,
  lookupCustomLlm,
  resetCustomLlmCacheForTest,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { custom_llm2 } from '@kilocode/db/schema';
import {
  isKiloExclusiveFreeModel,
  kiloExclusiveModels,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  privateCustomLlmDefinition,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const freeExclusiveId =
  kiloExclusiveModels.find(model => isKiloExclusiveFreeModel(model.public_id))?.public_id ?? '';

describe('custom LLM catalog', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('Acme/Public-Model', publicCustomLlmDefinition(['acme']));
    await insertCustomLlmForTest(freeExclusiveId, privateCustomLlmDefinition());
    await insertCustomLlmForTest('acme/private-model', privateCustomLlmDefinition());
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('Acme/Public-Model');
    await deleteCustomLlmForTest(freeExclusiveId);
    await deleteCustomLlmForTest('acme/private-model');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetCustomLlmCacheForTest();
  });

  test('fails closed only for Kilo-exclusive ids while the catalog cannot be read', async () => {
    resetCustomLlmCacheForTest();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const select = jest.spyOn(readDb, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(lookupCustomLlm(freeExclusiveId)).resolves.toEqual({ kind: 'unknown' });
    await expect(lookupCustomLlm('acme/public-model')).resolves.toEqual({ kind: 'none' });
    await expect(findCustomLlm(freeExclusiveId)).resolves.toBeNull();
    expect(select).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + 5_000);
    await expect(lookupCustomLlm('acme/public-model')).resolves.toMatchObject({
      kind: 'custom-llm',
      customLlm: { public_id: 'Acme/Public-Model' },
    });
    expect(select).toHaveBeenCalledTimes(2);
  });

  test('picks up new rows only after the cache expires', async () => {
    resetCustomLlmCacheForTest();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await expect(findCustomLlm('acme/late-model')).resolves.toBeNull();
    await db
      .insert(custom_llm2)
      .values({ public_id: 'acme/late-model', definition: privateCustomLlmDefinition() });
    try {
      clock.mockReturnValue(now + 59_999);
      await expect(findCustomLlm('acme/late-model')).resolves.toBeNull();

      clock.mockReturnValue(now + 60_000);
      await expect(findCustomLlm('acme/late-model')).resolves.not.toBeNull();
    } finally {
      await deleteCustomLlmForTest('acme/late-model');
    }
  });

  test('finds custom LLMs case-insensitively', async () => {
    await expect(findCustomLlm('acme/public-model')).resolves.toMatchObject({
      public_id: 'Acme/Public-Model',
    });
    await expect(findCustomLlm('acme/unknown')).resolves.toBeNull();
  });

  test('treats every custom LLM as free', async () => {
    await expect(isFreeModel('acme/public-model')).resolves.toBe(true);
    await expect(isFreeModel('acme/private-model')).resolves.toBe(true);
    await expect(isFreeModel(freeExclusiveId)).resolves.toBe(true);
    await expect(isFreeModel('openrouter/free')).resolves.toBe(true);
    await expect(isFreeModel('openai/gpt-4o')).resolves.toBe(false);
  });

  test('returns inference providers only for public custom LLMs', async () => {
    await expect(getPublicCustomLlmInferenceProviders('acme/public-model')).resolves.toEqual(
      new Set(['acme'])
    );
    await expect(getPublicCustomLlmInferenceProviders(freeExclusiveId)).resolves.toBeNull();
    await expect(getPublicCustomLlmInferenceProviders('openai/gpt-4o')).resolves.toBeNull();
  });
});
