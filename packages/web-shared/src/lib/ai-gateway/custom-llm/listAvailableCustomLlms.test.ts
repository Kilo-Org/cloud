import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resetCustomLlmCacheForTest } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import { convertCustomLlmToCatalogModel, listAvailableCustomLlms } from './listAvailableCustomLlms';

const ORG_ID = '00000000-0000-4000-8000-0000000000c2';

async function listedIds(countryCode: string | null = null) {
  return (await listAvailableCustomLlms(ORG_ID, [], countryCode)).map(model => model.id).sort();
}

const FREE_PRICING = {
  prompt: '0',
  completion: '0',
  request: '0',
  image: '0',
  web_search: '0',
  internal_reasoning: '0',
  input_cache_read: '0',
  input_cache_write: '0',
};

describe('convertCustomLlmToCatalogModel pricing', () => {
  test('lists a custom LLM without pricing as free', () => {
    const model = convertCustomLlmToCatalogModel('acme/free-model', customLlmDefinition());

    expect(model.isFree).toBe(true);
    expect(model.mayTrainOnYourPrompts).toBe(false);
    expect(model.pricing).toEqual(FREE_PRICING);
  });

  test('prices a custom LLM from its first pricing tier', () => {
    const pricing: CustomPricingTiers = [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 2,
          completion_per_million: 8,
          input_cache_read_per_million: 0.5,
          input_cache_write_per_million: 2.5,
        },
      },
      {
        start_context_length: 128_000,
        pricing: {
          prompt_per_million: 4,
          completion_per_million: 16,
          input_cache_read_per_million: null,
          input_cache_write_per_million: null,
        },
      },
    ];

    const model = convertCustomLlmToCatalogModel(
      'acme/priced-model',
      customLlmDefinition({ pricing })
    );

    expect(model.isFree).toBe(false);
    expect(model.mayTrainOnYourPrompts).toBe(false);
    expect(model.pricing).toEqual({
      ...FREE_PRICING,
      prompt: '0.000002000000',
      completion: '0.000008000000',
      input_cache_read: '0.000000500000',
      input_cache_write: '0.000002500000',
    });
  });

  test('leaves cache prices undefined when the first pricing tier has none', () => {
    const pricing: CustomPricingTiers = [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 1,
          completion_per_million: 3,
          input_cache_read_per_million: null,
          input_cache_write_per_million: null,
        },
      },
    ];

    const model = convertCustomLlmToCatalogModel(
      'acme/priced-model',
      customLlmDefinition({ pricing })
    );

    expect(model.isFree).toBe(false);
    expect(model.pricing.prompt).toBe('0.000001000000');
    expect(model.pricing.completion).toBe('0.000003000000');
    expect(model.pricing.input_cache_read).toBeUndefined();
    expect(model.pricing.input_cache_write).toBeUndefined();
  });

  test.each([true, false])('lists the configured prompt training policy: %s', mayTrainOnPrompts => {
    const model = convertCustomLlmToCatalogModel(
      'acme/priced-model',
      customLlmDefinition({
        may_train_on_prompts: mayTrainOnPrompts,
        pricing: [
          {
            start_context_length: 0,
            pricing: {
              prompt_per_million: 1,
              completion_per_million: 3,
              input_cache_read_per_million: null,
              input_cache_write_per_million: null,
            },
          },
        ],
      })
    );

    expect(model.mayTrainOnYourPrompts).toBe(mayTrainOnPrompts);
  });
});

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
