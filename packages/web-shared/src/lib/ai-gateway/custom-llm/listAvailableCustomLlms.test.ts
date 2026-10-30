import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resetCustomLlmCacheForTest } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import { listAvailableCustomLlms } from './listAvailableCustomLlms';

const ORG_ID = '00000000-0000-4000-8000-0000000000c2';

async function listedIds(countryCode: string | null = null) {
  return (await listAvailableCustomLlms(ORG_ID, [], countryCode)).map(model => model.id).sort();
}

describe('listAvailableCustomLlms catalog cache', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest(
      'acme/listed-private',
      customLlmDefinition({ organization_ids: [ORG_ID] })
    );
    await insertCustomLlmForTest('acme/unlisted-public', publicCustomLlmDefinition(['acme']));
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/listed-private');
    await deleteCustomLlmForTest('acme/unlisted-public');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetCustomLlmCacheForTest();
  });

  test('reads the custom LLM table once while the catalog is fresh', async () => {
    const select = jest.spyOn(readDb, 'select');

    await expect(listedIds()).resolves.toEqual(['acme/listed-private']);
    await expect(listedIds()).resolves.toEqual(['acme/listed-private']);

    expect(select).toHaveBeenCalledTimes(1);
  });

  test('serves the previous list when a catalog refresh fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await expect(listedIds()).resolves.toEqual(['acme/listed-private']);

    const select = jest.spyOn(readDb, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    clock.mockReturnValue(now + 60_000);

    await expect(listedIds()).resolves.toEqual(['acme/listed-private']);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
