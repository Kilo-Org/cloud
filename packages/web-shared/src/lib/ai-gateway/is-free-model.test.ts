import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModel,
  isFreeModelExcludingCustomLlms,
} from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const pricing: CustomPricingTiers = [
  {
    start_context_length: 0,
    pricing: {
      prompt_per_million: 2,
      completion_per_million: 8,
      input_cache_read_per_million: null,
      input_cache_write_per_million: null,
    },
  },
];

describe('isFreeModel', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/custom-model');
    await insertCustomLlmForTest('acme/priced-custom-model', customLlmDefinition({ pricing }));
    await insertCustomLlmForTest(
      'acme/training-custom-model',
      customLlmDefinition({ pricing, may_train_on_prompts: true })
    );
    await insertCustomLlmForTest(
      'acme/non-training-custom-model',
      customLlmDefinition({ pricing, may_train_on_prompts: false })
    );
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/custom-model');
    await deleteCustomLlmForTest('acme/priced-custom-model');
    await deleteCustomLlmForTest('acme/training-custom-model');
    await deleteCustomLlmForTest('acme/non-training-custom-model');
  });

  test('treats a custom LLM without pricing as free', async () => {
    await expect(isFreeModel('acme/custom-model')).resolves.toBe(true);
    expect(isFreeModelExcludingCustomLlms('acme/custom-model')).toBe(false);
  });

  test('treats a custom LLM with pricing as not free', async () => {
    await expect(isFreeModel('acme/priced-custom-model')).resolves.toBe(false);
    expect(isFreeModelExcludingCustomLlms('acme/priced-custom-model')).toBe(false);
  });

  test('assumes unpriced custom LLMs require data collection', async () => {
    await expect(hasBestEffortGuessDataCollectionRequirement('acme/custom-model')).resolves.toBe(
      true
    );
    await expect(hasBestEffortGuessDataCollectionRequirement('openai/gpt-4o')).resolves.toBe(false);
  });

  test('defaults priced custom LLMs to not requiring data collection', async () => {
    await expect(
      hasBestEffortGuessDataCollectionRequirement('acme/priced-custom-model')
    ).resolves.toBe(false);
  });

  test.each([
    ['acme/training-custom-model', true],
    ['acme/non-training-custom-model', false],
  ] as const)('uses the configured data collection policy for %s', async (model, expected) => {
    await expect(hasBestEffortGuessDataCollectionRequirement(model)).resolves.toBe(expected);
  });

  test('follows the built-in rules for other models', async () => {
    await expect(isFreeModel('openrouter/free')).resolves.toBe(true);
    await expect(isFreeModel('openai/gpt-4o')).resolves.toBe(false);
    await expect(hasBestEffortGuessDataCollectionRequirement('openrouter/free')).resolves.toBe(
      true
    );
  });
});
