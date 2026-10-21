import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { custom_llm2 } from '@kilocode/db/schema';
import {
  findCustomLlm,
  getCustomLlmInferenceProviders,
  isCustomLlm,
  lookupCustomLlm,
  requireCustomLlmsById,
  resetCustomLlmCacheForTest,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const exclusiveId =
  kiloExclusiveModels.find(model => !/[:~]/.test(model.public_id))?.public_id ?? '';
const unclaimableExclusiveId =
  kiloExclusiveModels.find(model => model.public_id.includes(':'))?.public_id ?? '';

describe('custom LLM catalog', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('Acme/Public-Model', publicCustomLlmDefinition(['acme']));
    await insertCustomLlmForTest('acme/private-model');
    await insertCustomLlmForTest(exclusiveId);
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('Acme/Public-Model');
    await deleteCustomLlmForTest('acme/private-model');
    await deleteCustomLlmForTest(exclusiveId);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetCustomLlmCacheForTest();
  });

  test('finds custom LLMs by id regardless of case', async () => {
    await expect(findCustomLlm('acme/public-model')).resolves.toMatchObject({
      public_id: 'Acme/Public-Model',
    });
    await expect(isCustomLlm('ACME/PRIVATE-MODEL')).resolves.toBe(true);
    await expect(isCustomLlm('kilo-internal/unknown')).resolves.toBe(false);
  });

  test('picks up new rows only after the cache expires', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await expect(isCustomLlm('acme/late-model')).resolves.toBe(false);
    await db
      .insert(custom_llm2)
      .values({ public_id: 'acme/late-model', definition: customLlmDefinition() });
    try {
      clock.mockReturnValue(now + 59_999);
      await expect(isCustomLlm('acme/late-model')).resolves.toBe(false);

      clock.mockReturnValue(now + 60_000);
      await expect(isCustomLlm('acme/late-model')).resolves.toBe(true);
    } finally {
      await deleteCustomLlmForTest('acme/late-model');
    }
  });

  test('fails closed only for Kilo-exclusive ids while the catalog cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const select = jest.spyOn(readDb, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(lookupCustomLlm(exclusiveId)).resolves.toEqual({ kind: 'unknown' });
    await expect(lookupCustomLlm(unclaimableExclusiveId)).resolves.toEqual({ kind: 'none' });
    await expect(lookupCustomLlm('acme/public-model')).resolves.toEqual({ kind: 'none' });
    await expect(getCustomLlmInferenceProviders(exclusiveId)).resolves.toEqual(new Set());
    await expect(findCustomLlm(exclusiveId)).resolves.toBeNull();
    await expect(requireCustomLlmsById()).rejects.toThrow('custom LLM catalog could not be read');
    expect(select).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + 5_000);
    await expect(lookupCustomLlm('acme/public-model')).resolves.toMatchObject({
      kind: 'custom-llm',
      customLlm: { public_id: 'Acme/Public-Model' },
    });
    expect(select).toHaveBeenCalledTimes(2);
  });

  test('treats every custom LLM as free', async () => {
    await expect(isFreeModel('acme/public-model')).resolves.toBe(true);
    await expect(isFreeModel('acme/private-model')).resolves.toBe(true);
    await expect(isFreeModel(exclusiveId)).resolves.toBe(true);
  });

  test('pins public custom LLMs to their providers and private ones to none', async () => {
    await expect(getCustomLlmInferenceProviders('acme/public-model')).resolves.toEqual(
      new Set(['acme'])
    );
    await expect(getCustomLlmInferenceProviders('acme/private-model')).resolves.toEqual(new Set());
    await expect(getCustomLlmInferenceProviders(exclusiveId)).resolves.toEqual(new Set());
    await expect(getCustomLlmInferenceProviders('openai/gpt-4o')).resolves.toBeNull();
  });
});
