import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModel,
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
  test('judges custom LLM ids by the same rules as other ids', () => {
    expect(isFreeModel('acme/custom-model')).toBe(false);
    expect(isFreeModel('acme/custom-model-free')).toBe(true);
    expect(isFreeModel('stealth/custom-model')).toBe(true);
  });
});

describe('hasBestEffortGuessDataCollectionRequirement', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/custom-model');
    await insertCustomLlmForTest('acme/priced-custom-model', customLlmDefinition({ pricing }));
    await insertCustomLlmForTest(
      'acme/no-training-model',
      customLlmDefinition({ pricing, may_train_on_prompts: false })
    );
    await insertCustomLlmForTest(
      'acme/training-model',
      customLlmDefinition({ pricing, may_train_on_prompts: true })
    );
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/custom-model');
    await deleteCustomLlmForTest('acme/priced-custom-model');
    await deleteCustomLlmForTest('acme/no-training-model');
    await deleteCustomLlmForTest('acme/training-model');
  });

  test.each([
    ['acme/custom-model', true],
    ['acme/priced-custom-model', true],
    ['acme/training-model', true],
    ['acme/no-training-model', false],
    ['openrouter/free', true],
    ['openai/gpt-4o', false],
  ])('%s -> %s', async (model, expected) => {
    await expect(hasBestEffortGuessDataCollectionRequirement(model)).resolves.toBe(expected);
  });
});
