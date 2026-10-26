import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { custom_llm2 } from '@kilocode/db/schema';
import {
  findCustomLlm,
  getPublicCustomLlmInferenceProviders,
  isCustomLlm,
  requireCustomLlmsById,
  resetCustomLlmCacheForTest,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

describe('custom LLM catalog', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('Acme/Public-Model', publicCustomLlmDefinition(['acme']));
    await insertCustomLlmForTest('acme/private-model');
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('Acme/Public-Model');
    await deleteCustomLlmForTest('acme/private-model');
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

  test('waits before retrying after a failed read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const select = jest.spyOn(readDb, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(isCustomLlm('acme/public-model')).resolves.toBe(false);
    await expect(requireCustomLlmsById()).rejects.toThrow('custom LLM catalog could not be read');
    expect(select).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + 5_000);
    await expect(isCustomLlm('acme/public-model')).resolves.toBe(true);
    expect(select).toHaveBeenCalledTimes(2);
  });

  test('treats every custom LLM as free', async () => {
    await expect(isFreeModel('acme/public-model')).resolves.toBe(true);
    await expect(isFreeModel('acme/private-model')).resolves.toBe(true);
  });

  test('pins only public custom LLMs to their declared providers', async () => {
    await expect(getPublicCustomLlmInferenceProviders('acme/public-model')).resolves.toEqual(
      new Set(['acme'])
    );
    await expect(getPublicCustomLlmInferenceProviders('acme/private-model')).resolves.toBeNull();
    await expect(getPublicCustomLlmInferenceProviders('openai/gpt-4o')).resolves.toBeNull();
  });
});
