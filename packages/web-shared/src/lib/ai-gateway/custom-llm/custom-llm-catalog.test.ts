import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import {
  findCustomLlm,
  getPublicCustomLlmInferenceProviders,
  invalidateCustomLlmCache,
  isFreeModelIncludingCustomLlms,
  lookupCustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
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
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('Acme/Public-Model');
    await deleteCustomLlmForTest(freeExclusiveId);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    invalidateCustomLlmCache();
  });

  test('fails closed only for Kilo-exclusive ids while the catalog cannot be read', async () => {
    invalidateCustomLlmCache();
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

  test('does not cache rows from a load that started before an invalidation', async () => {
    invalidateCustomLlmCache();
    let releaseStaleLoad: (rows: never[]) => void = () => {};
    const staleRows = new Promise<never[]>(resolve => {
      releaseStaleLoad = resolve;
    });
    jest.spyOn(readDb, 'select').mockImplementationOnce(() => ({ from: () => staleRows }) as never);

    const staleLookup = findCustomLlm('acme/public-model');
    invalidateCustomLlmCache();
    await expect(findCustomLlm('acme/public-model')).resolves.not.toBeNull();
    releaseStaleLoad([]);
    await expect(staleLookup).resolves.toBeNull();

    await expect(findCustomLlm('acme/public-model')).resolves.not.toBeNull();
  });

  test('finds custom LLMs case-insensitively', async () => {
    await expect(findCustomLlm('acme/public-model')).resolves.toMatchObject({
      public_id: 'Acme/Public-Model',
    });
    await expect(findCustomLlm('acme/unknown')).resolves.toBeNull();
  });

  test('treats public custom LLMs as free and lets custom LLMs override built-in free models', async () => {
    await expect(isFreeModelIncludingCustomLlms('acme/public-model')).resolves.toBe(true);
    await expect(isFreeModelIncludingCustomLlms(freeExclusiveId)).resolves.toBe(false);
    await expect(isFreeModelIncludingCustomLlms('openrouter/free')).resolves.toBe(true);
    await expect(isFreeModelIncludingCustomLlms('openai/gpt-4o')).resolves.toBe(false);
  });

  test('returns inference providers only for public custom LLMs', async () => {
    await expect(getPublicCustomLlmInferenceProviders('acme/public-model')).resolves.toEqual(
      new Set(['acme'])
    );
    await expect(getPublicCustomLlmInferenceProviders(freeExclusiveId)).resolves.toBeNull();
    await expect(getPublicCustomLlmInferenceProviders('openai/gpt-4o')).resolves.toBeNull();
  });
});
