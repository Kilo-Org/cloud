import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { custom_llm2 } from '@kilocode/db/schema';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { captureException } from '@sentry/nextjs';
import {
  findCustomLlm,
  getPublicCustomLlmInferenceProviders,
  isCustomLlm,
  requireCustomLlmsById,
  resetCustomLlmCacheForTest,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const mockedCaptureException = jest.mocked(captureException);

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

  test('pins only public custom LLMs to their declared providers', async () => {
    await expect(getPublicCustomLlmInferenceProviders('acme/public-model')).resolves.toEqual(
      new Set(['acme'])
    );
    await expect(getPublicCustomLlmInferenceProviders('acme/private-model')).resolves.toBeNull();
    await expect(getPublicCustomLlmInferenceProviders('openai/gpt-4o')).resolves.toBeNull();
  });

  test('reports a malformed row as an error and keeps serving the valid rows', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedCaptureException.mockClear();
    await insertCustomLlmForTest('acme/malformed-model', {
      internal_id: 'upstream-model',
    } as unknown as CustomLlmDefinition);
    try {
      await expect(isCustomLlm('acme/public-model')).resolves.toBe(true);
      await expect(findCustomLlm('acme/malformed-model')).resolves.toBeNull();
      expect(errorLog).toHaveBeenCalledWith(
        'Failed to parse custom llm definition',
        'acme/malformed-model',
        expect.anything()
      );
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
      expect(mockedCaptureException).toHaveBeenCalledWith(expect.anything(), {
        tags: { source: 'custom_llm_catalog' },
        extra: { public_id: 'acme/malformed-model' },
      });

      // The catalog refreshes every minute, so the same row parses again and logs
      // again; Sentry receives it once for the row until the report window passes.
      resetCustomLlmCacheForTest();
      await expect(findCustomLlm('acme/malformed-model')).resolves.toBeNull();
      expect(errorLog).toHaveBeenCalledTimes(2);
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    } finally {
      await deleteCustomLlmForTest('acme/malformed-model');
    }
  });
});
